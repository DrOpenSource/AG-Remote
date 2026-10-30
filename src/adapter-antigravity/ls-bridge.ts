/**
 * Language-server bridge for Antigravity IDE.
 *
 * Talks to the IDE's local language server over Connect/JSON on 127.0.0.1, the same
 * channel the agent panel uses. Verified 2026-10-22 (NOTES.md §13):
 *  - live agent state is held by the language server WITHOUT a --workspace_id;
 *  - auth header x-codeium-csrf-token = that process's --csrf_token;
 *  - a pending approval is a step with status WAITING and a requestedInteraction.
 *
 * The CSRF token is read from the process command line at runtime and kept in memory
 * only. It is never logged, persisted, or sent anywhere except 127.0.0.1.
 */
import http from 'http';
import https from 'https';
import { execFile } from 'child_process';
import type { PromptImage } from '../core/types.ts';

export interface LsServer {
  pid: number;
  /** --workspace_id: older builds' per-project copies, whose state is stale. Never used for live calls. */
  workspaceId: string | null;
  token: string;
  ports: number[];
  ppid?: number;
  /** language_server_* (builds up to Oct 2026) or agy (one per window, from late Oct 2026) */
  kind?: 'language_server' | 'agy';
  /** --parent_pipe_path: attached to a running IDE */
  attached?: boolean;
  /** --add-dir: the window's folder(s) an agy server works in, normalized */
  addDirs?: string[];
  /** --app_data_dir: which ~/.gemini/<dir> holds its chat history */
  appDataDir?: string;
}

export type Discover = () => Promise<LsServer[]>;

export interface LiveInteraction {
  cascadeId: string;
  trajectoryId: string;
  stepIndex: number;
  /** key present in requestedInteraction, e.g. "permission", "runCommand", "filePermission" */
  kind: string;
  stepType: string;
  actionDescription?: string;
  commandLine?: string;
  cwd?: string;
  target?: string;
  absolutePathUri?: string;
}

export type Decision =
  | { allow: true; scope: 'once' | 'conversation' }
  | { allow: false; instruction?: string };

const SERVICE = '/exa.language_server_pb.LanguageServerService/';
const SCOPE_ONCE = 1;
const SCOPE_CONVERSATION = 2;
const CONFIRM_ONLY_KINDS = new Set([
  'openBrowserUrl', 'captureBrowserScreenshot', 'executeBrowserJavascript', 'mcp', 'readUrlContent'
]);

export class LsBridgeError extends Error {
  /** Set when the server refused a prompt that carried images; nothing was added to the chat. */
  imagesRejected = false;
}

/** Builds the HandleCascadeUserInteraction "interaction" payload. Pure; exported for tests. */
export function buildInteraction(p: LiveInteraction, d: Decision): Record<string, unknown> {
  const base = { trajectoryId: p.trajectoryId, stepIndex: p.stepIndex };
  if (p.kind === 'permission') {
    return {
      ...base,
      permission: d.allow
        ? { allow: true, scope: d.scope === 'conversation' ? SCOPE_CONVERSATION : SCOPE_ONCE }
        : { allow: false, scope: SCOPE_ONCE, ...(d.instruction ? { userDenyInstruction: d.instruction } : {}) }
    };
  }
  if (p.kind === 'runCommand') {
    const cmd = p.commandLine || '';
    return { ...base, runCommand: { confirm: d.allow, proposedCommandLine: cmd, submittedCommandLine: cmd } };
  }
  if (p.kind === 'filePermission') {
    if (!p.absolutePathUri) throw new LsBridgeError('File permission request is missing its path; refusing to answer');
    const scope = d.allow && d.scope === 'conversation' ? SCOPE_CONVERSATION : SCOPE_ONCE;
    return { ...base, filePermission: { allow: d.allow, scope, absolutePathUri: p.absolutePathUri } };
  }
  if (CONFIRM_ONLY_KINDS.has(p.kind)) {
    return { ...base, [p.kind]: { confirm: d.allow } };
  }
  throw new LsBridgeError(`Unsupported interaction kind "${p.kind}"; answer it in the IDE`);
}

export interface Conversation {
  cascadeId: string;
  title: string;
  /** Lower-case, forward-slash folder paths the conversation belongs to (from the IDE's own record). */
  workspaces: string[];
  /** ms since epoch of the last user input (falls back to last modification). */
  lastActivity: number;
}

