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

export interface LsServer {
  pid: number;
  workspaceId: string | null;
  token: string;
  ports: number[];
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

export class LsBridgeError extends Error {}

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

/** Default discovery on Windows: list language_server processes and their loopback listening ports. */
export const discoverWindowsLanguageServers: Discover = async () => {
  const run = (cmd: string, args: string[]) => new Promise<string>(res =>
    execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (_e, out) => res(String(out || ''))));
  const raw = await run('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='language_server_windows_x64.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"]);
  let procs: any[] = [];
  try { const j = JSON.parse(raw); procs = Array.isArray(j) ? j : [j]; } catch (_) { return []; }
  const netstat = await run('netstat.exe', ['-ano', '-p', 'TCP']);
  return procs.map(p => {
    const cmd = String(p.CommandLine || '');
    const token = (/(?:^|\s)--csrf_token[= ]"?([^\s"]+)/.exec(cmd) || [])[1] || '';
    const workspaceId = (/--workspace_id[= ]"?([^\s"]+)/.exec(cmd) || [])[1] || null;
    const ports = netstat.split(/\r?\n/)
      .filter(l => /LISTENING/.test(l) && l.trim().endsWith(String(p.ProcessId)) && /127\.0\.0\.1:/.test(l))
      .map(l => Number((/127\.0\.0\.1:(\d+)/.exec(l) || [])[1]))
      .filter(Boolean);
    return { pid: Number(p.ProcessId), workspaceId, token, ports };
  }).filter(s => s.token && s.ports.length > 0);
};

interface Endpoint { server: LsServer; port: number; scheme: 'http' | 'https' }

export class LsBridge {
  private discover: Discover;
  private timeoutMs: number;
  private endpoint: Endpoint | null = null;
  private lastDiscovery = 0;
  private discoveryCooldownMs: number;
  private verifyTimeoutMs: number;

  constructor(opts: { discover?: Discover; timeoutMs?: number; discoveryCooldownMs?: number; verifyTimeoutMs?: number } = {}) {
    this.discover = opts.discover || discoverWindowsLanguageServers;
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this.discoveryCooldownMs = opts.discoveryCooldownMs ?? 10000;
    this.verifyTimeoutMs = opts.verifyTimeoutMs ?? 3000;
  }

  public isConnected(): boolean {
    return this.endpoint !== null;
  }

  public async getTrajectory(cascadeId: string): Promise<any | null> {
    const res = await this.call('GetCascadeTrajectory', { cascadeId });
    return res?.trajectory ?? null;
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

  /** Sends a follow-up prompt into an existing conversation, reusing its last user config. */
  public async sendPrompt(cascadeId: string, text: string): Promise<void> {
    const traj = await this.getTrajectory(cascadeId);
    if (!traj) throw new LsBridgeError('Conversation not found in the IDE');
    const steps: any[] = traj.steps || [];
    let cascadeConfig: unknown;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i]?.userInput?.userConfig) { cascadeConfig = steps[i].userInput.userConfig; break; }
    }
    const before = steps.length;
    await this.call('SendUserCascadeMessage', {
      cascadeId, items: [{ text }], ...(cascadeConfig ? { cascadeConfig } : {})
    }, true);

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
    }
    if (mustSucceed) throw new LsBridgeError('Antigravity language server is not reachable');
    return null;
  }

  private async resolveEndpoint(force: boolean): Promise<Endpoint | null> {
    if (this.endpoint && !force) return this.endpoint;
    const now = Date.now();
    if (!force && now - this.lastDiscovery < this.discoveryCooldownMs && this.lastDiscovery > 0) return null;
    this.lastDiscovery = now;

    let servers: LsServer[] = [];
    try { servers = await this.discover(); } catch (_) { servers = []; }
    // Only the workspace-less server holds live agent state; per-workspace servers show stale copies,
    // so never fall back to them.
    for (const server of servers.filter(s => !s.workspaceId)) {
      for (const port of server.ports) {
        for (const scheme of ['https', 'http'] as const) {
          const ep = { server, port, scheme };
          const r = await this.post(ep, 'GetCascadeTrajectory', { cascadeId: '' });
          if (r && r.status !== 0 && !/HTTP request to an HTTPS/.test(r.raw)) {
            this.endpoint = ep;
            return ep;
          }
        }
      }
    }
    this.endpoint = null;
    return null;
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

