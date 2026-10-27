// Relay test suite. Uses Node's built-in WebSocket, no extra dependencies.
// With RELAY_URL unset it starts `wrangler dev` on port 8787 and stops it afterwards.
// Against a deployed relay: RELAY_URL=https://remote.taqnik.in npm test
import { spawn, execSync, type ChildProcess } from 'child_process';
import crypto from 'crypto';

const LOCAL_URL = 'http://127.0.0.1:8787';
const BASE = process.env.RELAY_URL || LOCAL_URL;
const WS_BASE = BASE.replace(/^http/, 'ws');

console.log('='.repeat(75));
console.log(`🧪 RELAY TEST SUITE (${BASE})`);
console.log('='.repeat(75));

let passed = 0;
let failed = 0;

function assert(condition: boolean, desc: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${desc}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${desc}`);
    failed++;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newRoom = () => crypto.randomBytes(16).toString('base64url');

class TestClient {
  ws: WebSocket;
  messages: any[] = [];
  closeCode: number | null = null;
  private waiters: (() => void)[] = [];

  constructor(room: string, role: 'host' | 'phone') {
    this.ws = new WebSocket(`${WS_BASE}/ws/${room}?role=${role}`);
    this.ws.addEventListener('message', (e) => {
      const data = String(e.data);
      let parsed: any = data;
      try {
        parsed = JSON.parse(data);
      } catch {}
      this.messages.push(parsed);
      this.wake();
    });
    this.ws.addEventListener('close', (e) => {
      this.closeCode = e.code;
      this.wake();
    });
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  /** Waits for a message matching `pred` (already received or new). Returns it, or null on timeout. */
  async waitFor(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.find(pred);
      if (found !== undefined) return found;
      await Promise.race([new Promise<void>((r) => this.waiters.push(r)), sleep(deadline - Date.now())]);
    }
    return this.messages.find(pred) ?? null;
  }

  async waitClosed(timeoutMs = 3000): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    while (this.closeCode === null && Date.now() < deadline) {
      await Promise.race([new Promise<void>((r) => this.waiters.push(r)), sleep(deadline - Date.now())]);
    }
    return this.closeCode;
  }

  has(pred: (m: any) => boolean) {
    return this.messages.some(pred);
  }

  send(data: string) {
    this.ws.send(data);
  }

  close() {
    this.ws.close();
  }
}

async function connect(room: string, role: 'host' | 'phone') {
  const c = new TestClient(room, role);
  await c.waitFor((m) => m?.relay === 'hello');
  return c;
}

async function startLocalRelay(): Promise<ChildProcess> {
  const proc = spawn('npx wrangler dev --port 8787', { cwd: new URL('..', import.meta.url), shell: true, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${LOCAL_URL}/health`)).ok) return proc;
    } catch {}
    await sleep(1000);
  }
  stopLocalRelay(proc);
  throw new Error('wrangler dev did not start within 60s');
}

function stopLocalRelay(proc: ChildProcess) {
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
    } catch {}
  } else {
    proc.kill('SIGTERM');
  }
}

