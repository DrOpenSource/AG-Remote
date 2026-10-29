// Relay test suite. Uses Node's built-in WebSocket, no extra dependencies.
// With RELAY_URL unset it starts `wrangler dev` on port 8787 and stops it afterwards.
// Against a deployed relay: RELAY_URL=https://remote.taqnik.in npm test
import { spawn, execSync, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import { HostE2E, PhoneE2E, MemoryPhoneRegistry, generateIdentity } from '../../src/pwa/e2e.js';

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

  raw: string[] = [];
  onRaw: ((text: string) => void) | null = null;

  constructor(room: string, role: 'host' | 'phone') {
    this.ws = new WebSocket(`${WS_BASE}/ws/${room}?role=${role}`);
    this.ws.addEventListener('message', (e) => {
      const data = String(e.data);
      this.raw.push(data);
      this.onRaw?.(data);
      let parsed: any = data;
      try {
        parsed = JSON.parse(data);
      } catch {}
      // Host frames from phones arrive as {"from":id,"d":text}; unwrap for easy matching.
      if (role === 'host' && typeof parsed?.from === 'string' && typeof parsed.d === 'string') {
        let inner: any;
        try {
          inner = JSON.parse(parsed.d);
        } catch {}
        parsed = inner && typeof inner === 'object' ? { ...inner, _from: parsed.from } : { _raw: parsed.d, _from: parsed.from };
      }
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

  send(data: string | Uint8Array) {
    this.ws.send(data);
  }

  /** Host only: wraps a message in the relay's {"to","d"} frame. */
  sendTo(obj: unknown, to?: string) {
    this.ws.send(JSON.stringify(to ? { to, d: JSON.stringify(obj) } : { d: JSON.stringify(obj) }));
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

  console.log('\n[1b] Phone app');
  const pageRes = await fetch(`${BASE}/p/${newRoom()}`);
  const pageHtml = await pageRes.text();
  assert(pageRes.status === 200 && pageHtml.includes('/app.js'), '/p/<room> serves the phone app');
  const csp = pageRes.headers.get('content-security-policy') || '';
  assert(csp.includes("default-src 'self'") && csp.includes("frame-ancestors 'none'"), 'page has a strict Content-Security-Policy');
  assert(pageRes.headers.get('referrer-policy') === 'no-referrer', 'page sends no referrer');
  assert((await fetch(`${BASE}/p/short`)).status === 404, '/p/ with a malformed room is 404');
  for (const file of ['/app.js', '/e2e.js', '/relay-link.js', '/app.css', '/sw.js', '/manifest.json']) {
    const r = await fetch(`${BASE}${file}`);
    await r.arrayBuffer();
    assert(r.status === 200, `${file} served`);
  }
  const e2eJs = await fetch(`${BASE}/e2e.js`);
  assert(/javascript/.test(e2eJs.headers.get('content-type') || '') && (await e2eJs.text()).includes('class PhoneE2E'), 'e2e.js served as JavaScript (the module the phone imports)');
  assert((await fetch(`${BASE}/api/state`)).status === 404, 'local-server API paths do not exist on the relay');

  console.log('\n[1c] Short pairing codes');
  const codeBad = await fetch(`${BASE}/code`, { method: 'POST', body: 'invalid json' });
  assert(codeBad.status === 400, 'POST /code with invalid json returns 400');
  const testRoom = newRoom();
  const testFragment = 'test-secret-fragment-12345';
  const codeRes = await fetch(`${BASE}/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: testRoom, fragment: testFragment }),
  });
  assert(codeRes.status === 200, 'POST /code stores code successfully');
  const codeJson = (await codeRes.json()) as { code: string };
  assert(typeof codeJson.code === 'string' && codeJson.code.length === 6, 'generated code is 6 characters');

  const lookupRes = await fetch(`${BASE}/code/${codeJson.code}`);
  assert(lookupRes.status === 200, 'GET /code/<code> resolves successfully');
  const lookupJson = (await lookupRes.json()) as { room: string; fragment: string };
  assert(lookupJson.room === testRoom && lookupJson.fragment === testFragment, 'resolved room and fragment match');

  const secondLookup = await fetch(`${BASE}/code/${codeJson.code}`);
  assert(secondLookup.status === 404, 'second lookup returns 404 (single-use code)');

  const unknownLookup = await fetch(`${BASE}/code/ZZZZZZ`);
  assert(unknownLookup.status === 404, 'unknown code returns 404');

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
  const idA = phoneA.messages[0].you;
  host.sendTo({ type: 'snapshot', n: 1 });
  assert((await phoneA.waitFor((m) => m?.type === 'snapshot'))?.n === 1, 'host -> phone delivered (d unwrapped)');
  phoneA.send(JSON.stringify({ type: 'approve', id: 'x' }));
  const fromA = await host.waitFor((m) => m?.type === 'approve');
  assert(fromA?.id === 'x' && fromA._from === idA, 'phone -> host delivered, stamped with the sender id');

  const phoneB = await connect(room, 'phone');
  const idB = phoneB.messages[0].you;
  assert(phoneB.messages[0].peers.length === 1, 'second phone sees only the host, not the other phone');
  await host.waitFor((m) => m?.relay === 'peer-joined' && m.peer === idB);
  phoneA.send(JSON.stringify({ type: 'from-a' }));
  await host.waitFor((m) => m?.type === 'from-a');
  await sleep(300);
  assert(!phoneB.has((m) => m?.type === 'from-a'), 'phone -> phone is never forwarded');
  assert(!phoneB.has((m) => m?.relay === 'peer-joined' && m.role === 'phone'), 'phones are not told about other phones');
  host.sendTo({ type: 'to-all' });
  assert(
    (await phoneA.waitFor((m) => m?.type === 'to-all')) !== null && (await phoneB.waitFor((m) => m?.type === 'to-all')) !== null,
    'host message without "to" reaches every phone'
  );
  host.sendTo({ type: 'only-b' }, idB);
  await phoneB.waitFor((m) => m?.type === 'only-b');
  await sleep(300);
  assert(phoneB.has((m) => m?.type === 'only-b') && !phoneA.has((m) => m?.type === 'only-b'), 'host message with "to" reaches only that phone');

  host.sendTo({ relay: 'peer-left', role: 'host', peer: 'fake' });
  host.send('not json');
  await sleep(300);
  assert(!phoneA.has((m) => m?.peer === 'fake'), 'host cannot fake a relay presence message');
  assert(host.closeCode === null, 'malformed host frame is ignored, not fatal');
  phoneA.send('{"relay":"peer-left","role":"phone","peer":"fake"}');
  const spoof = await host.waitFor((m) => m?.relay === 'peer-left' && m.peer === 'fake');
  assert(spoof?._from === idA, 'phone cannot fake one either (arrives wrapped with its id)');

  phoneA.send('ping');
  assert((await phoneA.waitFor((m) => m === 'pong')) === 'pong', 'ping answered with pong');

  const other = newRoom();
  const otherHost = await connect(other, 'host');
  host.sendTo({ type: 'room-isolation' });
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
  assert((await phoneC.waitClosed()) === 4004, 'phone sending more than 200 messages in 10 s closed with 4004');

  // The host gets 4x the phone budget (one encrypted copy per phone).
  for (let i = 0; i < 300; i++) host.sendTo({ type: 'host-burst', i }, idA);
  await phoneA.waitFor((m) => m?.type === 'host-burst' && m.i === 299, 5000);
  assert(host.closeCode === null, 'host may send 300 messages in 10 s');

  const binary = await connect(room, 'phone');
  binary.send(new Uint8Array([1, 2, 3]));
  assert((await binary.waitClosed()) === 4005, 'binary frame closed with 4005 (text only)');

  console.log('\n[5] Leaving and host replacement');
  const left = await host.waitFor((m) => m?.relay === 'peer-left' && m.role === 'phone');
  assert(left !== null, 'host told when a phone leaves');

  const host2 = await connect(room, 'host');
  assert((await host.waitClosed()) === 4001, 'old host closed with 4001 when a new host joins');
  await sleep(500);
  assert(!phoneA.has((m) => m?.relay === 'peer-left' && m.role === 'host'), 'phones not told "host left" on replacement');
  assert(phoneA.has((m) => m?.relay === 'peer-joined' && m.role === 'host'), 'phones told the new host joined');
  host2.sendTo({ type: 'from-host2' });
  assert((await phoneA.waitFor((m) => m?.type === 'from-host2')) !== null, 'new host -> phone delivered');

  host2.close();
  assert((await phoneA.waitFor((m) => m?.relay === 'peer-left' && m.role === 'host')) !== null, 'phones told when the host leaves');

  for (const c of [phoneA, phoneB]) c.close();

  console.log('\n[6] End-to-end encryption through the relay');
  const e2eRoom = newRoom();
  const marker = 'PLAINTEXT-MARKER-' + crypto.randomBytes(4).toString('hex');
  const seen: string[] = []; // every frame either side sent or received
  const hostWs = await connect(e2eRoom, 'host');
  const phoneWs = await connect(e2eRoom, 'phone');
  const hostGot: any[] = [];
  const phoneGot: any[] = [];
  const e2eHost = new HostE2E({
    room: e2eRoom,
    identity: await generateIdentity({ extractable: true }),
    phones: new MemoryPhoneRegistry(),
    send: (t: string) => (seen.push(t), hostWs.send(t)),
    onMessage: (_id: string, obj: any) => hostGot.push(obj),
  });
  const e2ePhone = new PhoneE2E({
    room: e2eRoom,
    identity: await generateIdentity(),
    send: (t: string) => (seen.push(t), phoneWs.send(t)),
    onMessage: (obj: any) => phoneGot.push(obj),
  });
  hostWs.onRaw = (t) => (seen.push(t), e2eHost.handleRelay(t));
  phoneWs.onRaw = (t) => (seen.push(t), e2ePhone.handleRelay(t));

  const secret = await e2eHost.startPairing();
  assert((await e2ePhone.pair(secret, 'test phone')) === e2eHost.identity.pub, 'phone paired through the relay');
  await e2ePhone.connect();
  assert(e2ePhone.ready, 'encrypted session established through the relay');
  await e2ePhone.send({ type: 'prompt', text: marker });
  await e2eHost.broadcast({ type: 'message', text: marker + '-reply' });
  const deadline = Date.now() + 3000;
  while ((hostGot.length < 1 || phoneGot.length < 1) && Date.now() < deadline) await sleep(20);
  assert(hostGot[0]?.text === marker, 'laptop decrypted the phone message');
  assert(phoneGot[0]?.text === marker + '-reply', 'phone decrypted the laptop message');
  const wire = seen.join('\n');
  assert(seen.length >= 8, `checked ${seen.length} frames on the wire`);
  assert(!wire.includes(marker) && !wire.includes(secret) && !wire.includes('prompt'), 'no plaintext, message type or pairing secret on the wire');

  hostWs.close();
  phoneWs.close();

  // Last, so the per-IP limit it trips can't affect the sections above. Local only: against a
  // deployed relay it would lock the tester's IP out of code lookups for a minute.
  if (!process.env.RELAY_URL) {
    console.log('\n[7] Per-IP limits');
    let codeStatus = 0;
    for (let i = 0; i < 12 && codeStatus !== 429; i++) {
      const r = await fetch(`${BASE}/code/ZZZZZZ`);
      await r.arrayBuffer();
      codeStatus = r.status;
    }
    assert(codeStatus === 429, 'code lookups beyond 10 a minute from one IP get 429 (guessing is throttled)');
    const fresh = await connect(newRoom(), 'phone');
    assert(fresh.messages[0]?.relay === 'hello', 'WebSocket connections have their own budget (still allowed)');
    fresh.close();
  }
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
