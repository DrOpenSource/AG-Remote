/**
 * Connection report for "Antigravity Remote: Copy Diagnostics", so a user on another machine
 * can show why the phone sees no conversation. Never includes tokens or conversation titles.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LsBridge, discoverLanguageServers, normalizeWorkspace, type Discover } from './ls-bridge.ts';
import { defaultConfig } from './config.ts';

export interface DiagnosticsOptions {
  workspacePath: string;
  extensionVersion?: string;
  discover?: Discover;
  brainDir?: string;
  /** This window's extension host (the parent of its agy); defaults to this process. */
  ownerPid?: number;
  /** Whether this window serves the phone (holds the local server and the relay connection). */
  hostsPhoneServer?: boolean;
  /** The serving window's own view (POST /api/hub/diagnostics); null when it is too old to answer. */
  hostReport?: { version?: string; relay?: string; relayPhones?: number; windows: Array<Record<string, any>> } | null;
}

const WHY: Record<string, string> = {
  folder: "its folder is this window's",
  parent: "this window's extension host started it",
  conversations: "it holds this window's conversations",
  only: 'the only server',
  unconfirmed: "no server is this window's yet (no chat in it, or its agent is still starting); rechecking"
};

export async function collectDiagnostics(opts: DiagnosticsOptions): Promise<string> {
  const discover = opts.discover || discoverLanguageServers;
  const brainDirs = opts.brainDir ? [opts.brainDir] : (defaultConfig.brainDirs || [defaultConfig.brainDir]);
  const ws = normalizeWorkspace(opts.workspacePath);
  const ownerPid = opts.ownerPid ?? process.pid;
  const lines: string[] = [
    '# Antigravity Remote diagnostics',
    '',
    `- Extension: ${opts.extensionVersion || 'unknown'}`,
    `- System: ${process.platform} ${os.release()} (${process.arch}), Node ${process.versions.node}`,
    `- This window's folder: \`${ws}\``,
    `- This window's extension host: pid ${ownerPid}`,
    ''
  ];

  let servers: Awaited<ReturnType<Discover>> = [];
  try { servers = await discover(); } catch (err: any) { lines.push(`Discovery error: ${err?.message || err}`); }
  lines.push(`## Language servers found: ${servers.length}`);
  for (const s of servers) {
    const flags = [s.kind || 'language_server', s.workspaceId ? `workspace ${s.workspaceId}` : 'no workspace (live candidate)'];
    if (s.addDirs?.length) flags.push(`folder ${s.addDirs.map(d => `\`${d}\``).join(', ')}${s.addDirs.includes(ws) ? ' ← this window' : ''}`);
    if (s.appDataDir) flags.push(`data ~/.gemini/${s.appDataDir}`);
    if (s.attached !== undefined) flags.push(s.attached ? 'attached to IDE' : 'not attached');
    if (s.ppid !== undefined) flags.push(`parent ${s.ppid}${s.kind === 'agy' && s.ppid === ownerPid ? ' ← this window' : ''}`);
    if (!s.workspaceId) {
      // Each agy lists only its own window's chats, so ask every one
      const own = await new LsBridge({ discover: async () => [s], discoveryCooldownMs: 0 }).listConversations().catch(() => null);
      flags.push(own ? `lists ${own.length} conversation(s), ${own.filter(c => c.workspaces.includes(ws)).length} for this window` : 'did not answer');
    }
    lines.push(`- pid ${s.pid}: ports ${s.ports.join(', ') || 'none'}; ${flags.join('; ')}`);
  }
  lines.push('');

  // Same selection as the real bridge for this window, fed the servers found above
  const bridge = new LsBridge({ discover: async () => servers, discoveryCooldownMs: 0, workspace: opts.workspacePath, ownerPid });
  const convs = await bridge.listConversations().catch(() => null);
  const ep = bridge.describeEndpoint();
  lines.push(`## Connected to: ${ep ? `pid ${ep.pid} (${ep.kind || 'language_server'}), port ${ep.port} (${ep.scheme})${ep.matchedBy ? `; chosen because ${WHY[ep.matchedBy]}` : ''}` : 'none (no workspace-less server answered)'}`);
  if (convs) {
    const mine = convs.filter(c => c.workspaces.includes(ws));
    lines.push(`- Conversations the IDE lists: ${convs.length}`);
    lines.push(`- Conversations for this window's folder: ${mine.length}`);
    if (mine[0]) {
      // The phone shows a conversation from its transcript file, so it must be on disk
      const dir = brainDirs.find(d => fs.existsSync(path.join(d, mine[0].cascadeId, '.system_generated', 'logs', 'transcript.jsonl')));
      lines.push(dir
        ? `- Newest one's history: in \`${dir.replace(os.homedir(), '~')}\``
        : "- Newest one's history: ⚠ no transcript on disk, so the phone can't show it");
    }
    lines.push('- Folders of the 5 newest conversations:');
    for (const c of convs.slice(0, 5)) {
      const when = c.lastActivity ? new Date(c.lastActivity).toISOString() : 'unknown time';
      lines.push(`  - ${when}: ${c.workspaces.map(w => `\`${w}\``).join(', ') || '(no folder)'}${c.workspaces.includes(ws) ? ' ← this window' : ''}`);
    }
  }
  lines.push('');

  lines.push(`## What the phone sees (${opts.hostsPhoneServer ? 'this window serves the phone' : 'from the window that serves the phone'})`);
  const host = opts.hostReport;
  if (!host) {
    lines.push(opts.hostsPhoneServer
      ? '- Not available'
      : '- ⚠ No answer: the serving window runs an older version, or no window serves the phone. Quit Antigravity fully and open it again.');
  } else {
    const mismatch = host.version && opts.extensionVersion && host.version !== opts.extensionVersion;
    lines.push(`- Serving window's version: ${host.version || 'unknown'}${mismatch ? ' ⚠ differs from this window: quit Antigravity fully and open it again' : ''}`);
    lines.push(`- Relay: ${host.relay || 'unknown'}; phones paired through it: ${host.relayPhones ?? 'unknown'}`);
    for (const w of host.windows) {
      const s = w.shows || {};
      const server = s.server ? `agy pid ${s.server.pid}${s.server.matchedBy ? ` (${s.server.matchedBy})` : ''}` : 'no server';
      const parts = s.error
        ? [`error: ${s.error}`]
        : [
            server,
            `${s.conversationsForFolder ?? '?'} of ${s.conversationsListed ?? '?'} conversation(s) for its folder`,
            `history ${s.newestHistoryFolder ? (s.newestHistoryFolder === 'missing' ? '⚠ missing' : 'found') : 'n/a'}`,
            `shows ${s.shownConversation ? `conversation ${s.shownConversation}…` : 'no conversation'}`,
            `${s.messages ?? '?'} message(s)`,
            `status ${s.status ?? '?'}`
          ];
      const self = normalizeWorkspace(String(s.folder || '')) === ws ? ' ← this window' : '';
      lines.push(`- \`${w.window}\`${w.host ? ' (serving)' : ''}, extension host pid ${w.pid ?? '?'}${self}: ${parts.join('; ')}`);
    }
  }
  lines.push('');

  lines.push('## Chat history folders');
  for (const dir of brainDirs) {
    let state = 'missing';
    try { if (fs.existsSync(dir)) state = `${fs.readdirSync(dir).length} entries`; } catch (_) { state = 'unreadable'; }
    lines.push(`- \`${dir.replace(os.homedir(), '~')}\` (${state})`);
  }
  return lines.join('\n') + '\n';
}