/** "file:///c%3A/Users/x/Proj" -> "c:/users/x/proj". Pure; exported for tests. */
export function normalizeWorkspace(uriOrPath: string): string {
  let p = String(uriOrPath || '');
  if (p.startsWith('file://')) {
    p = p.slice('file://'.length);
    try { p = decodeURIComponent(p); } catch (_) {}
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  }
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function toMs(ts: any): number {
  if (!ts) return 0;
  if (typeof ts === 'string') return Date.parse(ts) || 0;
  if (typeof ts === 'object' && ts.seconds !== undefined) return Number(ts.seconds) * 1000 + Math.floor(Number(ts.nanos || 0) / 1e6);
  return 0;
}

/**
 * Parses GetAllCascadeTrajectories. The agent panel reads summaries keyed by cascade id, each with
 * `summary`, `workspaces[].workspaceFolderAbsoluteUri` or `trajectoryMetadata.workspaceUris`, and
 * `lastUserInputTime` / `lastModifiedTime`. Pure; exported for tests.
 */
export function parseConversations(res: any): Conversation[] {
  const map = res?.trajectorySummaries || res?.summaries || {};
  return Object.entries(map).map(([cascadeId, s]: [string, any]) => {
    const metaUris: string[] = s?.trajectoryMetadata?.workspaceUris || [];
    const uris = metaUris.length > 0
      ? metaUris
      : (s?.workspaces || []).map((w: any) => w?.workspaceFolderAbsoluteUri).filter(Boolean);
    return {
      cascadeId,
      title: String(s?.summary || '').trim() || `Conversation ${cascadeId.slice(0, 8)}`,
      workspaces: uris.map(normalizeWorkspace),
      lastActivity: toMs(s?.lastUserInputTime) || toMs(s?.lastModifiedTime)
    };
  }).sort((a, b) => b.lastActivity - a.lastActivity);
}

/** Extracts the newest step that is waiting on the user. Pure; exported for tests. */
export function extractPending(cascadeId: string, trajectory: any): LiveInteraction | null {
  const steps: any[] = trajectory?.steps || [];
  const trajectoryId: string | undefined = trajectory?.trajectoryId;
  if (!trajectoryId) return null;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    const status = String(s?.status || '');
    if (!/WAITING/.test(status) || !s.requestedInteraction) continue;
    const kind = Object.keys(s.requestedInteraction)[0];
    if (!kind) continue;
    const req = s.requestedInteraction[kind] || {};
    return {
      cascadeId,
      trajectoryId,
      stepIndex: i,
      kind,
      stepType: String(s.type || '').replace('CORTEX_STEP_TYPE_', ''),
      actionDescription: req.actionDescription,
      commandLine: s.runCommand?.commandLine ?? s.runCommand?.proposedCommandLine,
      cwd: s.runCommand?.cwd,
      target: req.resource?.target,
      absolutePathUri: req.absolutePathUri
    };
  }
  return null;
}

export type ParsedServer = Omit<LsServer, 'pid' | 'ports' | 'ppid'>;

/** All values of a --flag (as `--flag value` or `--flag=value`, optionally quoted); never matches --other_flag. */
function flagValues(cmd: string, flag: string): string[] {
  const re = new RegExp(`(?:^|\\s)--${flag}(?:=|\\s+)(?:"([^"]*)"|([^\\s"]+))`, 'g');
  return [...cmd.matchAll(re)].map(m => m[1] ?? m[2]).filter(v => v && !v.startsWith('--'));
}

/**
 * Recognises the agent server in a process command line, on any OS. Antigravity has shipped two:
 *  - language_server_<os>_<arch>: one shared server with no --workspace_id (live state), plus stale
 *    per-project copies that have one;
 *  - agy (from late Oct 2026): one server per IDE window, its folder in --add-dir.
 * The executable is what comes before the first ` --` flag; its path may contain spaces
 * ("/Applications/Antigravity IDE.app/..."). Returns null for anything else. Pure; exported for tests.
 */
