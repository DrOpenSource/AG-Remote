/**
 * Multi-window routing: one channel per IDE window, events tagged with their window, actions never
 * reaching another window, and each channel following its own window's newest conversation.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionManager } from '../src/core/session-manager.ts';
import { AntigravityAdapter } from '../src/adapter-antigravity/index.ts';
import type { IdeAdapter, AdapterEvent, SessionSnapshot } from '../src/core/types.ts';

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) { passed++; console.log(`  ✅ PASS: ${msg}`); }
  else { failed++; console.log(`  ❌ FAIL: ${msg}`); }
}
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

console.log('='.repeat(75));
console.log('🧪 TEST SUITE: MULTI-WINDOW CHANNELS');
console.log('='.repeat(75));

class FakeAdapter implements IdeAdapter {
  public readonly name = 'fake';
  public calls: string[] = [];
  public connected = false;
  private cbs: Array<(e: AdapterEvent) => void> = [];
  public workspace: string;
  constructor(workspace: string) { this.workspace = workspace; }
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  async getSnapshot(): Promise<SessionSnapshot> { return { status: 'idle', messages: [{ id: 'm', role: 'agent', text: this.workspace, ts: 0 }], pendingApproval: null }; }
  async sendPrompt(text: string) { this.calls.push(`prompt:${text}`); }
  async getPendingApproval() { return null; }
  async approve(id: string) { this.calls.push(`approve:${id}`); }
  async deny(id: string) { this.calls.push(`deny:${id}`); }
  async stop() { this.calls.push('stop'); }
  onEvent(cb: (e: AdapterEvent) => void) { this.cbs.push(cb); }
  fire(e: AdapterEvent) { this.cbs.forEach(cb => cb(e)); }
  async listSessions() {
    return [
      { id: 'a1', mtime: 2, title: 'A chat', workspace: 'c:/proj/a', isCurrent: this.workspace === 'C:/proj/a' },
      { id: 'b1', mtime: 1, title: 'B chat', workspace: 'c:/proj/b', isCurrent: this.workspace === 'C:/proj/b' }
    ];
  }
}

async function run() {
  console.log('\n[Suite 1] Session manager channels');
  const host = new FakeAdapter('C:/proj/a');
  const created: FakeAdapter[] = [];
  const sm = new SessionManager(host, 'multi-window-test-token', {
    hostWindowId: 'win-a',
    createChannel: ws => { const a = new FakeAdapter(ws); created.push(a); return a; }
  });
  const events: any[] = [];
  sm.on('adapter_event', e => events.push(e));

  sm.registry.register({ windowId: 'win-a', workspacePath: 'C:/proj/a', isFocused: true });
  await sm.start();
  sm.registry.register({ windowId: 'win-b', workspacePath: 'C:/proj/b', isFocused: false });
  await tick();
  assert(created.length === 1 && created[0].workspace === 'C:/proj/b', 'a second window gets its own channel');
  assert(created[0].connected, 'the new channel is connected');

  await sm.sendPrompt('to B', 'win-b');
  await sm.approve('x', undefined, 'allow_once', 'win-b');
  await sm.stopGeneration('win-b');
  assert(created[0].calls.join() === 'prompt:to B,approve:x,stop', 'actions for window B reach only B');
  assert(host.calls.length === 0, 'window A receives nothing meant for B');

  await sm.sendPrompt('default');
  assert(host.calls[0] === 'prompt:default', 'no windowId goes to the selected (focused) window');

  let threw = '';
  try { await sm.sendPrompt('lost', 'win-gone'); } catch (e: any) { threw = e.message; }
  assert(/no longer open/.test(threw), 'an unknown window is refused instead of falling back to another window');

  const snapB = await sm.getSnapshot('win-b');
  assert(snapB.messages[0].text === 'C:/proj/b', 'snapshot comes from the requested window');

  events.length = 0;
  created[0].fire({ type: 'status_changed', status: 'generating' });
  host.fire({ type: 'status_changed', status: 'idle' });
  assert(events.some(e => e.windowId === 'win-b' && e.status === 'generating'), 'events from B are tagged with win-b');
  assert(events.some(e => e.windowId === 'win-a' && e.status === 'idle'), 'events from the host are tagged with win-a');

  const sessB = await sm.listSessions('win-b');
  assert(sessB.length === 1 && sessB[0].id === 'b1', 'conversation list for a window shows only that project');

  sm.registry.unregister('win-b');
  await tick();
  assert(!created[0].connected, 'closing a window disconnects its channel');
  events.length = 0;
  created[0].fire({ type: 'status_changed', status: 'generating' });
  assert(!events.some(e => e.windowId === 'win-b' && e.type === 'status_changed'), 'a closed window\'s channel no longer reaches the phone');
  sm.registry.unregister('win-a');
  await sm.stop();

  console.log('\n[Suite 2] Adapter follows its own window\'s newest conversation');
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'agr-mw-'));
  const write = (id: string, text: string) => {
    const dir = path.join(brain, id, '.system_generated', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcript.jsonl'),
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: new Date().toISOString(), content: `<USER_REQUEST>${text}</USER_REQUEST>` }) + '\n');
  };
  write('a-old', 'old A');
  write('b-new', 'newest overall, but project B');
  let convs = [
    { cascadeId: 'b-new', title: 'B', workspaces: ['c:/proj/b'], lastActivity: 300 },
    { cascadeId: 'a-old', title: 'A old', workspaces: ['c:/proj/a'], lastActivity: 100 }
  ];
  const stub: any = { listConversations: async () => convs, findPending: async () => null };
  const adapter = new AntigravityAdapter('C:\\proj\\a', { brainDir: brain }, { lsBridge: stub, livePollMs: 60000 });
  const seen: any[] = [];
  adapter.onEvent(e => seen.push(e));
  await adapter.connect();
  await adapter.disconnect();
  const anyAdapter = adapter as any;
  await anyAdapter.pollLive();
  assert(anyAdapter.watcher.getActiveConversationId() === 'a-old', 'picks its own project\'s conversation, not the newest overall');

  write('a-new', 'new chat in A');
  convs = [{ cascadeId: 'a-new', title: 'A new', workspaces: ['c:/proj/a'], lastActivity: 400 }, ...convs];
  anyAdapter.lastFollowCheck = 0;
  seen.length = 0;
  await anyAdapter.pollLive();
  assert(anyAdapter.watcher.getActiveConversationId() === 'a-new', 'moves to a new chat opened in this window');
  assert(seen[0]?.type === 'session_changed', 'announces the switch before the new messages');
  assert(seen.some(e => e.type === 'message' && e.message.text === 'new chat in A'), 'streams the new chat\'s messages');

  await adapter.setActiveSession('a-old');
  anyAdapter.lastFollowCheck = 0;
  await anyAdapter.pollLive();
  assert(anyAdapter.watcher.getActiveConversationId() === 'a-old', 'a conversation picked on the phone is kept while nothing new happens');

  convs = convs.map(c => c.cascadeId === 'a-new' ? { ...c, lastActivity: 500 } : c);
  anyAdapter.lastFollowCheck = 0;
  await anyAdapter.pollLive();
  assert(anyAdapter.watcher.getActiveConversationId() === 'a-new', 'new activity in another chat of this window moves the tab there');

  anyAdapter.watcher.stop();

  const empty = new AntigravityAdapter('C:\\proj\\c', { brainDir: brain }, { lsBridge: stub, livePollMs: 60000 });
  await empty.connect();
  await empty.disconnect();
  const anyEmpty = empty as any;
  await anyEmpty.pollLive();
  assert(anyEmpty.watcher.getActiveConversationId() === null, 'a window with no chat of its own shows no conversation, not another project\'s');
  assert((await empty.getSnapshot()).messages.length === 0, 'its tab stays empty');
  let refused = '';
  try { await empty.sendPrompt('hi'); } catch (e: any) { refused = e.message; }
  assert(/no Antigravity chat yet/.test(refused), 'a prompt from its tab is refused instead of reaching another project');
  anyEmpty.watcher.stop();
  fs.rmSync(brain, { recursive: true, force: true });

  console.log('\n[Suite 3] Hand-over: another window takes over the port');
  const { RemoteServer } = await import('../src/server/index.ts');
  const PORT = 49377;
  const first = new FakeAdapter('C:/proj/a');
  const second = new FakeAdapter('C:/proj/b');
  const smFirst = new SessionManager(first, 'handover-token-1');
  const smSecond = new SessionManager(second, 'handover-token-1');
  const srvFirst = new RemoteServer(smFirst, { port: PORT, host: '127.0.0.1' });
  await srvFirst.start();
  const srvSecond = new RemoteServer(smSecond, { port: PORT, host: '127.0.0.1' });
  let code = '';
  try { await srvSecond.start(); } catch (e: any) { code = e.code; }
  assert(code === 'EADDRINUSE', 'a second window cannot host while the first one does');
  assert(!second.connected, 'the losing window does not connect to the IDE');

  await srvFirst.stop();
  const srvTakeover = new RemoteServer(smSecond, { port: PORT, host: '127.0.0.1' });
  await srvTakeover.start();
  assert(second.connected, 'after the host closes, the other window takes over the port');
  const res = await fetch(`http://127.0.0.1:${PORT}/api/state`, { headers: { Authorization: 'Bearer handover-token-1' } });
  assert(res.status === 200, 'the phone\'s existing session token still works on the new host');
  await srvTakeover.stop();

  console.log('\n' + '='.repeat(75));
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(75));
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test harness error:', err);
  process.exit(1);
});