async function runTests() {
  console.log('\n[1] HTTP routing');
  const health = await fetch(`${BASE}/health`);
  assert(health.status === 200 && (await health.text()) === 'ok', '/health returns ok');
  assert((await fetch(`${BASE}/nope`)).status === 404, 'unknown path returns 404');
  assert((await fetch(`${BASE}/ws/short?role=host`)).status === 400, 'guessable room id rejected (400)');
  assert((await fetch(`${BASE}/ws/${newRoom()}?role=admin`)).status === 400, 'unknown role rejected (400)');
  assert((await fetch(`${BASE}/ws/${newRoom()}?role=host`)).status === 426, 'plain GET on /ws needs an upgrade (426)');

  console.log('\n[2] Join and presence');
  const room = newRoom();
  const host = await connect(room, 'host');
  const hostHello = host.messages[0];
  assert(hostHello.role === 'host' && Array.isArray(hostHello.peers) && hostHello.peers.length === 0, 'host gets hello with no peers');
  const phoneA = await connect(room, 'phone');
  assert(phoneA.messages[0].peers.length === 1 && phoneA.messages[0].peers[0].role === 'host', 'phone hello lists the host');
  const joined = await host.waitFor((m) => m?.relay === 'peer-joined');
  assert(joined?.role === 'phone' && joined.peer === phoneA.messages[0].you, 'host told that the phone joined');

  console.log('\n[3] Forwarding');
  host.send(JSON.stringify({ type: 'snapshot', n: 1 }));
  assert((await phoneA.waitFor((m) => m?.type === 'snapshot'))?.n === 1, 'host -> phone delivered');
  phoneA.send(JSON.stringify({ type: 'approve', id: 'x' }));
  assert((await host.waitFor((m) => m?.type === 'approve'))?.id === 'x', 'phone -> host delivered');

  const phoneB = await connect(room, 'phone');
  assert(phoneB.messages[0].peers.length === 1, 'second phone sees only the host, not the other phone');
  await host.waitFor((m) => m?.relay === 'peer-joined' && m.peer === phoneB.messages[0].you);
  phoneA.send(JSON.stringify({ type: 'from-a' }));
  await host.waitFor((m) => m?.type === 'from-a');
  await sleep(300);
  assert(!phoneB.has((m) => m?.type === 'from-a'), 'phone -> phone is never forwarded');
  assert(!phoneB.has((m) => m?.relay === 'peer-joined' && m.role === 'phone'), 'phones are not told about other phones');
  host.send(JSON.stringify({ type: 'to-all' }));
  assert(
    (await phoneA.waitFor((m) => m?.type === 'to-all')) !== null && (await phoneB.waitFor((m) => m?.type === 'to-all')) !== null,
    'host message reaches every phone'
  );

  phoneA.send('{"relay":"peer-left","role":"host","peer":"fake"}');
  await sleep(300);
  assert(!host.has((m) => m?.peer === 'fake'), 'client-sent relay control message is dropped');

  phoneA.send('ping');
  assert((await phoneA.waitFor((m) => m === 'pong')) === 'pong', 'ping answered with pong');

  const other = newRoom();
  const otherHost = await connect(other, 'host');
  host.send(JSON.stringify({ type: 'room-isolation' }));
  await phoneA.waitFor((m) => m?.type === 'room-isolation');
  await sleep(300);
  assert(!otherHost.has((m) => m?.type === 'room-isolation'), 'rooms are isolated');
  otherHost.close();

  console.log('\n[4] Limits');
  const phoneC = await connect(room, 'phone');
  const phoneD = await connect(room, 'phone');
  const phoneE = new TestClient(room, 'phone');
  assert((await phoneE.waitClosed()) === 4002, '5th phone closed with 4002 (room full)');

  phoneD.send('x'.repeat(64 * 1024 + 1));
  assert((await phoneD.waitClosed()) === 4003, 'message over 64 KB closed with 4003');

  for (let i = 0; i < 205; i++) phoneC.send(JSON.stringify({ type: 'flood', i }));
  assert((await phoneC.waitClosed()) === 4004, 'more than 200 messages in 10 s closed with 4004');

  console.log('\n[5] Leaving and host replacement');
  const left = await host.waitFor((m) => m?.relay === 'peer-left' && m.role === 'phone');
  assert(left !== null, 'host told when a phone leaves');

  const host2 = await connect(room, 'host');
  assert((await host.waitClosed()) === 4001, 'old host closed with 4001 when a new host joins');
  await sleep(500);
  assert(!phoneA.has((m) => m?.relay === 'peer-left' && m.role === 'host'), 'phones not told "host left" on replacement');
  assert(phoneA.has((m) => m?.relay === 'peer-joined' && m.role === 'host'), 'phones told the new host joined');
  host2.send(JSON.stringify({ type: 'from-host2' }));
  assert((await phoneA.waitFor((m) => m?.type === 'from-host2')) !== null, 'new host -> phone delivered');

  host2.close();
  assert((await phoneA.waitFor((m) => m?.relay === 'peer-left' && m.role === 'host')) !== null, 'phones told when the host leaves');

  for (const c of [phoneA, phoneB]) c.close();
}

let relay: ChildProcess | null = null;
try {
  if (!process.env.RELAY_URL) {
    console.log('Starting wrangler dev...');
    relay = await startLocalRelay();
  }
  await runTests();
} catch (err) {
  console.error('  ❌ ERROR:', err);
  failed++;
} finally {
  if (relay) stopLocalRelay(relay);
}

console.log('\n' + '='.repeat(75));
console.log(`Result: ${passed} passed, ${failed} failed`);
console.log('='.repeat(75));
process.exit(failed > 0 ? 1 : 0);