export function parseServerCommandLine(cmd: string): ParsedServer | null {
  const exe = cmd.split(/\s--/)[0].trim().replace(/^"|"$/g, '');
  const base = (exe.split(/[\\/]/).pop() || '').toLowerCase().replace(/\.exe$/, '');
  const kind = base.startsWith('language_server') ? 'language_server' : base === 'agy' ? 'agy' : null;
  if (!kind) return null;
  const token = flagValues(cmd, 'csrf_token')[0] || '';
  if (!token) return null;
  return {
    kind,
    token,
    workspaceId: flagValues(cmd, 'workspace_id')[0] || null,
    attached: /(?:^|\s)--parent_pipe_path[= ]/.test(cmd),
    addDirs: flagValues(cmd, 'add-dir').map(normalizeWorkspace),
    appDataDir: flagValues(cmd, 'app_data_dir')[0]
  };
}

/** Agent-server processes from `ps -axww -o pid=,ppid=,command=` output. Pure; exported for tests. */
export function parsePsOutput(raw: string): Array<ParsedServer & { pid: number; ppid: number }> {
  const out: Array<ParsedServer & { pid: number; ppid: number }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    const parsed = m && parseServerCommandLine(m[3]);
    if (parsed) out.push({ pid: Number(m![1]), ppid: Number(m![2]), ...parsed });
  }
  return out;
}

/**
 * Order live-call candidates so the right server is tried first:
 *  1. agy for this window's folder (each window has its own; another window's would act on the wrong chat);
 *  2. attached to a running IDE (--parent_pipe_path; a Mac was seen with a leftover server next to the live one);
 *  3. not orphaned (re-parented to launchd/init, ppid 1).
 * Stable otherwise. Pure; exported for tests.
 */
export function rankLanguageServers<T extends Pick<LsServer, 'ppid' | 'attached' | 'addDirs'>>(procs: T[], workspace?: string): T[] {
  const ws = workspace ? normalizeWorkspace(workspace) : '';
  const score = (p: T) => (ws && p.addDirs?.includes(ws) ? 4 : 0) + (p.attached ? 2 : 0) + (p.ppid === 1 ? -1 : 0);
  return procs.map((p, i) => ({ p, i })).sort((a, b) => score(b.p) - score(a.p) || a.i - b.i).map(x => x.p);
}

/** Default discovery on Windows: agent-server processes and their loopback listening ports. */
export const discoverWindowsLanguageServers: Discover = async () => {
  const run = (cmd: string, args: string[]) => new Promise<string>(res =>
    execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (_e, out) => res(String(out || ''))));
  const raw = await run('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name LIKE 'language_server%' OR Name = 'agy.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"]);
  let procs: any[] = [];
  try { const j = JSON.parse(raw); procs = Array.isArray(j) ? j : [j]; } catch (_) { return []; }
  const netstat = await run('netstat.exe', ['-ano', '-p', 'TCP']);
  const servers: LsServer[] = [];
  for (const p of procs) {
    const parsed = parseServerCommandLine(String(p?.CommandLine || ''));
    if (!parsed) continue;
    const ports = netstat.split(/\r?\n/)
      .filter(l => /LISTENING/.test(l) && l.trim().endsWith(String(p.ProcessId)) && /127\.0\.0\.1:/.test(l))
      .map(l => Number((/127\.0\.0\.1:(\d+)/.exec(l) || [])[1]))
      .filter(Boolean);
    if (ports.length > 0) servers.push({ pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId), ports, ...parsed });
  }
  return servers;
};

/** Loopback TCP listening ports per pid, from `lsof -nP -iTCP -sTCP:LISTEN` or `ss -ltnpH` output. Pure; exported for tests. */
export function parseListeningPorts(raw: string): Map<number, number[]> {
  const ports = new Map<number, number[]>();
  const add = (pid: number, port: number) => {
    const list = ports.get(pid) || [];
    if (!list.includes(port)) list.push(port);
    ports.set(pid, list);
  };
  for (const line of raw.split(/\r?\n/)) {
    // lsof: language_ 4242 me 12u IPv4 0x1 0t0 TCP 127.0.0.1:53111 (LISTEN)
    const lsof = /^\S+\s+(\d+)\s.*\s(?:127\.0\.0\.1|localhost|\*):(\d+)\s+\(LISTEN\)/.exec(line);
    if (lsof) { add(Number(lsof[1]), Number(lsof[2])); continue; }
    // ss: LISTEN 0 4096 127.0.0.1:53111 0.0.0.0:* users:(("language_server",pid=4242,fd=9))
    const ss = /\s(?:127\.0\.0\.1|\*|0\.0\.0\.0):(\d+)\s.*\bpid=(\d+)/.exec(line);
    if (ss) add(Number(ss[2]), Number(ss[1]));
  }
  return ports;
}

