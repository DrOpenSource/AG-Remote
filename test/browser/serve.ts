/**
 * Phone-app test server for the Playwright browser tests: the real RemoteServer and phone app,
 * driven by a fake agent instead of Antigravity. A loopback control API lets tests make the
 * "agent" talk and read back what the phone sent.
 *
 *   APP      http://127.0.0.1:$APP_PORT/?token=browser-test-token
 *   CONTROL  GET  /health          ready check
 *            POST /reset           clear messages, approval and recorded calls
 *            POST /message {text}  agent message
 *            POST /approval {...}  agent asks for permission
 *            POST /last-active {minutesAgo}  when the shown conversation last changed
 *            GET  /calls          what the phone did (prompts with image counts, approvals, stops)
 */
import http from 'http';
import type { IdeAdapter, AdapterEvent, SessionSnapshot, Approval, ChatMessage, PromptImage, SessionStatus } from '../../src/core/types.ts';
import { SessionManager } from '../../src/core/session-manager.ts';
import { RemoteServer } from '../../src/server/index.ts';

export const TEST_TOKEN = 'browser-test-token';
const APP_PORT = Number(process.env.APP_PORT || 49390);
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 49391);

class FakeAgent implements IdeAdapter {
  public readonly name = 'fake-agent';
  public calls: any[] = [];
  private messages: ChatMessage[] = [];
  private approval: Approval | null = null;
  private status: SessionStatus = 'idle';
  private lastActivity: number | undefined;
  private cbs: Array<(e: AdapterEvent) => void> = [];
  private nextId = 1;

  async connect() {}
  async disconnect() {}
  async getSnapshot(): Promise<SessionSnapshot> {
    return { status: this.status, messages: [...this.messages], pendingApproval: this.approval, lastActivity: this.lastActivity };
  }
  async getPendingApproval() { return this.approval; }
  onEvent(cb: (e: AdapterEvent) => void) { this.cbs.push(cb); }
  private fire(e: AdapterEvent) { for (const cb of this.cbs) cb(e); }
  private setStatus(status: SessionStatus) {
    this.status = status;
    this.fire({ type: 'status_changed', status });
  }

  async sendPrompt(text: string, images: PromptImage[] = []) {
    this.calls.push({ type: 'prompt', text, images: images.map(i => ({ mimeType: i.mimeType, bytes: Math.floor(i.data.length * 3 / 4) })) });
  }
  async approve(id: string, _response?: string, option?: string) {
    this.calls.push({ type: 'approve', id, option });
    this.approval = null;
    this.setStatus('generating');
  }
  async deny(id: string, reason?: string) {
    this.calls.push({ type: 'deny', id, reason });
    this.approval = null;
    this.setStatus('idle');
  }
  async stop() {
    this.calls.push({ type: 'stop' });
    this.setStatus('idle');
  }

  agentSays(text: string) {
    const message: ChatMessage = { id: `m${this.nextId++}`, role: 'agent', text, ts: Date.now() };
    this.lastActivity = message.ts;
    this.messages.push(message);
    this.fire({ type: 'message', message });
  }
  asks(approval: Partial<Approval>) {
    this.approval = {
      id: `ls:test:${this.nextId++}`,
      kind: 'run_command',
      description: 'Run command',
      detail: 'echo hello > probe.txt',
      actions: ['allow_once', 'allow_conversation', 'deny'],
      ...approval
    };
    this.fire({ type: 'approval_requested', approval: this.approval });
    this.setStatus('awaiting_approval');
  }
  reset() {
    this.calls = [];
    this.messages = [];
    this.approval = null;
    this.status = 'idle';
    this.lastActivity = undefined;
  }
  setLastActivity(minutesAgo: number) {
    this.lastActivity = Date.now() - minutesAgo * 60_000;
  }
}

const agent = new FakeAgent();
const sm = new SessionManager(agent, TEST_TOKEN);
// A real window sends heartbeats; without them the registry prunes it
const registerWindow = () => sm.registry.register({ windowId: 'win-test', workspaceName: 'demo-project', workspacePath: '/work/demo-project', isFocused: true });
registerWindow();
setInterval(registerWindow, 2000);
const server = new RemoteServer(sm, { port: APP_PORT, host: '127.0.0.1' });
await server.start();

const readBody = (req: http.IncomingMessage) => new Promise<any>(resolve => {
  let s = '';
  req.on('data', c => { s += c; });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
});

http.createServer(async (req, res) => {
  const body = req.method === 'POST' ? await readBody(req) : {};
  const reply = (data: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  switch (`${req.method} ${req.url}`) {
    case 'GET /health': return reply({ ok: true, appPort: APP_PORT });
    case 'POST /reset': agent.reset(); return reply({ ok: true });
    case 'POST /message': agent.agentSays(String(body.text || '')); return reply({ ok: true });
    case 'POST /approval': agent.asks(body); return reply({ ok: true });
    case 'POST /last-active': agent.setLastActivity(Number(body.minutesAgo) || 0); return reply({ ok: true });
    case 'GET /calls': return reply(agent.calls);
    default: res.writeHead(404); res.end();
  }
}).listen(CONTROL_PORT, '127.0.0.1', () => console.log(`phone app on ${APP_PORT}, control on ${CONTROL_PORT}`));
