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
  const brainDir = opts.brainDir || defaultConfig.brainDir;
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
  for (const s of servers as any[]) {
    const flags = [s.workspaceId ? `workspace ${s.workspaceId}` : 'no workspace (live candidate)'];
    if (s.attached !== undefined) flags.push(s.attached ? 'attached to IDE' : 'not attached');
    if (s.ppid !== undefined) flags.push(`parent ${s.ppid}`);
    lines.push(`- pid ${s.pid}: ports ${s.ports.join(', ') || 'none'}; ${flags.join('; ')}`);
  }
  lines.push('');

  // Same selection as the real bridge, fed the servers found above
  const bridge = new LsBridge({ discover: async () => servers, discoveryCooldownMs: 0 });
  const convs = await bridge.listConversations().catch(() => null);
  const ep = bridge.describeEndpoint();
  lines.push(`## Connected to: ${ep ? `pid ${ep.pid}, port ${ep.port} (${ep.scheme})` : 'none (no workspace-less server answered)'}`);
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

  let brain = 'missing';
  try { if (fs.existsSync(brainDir)) brain = `${fs.readdirSync(brainDir).length} entries`; } catch (_) { brain = 'unreadable'; }
  lines.push(`## Chat history folder: \`${brainDir.replace(os.homedir(), '~')}\` (${brain})`);
  return lines.join('\n') + '\n';
}