/** Default discovery on macOS and Linux: ps for the processes, lsof (or ss) for their loopback ports. */
export const discoverPosixLanguageServers: Discover = async () => {
  const run = (cmd: string, args: string[]) => new Promise<string>(res =>
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (_e, out) => res(String(out || ''))));
  const procs = parsePsOutput(await run('ps', ['-axww', '-o', 'pid=,ppid=,command=']));
  if (procs.length === 0) return [];
  const pids = procs.map(p => p.pid).join(',');
  // GUI apps on macOS get PATH=/usr/bin:/bin:/usr/sbin:/sbin, but try the absolute path too.
  let listen = await run('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', pids]);
  if (!listen && process.platform === 'darwin') listen = await run('/usr/sbin/lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', pids]);
  if (!listen) listen = await run('ss', ['-ltnpH']);
  const ports = parseListeningPorts(listen);
  return procs.map(p => ({ ...p, ports: ports.get(p.pid) || [] })).filter(s => s.ports.length > 0);
};

export const discoverLanguageServers: Discover =
  process.platform === 'win32' ? discoverWindowsLanguageServers : discoverPosixLanguageServers;

interface Endpoint { server: LsServer; port: number; scheme: 'http' | 'https' }

/**
 * Why this bridge chose its server (shown in diagnostics):
 *  folder        an agy started with --add-dir for this window's folder
 *  conversations an agy whose conversation list includes this window's folder (agy started without --add-dir)
 *  only          the only reachable server, or an older shared language_server
 *  unconfirmed   several agy and none claims this window yet (no chat in it): rechecked every discovery cooldown
 */
export type EndpointMatch = 'folder' | 'conversations' | 'only' | 'unconfirmed';

/** Longest an unconfirmed window's rechecks reuse the last process list before discovering again. */
const REDISCOVER_MS = 60_000;

export class LsBridge {
  private discover: Discover;
  private timeoutMs: number;
  private endpoint: Endpoint | null = null;
  private matchedBy: EndpointMatch | null = null;
  private lastDiscovery = 0;
  /** Servers from the last full discovery. Rechecks of an unconfirmed choice reuse them for a minute,
   * because discovery on Windows starts PowerShell and netstat. */
  private knownServers: LsServer[] = [];
  private knownServersAt = 0;
  private discoveryCooldownMs: number;
  private verifyTimeoutMs: number;
  /** The IDE window's folder: picks that window's agy server when each window has its own. */
  private workspace?: string;

  constructor(opts: { discover?: Discover; timeoutMs?: number; discoveryCooldownMs?: number; verifyTimeoutMs?: number; workspace?: string } = {}) {
    this.discover = opts.discover || discoverLanguageServers;
    this.workspace = opts.workspace;
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this.discoveryCooldownMs = opts.discoveryCooldownMs ?? 10000;
    this.verifyTimeoutMs = opts.verifyTimeoutMs ?? 3000;
  }

  public isConnected(): boolean {
    return this.endpoint !== null;
  }

  /** The server this bridge talks to, without its token (for diagnostics). */
  public describeEndpoint(): { pid: number; port: number; scheme: string; kind?: string; matchedBy?: EndpointMatch } | null {
    const ep = this.endpoint;
    return ep ? { pid: ep.server.pid, port: ep.port, scheme: ep.scheme, kind: ep.server.kind, matchedBy: this.matchedBy || undefined } : null;
  }

  public async getTrajectory(cascadeId: string): Promise<any | null> {
    const res = await this.call('GetCascadeTrajectory', { cascadeId });
    if (res) this.runStatus.set(cascadeId, typeof res.status === 'string' ? res.status : undefined);
    return res?.trajectory ?? null;
  }

  /** Last run status the server reported per conversation (CASCADE_RUN_STATUS_IDLE / RUNNING / BUSY / CANCELING). */
  private runStatus = new Map<string, string | undefined>();

  /**
   * Whether the agent is working on this conversation, from the server's own run status as of the last
   * trajectory read (the live poll reads it every second). null when the server didn't say.
   */
  public isRunning(cascadeId: string): boolean | null {
    const status = this.runStatus.get(cascadeId);
    if (!status) return null;
    if (/RUNNING|BUSY|CANCELING/.test(status)) return true;
    if (/IDLE/.test(status)) return false;
    return null;
  }

  public async findPending(cascadeId: string): Promise<LiveInteraction | null> {
    return extractPending(cascadeId, await this.getTrajectory(cascadeId));
  }

