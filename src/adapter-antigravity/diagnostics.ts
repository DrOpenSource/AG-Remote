/**
 * Connection report for "Antigravity Remote: Copy Diagnostics", so a user on another machine
 * can show why the phone sees no conversation. Never includes tokens or conversation titles.
 */
import fs from 'fs';
import os from 'os';
import { LsBridge, discoverLanguageServers, normalizeWorkspace, type Discover } from './ls-bridge.ts';
import { defaultConfig } from './config.ts';

export interface DiagnosticsOptions {
  workspacePath: string;
  extensionVersion?: string;
  discover?: Discover;
  brainDir?: string;
}

export async function collectDiagnostics(opts: DiagnosticsOptions): Promise<string> {
  const discover = opts.discover || discoverLanguageServers;
  const brainDirs = opts.brainDir ? [opts.brainDir] : (defaultConfig.brainDirs || [defaultConfig.brainDir]);
  const ws = normalizeWorkspace(opts.workspacePath);
  const lines: string[] = [
    '# Antigravity Remote diagnostics',
    '',
    `- Extension: ${opts.extensionVersion || 'unknown'}`,
    `- System: ${process.platform} ${os.release()} (${process.arch}), Node ${process.versions.node}`,
    `- This window's folder: \`${ws}\``,
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
    if (s.ppid !== undefined) flags.push(`parent ${s.ppid}`);
    lines.push(`- pid ${s.pid}: ports ${s.ports.join(', ') || 'none'}; ${flags.join('; ')}`);
  }
  lines.push('');

  // Same selection as the real bridge for this window, fed the servers found above
  const bridge = new LsBridge({ discover: async () => servers, discoveryCooldownMs: 0, workspace: opts.workspacePath });
  const convs = await bridge.listConversations().catch(() => null);
  const ep = bridge.describeEndpoint();
  const why: Record<string, string> = {
    folder: "its folder is this window's",
    conversations: "it holds this window's conversations",
    only: 'the only server',
    unconfirmed: 'no server holds a conversation for this window yet; rechecking'
  };
  lines.push(`## Connected to: ${ep ? `pid ${ep.pid} (${ep.kind || 'language_server'}), port ${ep.port} (${ep.scheme})${ep.matchedBy ? `; chosen because ${why[ep.matchedBy]}` : ''}` : 'none (no workspace-less server answered)'}`);
  if (convs) {
    const mine = convs.filter(c => c.workspaces.includes(ws));
    lines.push(`- Conversations the IDE lists: ${convs.length}`);
    lines.push(`- Conversations for this window's folder: ${mine.length}`);
    lines.push('- Folders of the 5 newest conversations:');
    for (const c of convs.slice(0, 5)) {
      const when = c.lastActivity ? new Date(c.lastActivity).toISOString() : 'unknown time';
      lines.push(`  - ${when}: ${c.workspaces.map(w => `\`${w}\``).join(', ') || '(no folder)'}${c.workspaces.includes(ws) ? ' ← this window' : ''}`);
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
