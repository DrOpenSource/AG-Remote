// Extension relay transport tests (src/relay-host/): RelayStore persistence, and RelayHost answering an
// end-to-end encrypted phone through an in-memory relay (routes like relay/src/room.ts) against a real
// SessionManager, the same one the local HTTP server uses.
import fs from 'fs';
import path from 'path';
import { AntigravityAdapter } from '../src/adapter-antigravity/index.ts';
import { SessionManager } from '../src/core/session-manager.ts';
import { handlePhoneApi } from '../src/server/api.ts';
import { RelayHost } from '../src/relay-host/relay-host.ts';
import { RelayStore } from '../src/relay-host/relay-store.ts';
import { PhoneE2E, generateIdentity } from '../src/pwa/e2e.js';
import crypto from 'crypto';
import { encryptPayload, vapidAuthorization, generateVapidKeys, sendPush } from '../src/relay-host/web-push.ts';

console.log('='.repeat(75));
console.log('🧪 RELAY TRANSPORT (EXTENSION SIDE) TEST SUITE (PHASE 3)');
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
async function until(pred: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) await sleep(10);
  return pred();
}

// ---------- in-memory relay ----------

type Listener = (e: any) => void;

class FakeNet {
  hosts = new Map<string, FakeSocket>(); // room -> host socket
  phones = new Map<string, Map<string, (text: string) => void>>(); // room -> phone id -> deliver
  hostFrames: string[] = [];
  urls: string[] = [];
  refuse = false;
  private nextPhone = 1;

  impl(): typeof WebSocket {
    const net = this;
    return class extends FakeSocket {
      constructor(url: string) {
        super(url, net);
      }
    } as any;
  }

  room(url: string) {
    return new URL(url).pathname.split('/')[2];
  }

  /** A phone in `room`; returns its send function. */
  addPhone(room: string, deliver: (text: string) => void) {
    const id = `phone-${this.nextPhone++}`;
    if (!this.phones.has(room)) this.phones.set(room, new Map());
    this.phones.get(room)!.set(id, deliver);
    return {
      id,
      send: (text: string) => this.hosts.get(room)?.emit('message', { data: JSON.stringify({ from: id, d: text }) }),
    };
  }
}

class FakeSocket {
  readyState = 0;
  url: string;
  net: FakeNet;
  listeners: Record<string, Listener[]> = { open: [], message: [], close: [], error: [] };

  constructor(url: string, net: FakeNet) {
    this.url = url;
    this.net = net;
    net.urls.push(url);
    setImmediate(() => {
      if (net.refuse) {
        this.readyState = 3;
        this.emit('close', { code: 1006 });
        return;
      }
      const room = net.room(url);
      const old = net.hosts.get(room);
      net.hosts.set(room, this);
      if (old) old.serverClose(4001);
      this.readyState = 1;
      this.emit('open', {});
    });
  }

  addEventListener(type: string, fn: Listener) {
    this.listeners[type].push(fn);
  }

  emit(type: string, e: any) {
    for (const fn of this.listeners[type]) fn(e);
  }

  send(text: string) {
    this.net.hostFrames.push(text);
    if (text === 'ping') return;
    const frame = JSON.parse(text);
    const phones = this.net.phones.get(this.net.room(this.url)) || new Map();
    const targets = typeof frame.to === 'string' ? [phones.get(frame.to)].filter(Boolean) : [...phones.values()];
    for (const deliver of targets) setImmediate(() => deliver!(frame.d));
  }

  close(code = 1000) {
    this.serverClose(code);
  }

  serverClose(code: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const room = this.net.room(this.url);
    if (this.net.hosts.get(room) === this) this.net.hosts.delete(room);
    setImmediate(() => this.emit('close', { code }));
  }
}

async function makePhone(net: FakeNet, room: string, hostPub: string | null = null, identity?: any) {
  const got: any[] = [];
  const rejects: string[] = [];
  let phone: PhoneE2E;
  const link = net.addPhone(room, (text) => phone.handleRelay(text));
  phone = new PhoneE2E({
    room,
    identity: identity || (await generateIdentity()),
    hostPub,
    send: link.send,
    onMessage: (m: any) => got.push(m),
    onReject: (r: string) => rejects.push(r),
  });
  let nextId = 1;
  const request = async (method: string, p: string, body?: unknown) => {
    const id = nextId++;
    await phone.send({ k: 'req', id, method, path: p, body });
    await until(() => got.some((m) => m.k === 'res' && m.id === id));
    return got.find((m) => m.k === 'res' && m.id === id);
  };
  return { phone, got, rejects, request, id: link.id, send: link.send };
}