  /** Answers a pending interaction and verifies the IDE accepted it (step leaves WAITING). */
  public async respond(p: LiveInteraction, decision: Decision): Promise<void> {
    const current = await this.findPending(p.cascadeId);
    if (!current || current.stepIndex !== p.stepIndex || current.trajectoryId !== p.trajectoryId) {
      throw new LsBridgeError('That request is no longer pending in the IDE');
    }
    const interaction = buildInteraction(current, decision);
    await this.call('HandleCascadeUserInteraction', { cascadeId: p.cascadeId, interaction }, true);

    const deadline = Date.now() + this.verifyTimeoutMs;
    while (Date.now() < deadline) {
      const traj = await this.getTrajectory(p.cascadeId);
      const status = String(traj?.steps?.[p.stepIndex]?.status || '');
      if (status && !/WAITING/.test(status)) return;
      await new Promise(r => setTimeout(r, 250));
    }
    throw new LsBridgeError('The IDE did not accept the response (step is still waiting)');
  }

  /**
   * Sends a follow-up prompt into an existing conversation, reusing its last user config.
   * Images go in the request's `images` field (ImageData{base64Data, mimeType}, read from the LS binary).
   */
  public async sendPrompt(cascadeId: string, text: string, images: PromptImage[] = []): Promise<void> {
    const traj = await this.getTrajectory(cascadeId);
    if (!traj) throw new LsBridgeError('Conversation not found in the IDE');
    const steps: any[] = traj.steps || [];
    let cascadeConfig: unknown;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i]?.userInput?.userConfig) { cascadeConfig = steps[i].userInput.userConfig; break; }
    }
    const before = steps.length;
    try {
      await this.call('SendUserCascadeMessage', {
        cascadeId,
        items: text ? [{ text }] : [],
        ...(images.length ? { images: images.map(i => ({ base64Data: i.data, mimeType: i.mimeType })) } : {}),
        ...(cascadeConfig ? { cascadeConfig } : {})
      }, true);
    } catch (err) {
      // The server refused the message itself, so nothing reached the conversation.
      if (images.length && err instanceof LsBridgeError && /HTTP \d/.test(err.message)) err.imagesRejected = true;
      throw err;
    }

    const deadline = Date.now() + this.verifyTimeoutMs;
    while (Date.now() < deadline) {
      const after = await this.getTrajectory(cascadeId);
      if ((after?.steps?.length || 0) > before) return;
      await new Promise(r => setTimeout(r, 250));
    }
    throw new LsBridgeError('The IDE did not register the prompt');
  }

  /** Every conversation the IDE knows about, newest first; null if the server is unreachable. */
  public async listConversations(): Promise<Conversation[] | null> {
    const res = await this.call('GetAllCascadeTrajectories', {});
    if (!res) return null;
    this.onConversationsRaw?.(res);
    return parseConversations(res);
  }

  /** Diagnostics hook: sees the raw response once per call (used to record its shape). */
  public onConversationsRaw?: (res: any) => void;

  /** Stops the running agent turn (same call as the IDE's stop button). */
  public async cancel(cascadeId: string): Promise<void> {
    await this.call('CancelCascadeInvocation', { cascadeId, killBackgroundTasks: true }, true);
  }

  // ---- transport ----

  private async call(method: string, body: object, mustSucceed = false): Promise<any | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ep = await this.resolveEndpoint(attempt > 0);
      if (!ep) break;
      const r = await this.post(ep, method, body);
      if (r && r.status === 200) {
        try { return r.raw ? JSON.parse(r.raw) : {}; } catch (_) { return {}; }
      }
      if (r && r.status !== 0) {
        // Server answered with an application error: do not retry on another server.
        if (mustSucceed) throw new LsBridgeError(`${method} failed (HTTP ${r.status}): ${r.raw.slice(0, 200)}`);
        return null;
      }
      this.endpoint = null; // connection-level failure: rediscover once
      this.matchedBy = null;
    }
    if (mustSucceed) throw new LsBridgeError('Antigravity language server is not reachable');
    return null;
  }

  private async resolveEndpoint(force: boolean): Promise<Endpoint | null> {
    const now = Date.now();
    const cooled = now - this.lastDiscovery >= this.discoveryCooldownMs || this.lastDiscovery === 0;
    if (this.endpoint && !force) {
      // Keep a confirmed choice. An unconfirmed one (this window had no chat yet) is rechecked, so the
      // window's first chat is found in whichever agy holds it.
      if (this.matchedBy !== 'unconfirmed' || !cooled) return this.endpoint;
    } else if (!force && !cooled) {
      return null;
    }
    this.lastDiscovery = now;

    const recheck = !!this.endpoint && !force;
    let servers: LsServer[] = [];
    if (recheck && now - this.knownServersAt < REDISCOVER_MS) {
      servers = this.knownServers;
    } else {
      try { servers = await this.discover(); } catch (_) { servers = []; }
      this.knownServers = servers;
      this.knownServersAt = now;
    }
    const chosen = await this.chooseEndpoint(servers);
    if (chosen) {
      this.endpoint = chosen.ep;
      this.matchedBy = chosen.matchedBy;
    } else if (force || !this.endpoint) {
      // Nothing answered. A recheck that finds nothing keeps the current endpoint; a failing call forces a new search.
      this.endpoint = null;
      this.matchedBy = null;
    }
    return this.endpoint;
  }

  /**
   * Picks this window's server. Only workspace-less servers hold live agent state; language_server's
   * per-workspace copies are stale, so never fall back to them. Ranked: agy for this folder first,
   * then attached, then not orphaned. An agy started without --add-dir can't be matched by folder, so
   * each one is asked for its conversations: every agy lists only its own window's chats, and acting
   * through another window's agy would show (and answer) the wrong project.
   */
  private async chooseEndpoint(servers: LsServer[]): Promise<{ ep: Endpoint; matchedBy: EndpointMatch } | null> {
    const ws = this.workspace ? normalizeWorkspace(this.workspace) : '';
    const ranked = rankLanguageServers(servers.filter(s => !s.workspaceId), this.workspace);
    let fallback: Endpoint | null = null;
    let reachable = 0;
    for (const server of ranked) {
      const ep = await this.reachableEndpoint(server);
      if (!ep) continue;
      reachable++;
      // Older shared language_server, or no folder to match: the ranking (attached first) decides, as before.
      if (!ws || server.kind !== 'agy') return { ep, matchedBy: 'only' };
      if (server.addDirs?.includes(ws)) return { ep, matchedBy: 'folder' };
      if (await this.listsWorkspace(ep, ws)) return { ep, matchedBy: 'conversations' };
      if (!fallback) fallback = ep;
    }
    if (!fallback) return null;
    return { ep: fallback, matchedBy: reachable === 1 ? 'only' : 'unconfirmed' };
  }

  /** The first port and scheme on which `server` answers, or null. */
  private async reachableEndpoint(server: LsServer): Promise<Endpoint | null> {
    for (const port of server.ports) {
      for (const scheme of ['https', 'http'] as const) {
        const ep = { server, port, scheme };
        const r = await this.post(ep, 'GetCascadeTrajectory', { cascadeId: '' });
        if (r && r.status !== 0 && !/HTTP request to an HTTPS/.test(r.raw)) return ep;
      }
    }
    return null;
  }

  /** Whether this server's conversation list has a conversation in folder `ws` (normalized). */
  private async listsWorkspace(ep: Endpoint, ws: string): Promise<boolean> {
    const r = await this.post(ep, 'GetAllCascadeTrajectories', {});
    if (!r || r.status !== 200) return false;
    try {
      return parseConversations(r.raw ? JSON.parse(r.raw) : {}).some(c => c.workspaces.includes(ws));
    } catch (_) {
      return false;
    }
  }

  private post(ep: Endpoint, method: string, body: object): Promise<{ status: number; raw: string } | null> {
    return new Promise(resolve => {
      const payload = JSON.stringify(body);
      const mod: any = ep.scheme === 'https' ? https : http;
      const req = mod.request({
        host: '127.0.0.1',
        port: ep.port,
        method: 'POST',
        path: SERVICE + method,
        rejectUnauthorized: false, // self-signed loopback certificate
        timeout: this.timeoutMs,
        headers: {
          'content-type': 'application/json',
          'connect-protocol-version': '1',
          'x-codeium-csrf-token': ep.server.token,
          'content-length': Buffer.byteLength(payload)
        }
      }, (res: any) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode || 0, raw }));
      });
      req.on('error', () => resolve({ status: 0, raw: '' }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, raw: '' }); });
      req.write(payload);
      req.end();
    });
  }
}