function parsePairUrl(url: string) {
  const u = new URL(url);
  return { origin: u.origin, room: u.pathname.split('/')[2], secret: u.hash.slice(1) };
}

async function runTests() {
  const dir = path.join(process.env.AG_REMOTE_DATA_DIR || '.logs/test', `relay-host-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });

  console.log('\n[1] RelayStore');
  const store = await RelayStore.load(dir);
  const file = path.join(dir, 'relay.json');
  assert(fs.existsSync(file), 'relay.json created on first load');
  assert(/^[A-Za-z0-9_-]{22}$/.test(store.room) && !!store.identity?.pub, 'fresh room id and key generated');
  const again = await RelayStore.load(dir);
  assert(again.room === store.room && again.identity.pub === store.identity.pub, 'same room and key after reload (survives restarts and hand-over)');
  fs.writeFileSync(file, '{not json');
  const recovered = await RelayStore.load(dir);
  assert(recovered.room !== store.room && fs.readFileSync(file, 'utf8').startsWith('{'), 'corrupt file is replaced with a fresh identity');

  console.log('\n[2] Connecting and pairing');
  const adapter = new AntigravityAdapter(process.cwd());
  const sm = new SessionManager(adapter);
  await sm.start();
  const net = new FakeNet();
  const statuses: string[] = [];
  const pairedNames: string[] = [];
  const asked: { id: string; name: string; code: string }[] = [];
  const pushes: { endpoint: string; payload: any }[] = [];
  let pushResult: 'sent' | 'gone' | 'failed' = 'sent';
  const relayStore = await RelayStore.load(dir);
  const host = new RelayHost({
    relayUrl: 'https://relay.example/',
    store: relayStore,
    sessionManager: sm,
    onStatus: (s) => statuses.push(s),
    onPaired: (p) => pairedNames.push(p.name),
    onApprovalNeeded: (r) => asked.push(r),
    WebSocketImpl: net.impl(),
    sendPushImpl: async (sub, payload) => {
      pushes.push({ endpoint: sub.endpoint, payload });
      return pushResult;
    },
    doneDelayMs: 150,
  });
  const baseListeners = sm.listenerCount('adapter_event');
  host.start();
  assert(sm.listenerCount('adapter_event') === baseListeners + 1, 'start() subscribes to IDE events');
  await until(() => host.getStatus() === 'online');
  assert(host.getStatus() === 'online', 'host connects to the relay');
  assert(net.urls[0] === `wss://relay.example/ws/${relayStore.room}?role=host`, 'dials wss://<relay>/ws/<room>?role=host');

  const pairRes = await host.createPairingUrl();
  const pairUrl = typeof pairRes === 'string' ? pairRes : pairRes.url;
  const { origin, room, secret } = parsePairUrl(pairUrl);
  assert(origin === 'https://relay.example' && room === relayStore.room && secret.length === 43, 'pairing URL is https://<relay>/p/<room>#<secret>');
  const a = await makePhone(net, room);
  const aPairing = a.phone.pair(secret, 'Test phone');
  await until(() => asked.length === 1);
  assert(asked[0]?.name === 'Test phone' && /^\d{4}$/.test(asked[0].code), 'IDE is asked to allow the new phone, with its name and check code');
  assert(host.pendingApprovals().length === 1 && host.pairedPhones().length === 0, 'waiting phone is listed but not paired yet');
  assert(!JSON.stringify(host.pendingApprovals()).includes(a.phone.identity.pub), 'waiting list for the IDE shows no keys');
  assert(host.answerApproval(asked[0].id, true), 'IDE allows it');
  const hostPub = await aPairing;
  await a.phone.connect();
  await until(() => host.connectedPhones() === 1);
  assert(hostPub === relayStore.identity.pub && pairedNames[0] === 'Test phone', 'phone pairs; IDE is notified with its name');
  const reloaded = await RelayStore.load(dir);
  assert(reloaded.get(a.phone.identity.pub)?.name === 'Test phone', 'paired phone saved to relay.json');

  console.log('\n[3] API over the relay matches the local server');
  const windows = await a.request('GET', '/api/windows');
  const direct = await handlePhoneApi(sm, 'GET', '/api/windows', new URLSearchParams(), undefined);
  assert(windows?.status === 200 && JSON.stringify(windows.body) === JSON.stringify(direct?.body), 'GET /api/windows: same answer as the HTTP route');
  const state = await a.request('GET', '/api/state');
  assert(state?.status === 200 && typeof state.body?.status === 'string', 'GET /api/state returns a snapshot');
  const empty = await a.request('POST', '/api/prompt', { text: '  ' });
  assert(empty?.status === 400 && /non-empty/.test(empty.body?.error), 'validation errors come back as 400 with the message');
  const unknown = await a.request('GET', '/api/nope');
  assert(unknown?.status === 404, 'unknown route is 404');
  const hub = await a.request('POST', '/api/hub/register', { windowId: 'x', workspacePath: 'y' });
  assert(hub?.status === 404 && sm.listWindows().every((w: any) => w.windowId !== 'x'), 'window-coordination (hub) routes are not reachable over the relay');
  const before = a.got.length;
  await a.phone.send({ k: 'req', id: 999, method: 'GET', path: '/pair?t=123456' });
  await sleep(200);
  assert(a.got.length === before, 'non-/api paths are ignored (no PIN exchange over the relay)');

  console.log('\n[4] IDE events reach the phone');
  sm.emit('adapter_event', { type: 'status_changed', status: 'generating' } as any);
  await until(() => a.got.some((m) => m.k === 'evt'));
  const evt = a.got.find((m) => m.k === 'evt');
  assert(evt?.event?.type === 'status_changed' && evt.event.status === 'generating', 'adapter events are pushed as {k:"evt"}');
  const plain = net.hostFrames.join('\n');
  assert(!plain.includes('status_changed') && !plain.includes('generating'), 'event content is encrypted on the wire');

  console.log('\n[4b] Notifications');
  const keyRes = await a.request('GET', '/api/push/key');
  assert(keyRes?.status === 200 && keyRes.body?.key === relayStore.vapid.publicKey && Buffer.from(keyRes.body.key, 'base64url').length === 65, 'phone gets the PC\'s push (VAPID) public key');
  const ua = crypto.createECDH('prime256v1');
  const uaKeys = { p256dh: ua.generateKeys().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  const evil = await a.request('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://evil.example/x', keys: uaKeys } });
  assert(evil?.status === 400 && !relayStore.get(a.phone.identity.pub)?.push, 'subscription to a non-push-service URL is refused (PC never posts to arbitrary URLs)');
  const endpoint = 'https://fcm.googleapis.com/fcm/send/test-endpoint';
  const sub = await a.request('POST', '/api/push/subscribe', { subscription: { endpoint, keys: uaKeys, expirationTime: null } });
  assert(sub?.status === 200 && relayStore.get(a.phone.identity.pub)?.push?.endpoint === endpoint, 'subscription stored for this phone');
  assert((await RelayStore.load(dir)).get(a.phone.identity.pub)?.push?.endpoint === endpoint, 'subscription saved to relay.json');
  assert(!('push' in host.pairedPhones()[0]), 'phone list for the IDE does not expose the subscription');

  await a.request('POST', '/api/push/visible', { visible: true });
  sm.emit('adapter_event', { type: 'approval_requested', approval: { id: 'ap1' } } as any);
  await sleep(100);
  assert(pushes.length === 0, 'no push while the phone app is on screen');
  await a.request('POST', '/api/push/visible', { visible: false });
  sm.emit('adapter_event', { type: 'approval_requested', approval: { id: 'ap2', kind: 'run_command', description: 'Run SECRET_DESC', detail: 'curl -H "token: SECRET_CMD"', cwd: '/home/SECRET_DIR' } } as any);
  await until(() => pushes.length === 1);
  assert(pushes[0]?.endpoint === endpoint && pushes[0].payload.kind === 'approval' && pushes[0].payload.url === `/p/${relayStore.room}`, 'approval needed: push sent when the app is in the background');
  assert(pushes[0].payload.ask === 'command', 'push says what kind of request it is (a command)');
  assert(!/ap2|SECRET/.test(JSON.stringify(pushes[0].payload)), 'push carries no command, description, folder or approval id (it can show on a locked screen)');
  assert(/^[\w-]{10}$/.test(pushes[0].payload.win) && typeof pushes[0].payload.at === 'number' && typeof pushes[0].payload.ws === 'string', 'push has the project name, a short window key and the time');

  // Unencrypted presence frame (zero latency / background sleep safeguard)
  a.send(JSON.stringify({ t: 'vis', v: true }));
  await sleep(20);
  sm.emit('adapter_event', { type: 'approval_requested', approval: { id: 'ap-vis-1' } } as any);
  await sleep(100);
  assert(pushes.length === 1, 'unencrypted vis:true frame suppresses push without async encryption delay');
  a.send(JSON.stringify({ t: 'vis', v: false }));
  await sleep(20);
  sm.emit('adapter_event', { type: 'status_changed', status: 'generating' } as any);
  sm.emit('adapter_event', { type: 'status_changed', status: 'idle' } as any);
  await until(() => pushes.length === 2);
  assert(pushes[1]?.payload.kind === 'done', 'task finished (generating -> idle): push sent');
  sm.emit('adapter_event', { type: 'status_changed', status: 'idle' } as any);
  await sleep(250);
  assert(pushes.length === 2, 'idle -> idle sends nothing');

  // The agent pausing between steps is not "finished".
  sm.emit('adapter_event', { type: 'status_changed', status: 'generating' } as any);
  sm.emit('adapter_event', { type: 'status_changed', status: 'idle' } as any);
  await sleep(50);
  sm.emit('adapter_event', { type: 'status_changed', status: 'generating' } as any);
  await sleep(250);
  assert(pushes.length === 2, 'idle for a moment, then working again: no "finished" push');
  sm.emit('adapter_event', { type: 'status_changed', status: 'idle' } as any);
  await until(() => pushes.length === 3);
  await sleep(250);
  assert(pushes.length === 3 && pushes[2].payload.kind === 'done', 'stays idle: exactly one "finished" push');
  sm.emit('adapter_event', { type: 'status_changed', status: 'generating' } as any);
  sm.emit('adapter_event', { type: 'status_changed', status: 'idle' } as any);
  sm.emit('adapter_event', { type: 'approval_requested', approval: { id: 'ap-q', kind: 'ask_question', question: 'Which DB?', options: ['a', 'b'] } } as any);
  await until(() => pushes.length === 4);
  await sleep(250);
  assert(pushes.length === 4 && pushes[3].payload.kind === 'approval' && pushes[3].payload.ask === 'question', 'a question right after a run cancels its "finished" push and says it is a question');
  assert(!JSON.stringify(pushes[3].payload).includes('Which DB'), 'the question text is not in the push');

  // One notification per project: same window, same key; another window, another key.
  sm.emit('adapter_event', { type: 'approval_requested', windowId: 'win-A', approval: { id: 'a1', kind: 'write_to_file' } } as any);
  sm.emit('adapter_event', { type: 'approval_requested', windowId: 'win-B', approval: { id: 'b1', kind: 'replace_file_content' } } as any);
  sm.emit('adapter_event', { type: 'approval_requested', windowId: 'win-A', approval: { id: 'a2', kind: 'run_command' } } as any);
  await until(() => pushes.length === 7);
  const [pA1, pB1, pA2] = pushes.slice(4, 7).map((p) => p.payload);
  assert(pA1.win === pA2.win && pA1.win !== pB1.win && pA1.win !== pushes[3].payload.win, 'each project window gets its own notification key');
  assert(pA1.ask === 'new-file' && pB1.ask === 'edit-file', 'new file and file edit are told apart');
  pushResult = 'gone';
  sm.emit('adapter_event', { type: 'approval_requested', approval: { id: 'ap3' } } as any);
  await until(() => !relayStore.get(a.phone.identity.pub)?.push);
  assert(!relayStore.get(a.phone.identity.pub)?.push, 'subscription the push service says is gone is forgotten');
  pushResult = 'sent';
  await a.request('POST', '/api/push/subscribe', { subscription: { endpoint, keys: uaKeys } });
  const off = await a.request('POST', '/api/push/unsubscribe', {});
  assert(off?.status === 200 && !relayStore.get(a.phone.identity.pub)?.push, 'phone can turn notifications off');

  // A push waiting for a sleeping phone is replaced only by a newer one for the same project.
  const realFetch = globalThis.fetch;
  const topics: string[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    topics.push(init.headers.Topic);
    return new Response(null, { status: 201 });
  }) as any;
  try {
    const vk = generateVapidKeys();
    await sendPush({ endpoint, keys: uaKeys }, { kind: 'approval', win: 'abcDEF12_-' }, vk, 'https://relay.example');
    await sendPush({ endpoint, keys: uaKeys }, { kind: 'done', win: 'abcDEF12_-' }, vk, 'https://relay.example');
    await sendPush({ endpoint, keys: uaKeys }, { kind: 'done' }, vk, 'https://relay.example');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert(topics[0] === 'ag-abcDEF12_-' && topics[1] === topics[0] && topics[2] === 'ag-done', 'push topic is per project (approval and finished share it); old payloads keep the old topic');

  // Encryption (RFC 8291) and signing (RFC 8292), checked from the phone's and push service's side.
  const plaintext = '{"kind":"approval"}';
  const body = encryptPayload({ endpoint, keys: uaKeys }, Buffer.from(plaintext));
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(uaKeys.p256dh, 'base64url'), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(uaKeys.auth, 'base64url'), keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const ct = body.subarray(21 + idlen);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  const opened = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
  assert(body.readUInt32BE(16) === 4096 && opened.toString() === plaintext + '\x02', 'payload decrypts on the phone side (aes128gcm)');
  const vapid = generateVapidKeys();
  const auth = vapidAuthorization(endpoint, vapid, 'https://relay.example');
  const [, jwt, k] = auth.match(/^vapid t=([^,]+), k=(.+)$/)!;
  const [h, c, sig] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  const pub = Buffer.from(k, 'base64url');
  const verifyKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  const sigOk = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: verifyKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  assert(sigOk && claims.aud === 'https://fcm.googleapis.com' && claims.exp > Date.now() / 1000 && claims.sub === 'https://relay.example', 'VAPID JWT is signed by the PC key, scoped to the push service');

  console.log('\n[5] Unpairing');
  const b = await makePhone(net, room);
  const newSecret = () => host.createPairingUrl().then((u) => parsePairUrl(typeof u === 'string' ? u : u.url).secret);
  const no = await makePhone(net, room);
  const noPairing = no.phone.pair(await newSecret(), 'Not mine').catch((e) => e?.code);
  await until(() => asked.length === 2);
  host.answerApproval(asked[1].id, false);
  assert((await noPairing) === 'denied' && host.pairedPhones().length === 1, 'denied phone is refused and not saved');
  assert(!(await RelayStore.load(dir)).get(no.phone.identity.pub), 'denied phone is not in relay.json');
  const bPairing = b.phone.pair(await newSecret(), 'Second phone');
  await until(() => asked.length === 3);
  host.answerApproval(asked[2].id, true);
  await bPairing;
  await b.phone.connect();
  await until(() => host.connectedPhones() === 2);
  await host.revoke(b.phone.identity.pub);
  await until(() => b.rejects.includes('revoked'));
  assert(b.rejects.includes('revoked') && host.pairedPhones().length === 1, 'revoking one phone disconnects only that phone');

  const oldRoom = relayStore.room;
  const urlsBefore = net.urls.length;
  await host.revokeAll();
  await until(() => host.getStatus() === 'online' && net.urls.length > urlsBefore);
  assert(relayStore.room !== oldRoom && host.pairedPhones().length === 0, 'revoke all: new room, no paired phones');
  assert(net.urls.at(-1)!.includes(relayStore.room), 'host reconnects in the new room');
  assert(a.rejects.includes('revoked'), 'remaining phone told it was revoked');
  const stale = await makePhone(net, oldRoom, hostPub, a.phone.identity);
  await sleep(100);
  assert(!net.hosts.has(oldRoom), 'nobody answers in the old room any more');
  stale.phone.connect().catch(() => {});

  console.log('\n[6] Connection handling');
  net.hosts.get(relayStore.room)!.serverClose(1006);
  await until(() => statuses.at(-1) === 'offline');
  assert(statuses.at(-1) === 'offline', 'dropped connection shows as offline');
  await until(() => host.getStatus() === 'online', 4000);
  assert(host.getStatus() === 'online', 'reconnects by itself');

  // Another IDE window took over hosting: the relay replaces this connection (4001).
  const other = new (net.impl())(`wss://relay.example/ws/${relayStore.room}?role=host`);
  await until(() => host.getStatus() === 'replaced');
  const urlsAtReplace = net.urls.length;
  await sleep(1500);
  assert(host.getStatus() === 'replaced' && net.urls.length === urlsAtReplace, 'replaced by another window: does not fight it for the room');
  (other as any).close();

  host.stop();
  await sleep(50);
  assert(host.getStatus() === 'stopped', 'stop() reports stopped');
  assert(sm.listenerCount('adapter_event') === baseListeners, 'stop() removes its IDE event listener');

  await sm.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

try {
  await runTests();
} catch (err) {
  console.error('  ❌ ERROR:', err);
  failed++;
}

console.log('\n' + '='.repeat(75));
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log('='.repeat(75));
process.exit(failed > 0 ? 1 : 0);
