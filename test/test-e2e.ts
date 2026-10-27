// E2E encryption + pairing tests (src/e2e/e2e.js) over an in-memory relay that routes like
// relay/src/room.ts and records every frame it forwards, so we can check it never saw plaintext.
import {
  HostE2E,
  PhoneE2E,
  MemoryPhoneRegistry,
  generateIdentity,
  exportIdentity,
  importIdentity,
  newRoomId,
  toB64u,
  fromB64u,
  randomBytes,
  PAIRING_TTL_MS,
  MAX_PAIRING_FAILURES,
} from '../src/e2e/e2e.js';

console.log('='.repeat(75));
console.log('🧪 E2E ENCRYPTION & PAIRING TEST SUITE (PHASE 2)');
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

async function rejectsWith(p: Promise<unknown>, code: string): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (err: any) {
    if (err?.code !== code) console.error(`     (got ${err?.code ?? err})`);
    return err?.code === code;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// WebCrypto runs on a worker thread, so give in-flight frames real time to land.
const settle = () => sleep(100);
async function until(pred: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) await sleep(10);
  return pred();
}

const SECRET_MARKER = 'PLAINTEXT-MARKER-7f3a9c';

/** Routes like the real relay. `tamper` can rewrite or drop a frame on its way through. */
class FakeRelay {
  frames: string[] = [];
  host: HostE2E | null = null;
  phones = new Map<string, PhoneE2E>();
  tamper: ((dir: 'p2h' | 'h2p', text: string) => string | null) | null = null;
  lastFrom = new Map<string, string>(); // phone id -> last raw text it sent
  private nextId = 1;

  hostSend = (text: string) => {
    this.frames.push(text);
    const frame = JSON.parse(text);
    if (typeof frame.d !== 'string' || frame.d.startsWith('{"relay"')) return;
    const targets = typeof frame.to === 'string' ? [frame.to] : [...this.phones.keys()];
    for (const id of targets) {
      const d = this.tamper ? this.tamper('h2p', frame.d) : frame.d;
      if (d !== null) setImmediate(() => this.phones.get(id)?.handleRelay(d));
    }
  };

  phoneSender(id: string) {
    return (text: string) => {
      this.frames.push(text);
      this.lastFrom.set(id, text);
      const d = this.tamper ? this.tamper('p2h', text) : text;
      if (d !== null) this.deliverToHost(id, d);
    };
  }

  deliverToHost(id: string, d: string) {
    setImmediate(() => this.host?.handleRelay(JSON.stringify({ from: id, d })));
  }

  newPhoneId() {
    return `peer-${this.nextId++}`;
  }

  leave(id: string) {
    this.phones.delete(id);
    setImmediate(() => this.host?.handleRelay(JSON.stringify({ relay: 'peer-left', role: 'phone', peer: id })));
  }
}

interface Setup {
  relay: FakeRelay;
  room: string;
  host: HostE2E;
  hostIdentity: any;
  registry: MemoryPhoneRegistry;
  hostGot: { peerId: string; obj: any }[];
  ready: string[];
  clock: { t: number };
}

async function makeHost(opts: { identity?: any; registry?: MemoryPhoneRegistry; room?: string; relay?: FakeRelay } = {}): Promise<Setup> {
  const relay = opts.relay || new FakeRelay();
  const room = opts.room || newRoomId();
  const hostIdentity = opts.identity || (await generateIdentity({ extractable: true }));
  const registry = opts.registry || new MemoryPhoneRegistry();
  const hostGot: { peerId: string; obj: any }[] = [];
  const ready: string[] = [];
  const clock = { t: 1_000_000 };
  const host = new HostE2E({
    room,
    identity: hostIdentity,
    phones: registry,
    send: relay.hostSend,
    onMessage: (peerId: string, obj: any) => hostGot.push({ peerId, obj }),
    onPhoneReady: (peerId: string) => ready.push(peerId),
    now: () => clock.t,
  });
  relay.host = host;
  return { relay, room, host, hostIdentity, registry, hostGot, ready, clock };
}

async function makePhone(s: Setup, hostPub: string | null = null, identity?: any) {
  const id = s.relay.newPhoneId();
  const got: any[] = [];
  const rejects: string[] = [];
  const phone = new PhoneE2E({
    room: s.room,
    identity: identity || (await generateIdentity()),
    hostPub,
    send: s.relay.phoneSender(id),
    onMessage: (obj: any) => got.push(obj),
    onReject: (r: string) => rejects.push(r),
  });
  s.relay.phones.set(id, phone);
  return { id, phone, got, rejects };
}

async function runTests() {
  console.log('\n[1] Encoding and identities');
  const bytes = randomBytes(37);
  assert(toB64u(fromB64u(toB64u(bytes))) === toB64u(bytes), 'base64url round-trips');
  assert(/^[A-Za-z0-9_-]{22}$/.test(newRoomId()), 'room id is 22 base64url chars (relay format)');
  let threw = false;
  try {
    fromB64u('ab+/');
  } catch {
    threw = true;
  }
  assert(threw, 'non-base64url input rejected');
  const phoneId = await generateIdentity();
  assert(phoneId.privateKey.extractable === false, 'phone private key is non-extractable by default');

  console.log('\n[2] Pairing and first session');
  const s = await makeHost();
  const secret = await s.host.startPairing();
  assert(fromB64u(secret).length === 32, 'pairing secret is 32 random bytes');
  const a = await makePhone(s, null, phoneId);
  const hostPub = await a.phone.pair(secret, 'Pixel 9');
  assert(hostPub === s.hostIdentity.pub, 'phone learns the laptop key via pairing');
  assert(s.registry.get(phoneId.pub)?.name === 'Pixel 9', 'laptop saved the phone with its name');
  await a.phone.connect();
  // No wait here on purpose: the laptop hasn't seen the phone's confirmation yet, and must still send.
  await s.host.broadcast({ type: 'early', text: SECRET_MARKER });
  await until(() => a.got.some((m) => m.type === 'early'));
  assert(a.got.some((m) => m.type === 'early'), 'laptop message sent right after the phone connects still arrives');
  await settle();
  assert(a.phone.ready && s.ready.includes(a.id), 'handshake completes on both sides');

  await a.phone.send({ type: 'approve', note: SECRET_MARKER });
  await s.host.sendTo(a.id, { type: 'snapshot', text: SECRET_MARKER + '-from-host' });
  await settle();
  assert(s.hostGot.at(-1)?.obj?.note === SECRET_MARKER && s.hostGot.at(-1)?.peerId === a.id, 'phone -> laptop message decrypted');
  assert(a.got.at(-1)?.text === SECRET_MARKER + '-from-host', 'laptop -> phone message decrypted');

  // Not awaited one by one on purpose: sends race, and must still go out in order.
  await Promise.all(Array.from({ length: 50 }, (_, i) => s.host.sendTo(a.id, { type: 'burst', i })));
  await until(() => a.got.filter((m) => m.type === 'burst').length >= 50);
  const burst = a.got.filter((m) => m.type === 'burst').map((m) => m.i);
  assert(burst.length === 50 && burst.every((v, i) => v === i), '50 back-to-back messages arrive complete and in order');

  console.log('\n[3] The relay never sees plaintext');
  const all = s.relay.frames.join('\n');
  assert(s.relay.frames.length > 50, `relay recorded ${s.relay.frames.length} frames`);
  assert(!all.includes(SECRET_MARKER), 'no message content in any relayed frame');
  assert(!all.includes(secret), 'pairing secret never sent through the relay');
  assert(!all.includes('snapshot') && !all.includes('approve') && !all.includes('burst'), 'message types are hidden too');
  const jwk = (await exportIdentity(s.hostIdentity)).jwk;
  assert(!all.includes(jwk.d), "laptop's private key never sent");

  console.log('\n[4] Pairing secret rules');
  const b = await makePhone(s);
  assert(await rejectsWith(b.phone.pair(secret, 'reuse'), 'no-pairing'), 'used secret cannot pair a second phone');

  const s2 = await makeHost();
  const good = await s2.host.startPairing();
  for (let i = 0; i < MAX_PAIRING_FAILURES; i++) {
    const bad = await makePhone(s2);
    assert(await rejectsWith(bad.phone.pair(toB64u(randomBytes(32)), 'guess'), 'bad-secret'), `wrong secret rejected (try ${i + 1})`);
  }
  const late = await makePhone(s2);
  assert(await rejectsWith(late.phone.pair(good, 'real'), 'no-pairing'), `secret burned after ${MAX_PAIRING_FAILURES} wrong tries`);

  const s3 = await makeHost();
  const exp = await s3.host.startPairing();
  s3.clock.t += PAIRING_TTL_MS + 1;
  const tooLate = await makePhone(s3);
  assert(await rejectsWith(tooLate.phone.pair(exp, 'slow'), 'expired'), 'secret expires after 5 minutes');

  console.log('\n[5] Relay as attacker');
  // Swap the laptop key in the "paired" reply for the relay's own key.
  const s4 = await makeHost();
  const sec4 = await s4.host.startPairing();
  const evil = await generateIdentity();
  s4.relay.tamper = (dir, text) => {
    const m = JSON.parse(text);
    if (dir === 'h2p' && m.t === 'paired') return JSON.stringify({ ...m, pub: evil.pub });
    return text;
  };
  const victim = await makePhone(s4);
  assert(await rejectsWith(victim.phone.pair(sec4, 'victim'), 'bad-mac'), 'pairing reply with a swapped laptop key is refused');

  // Answer the phone's hello with the relay's own throwaway key.
  const s5 = await makeHost();
  const sec5 = await s5.host.startPairing();
  const p5 = await makePhone(s5);
  await p5.phone.pair(sec5, 'p5');
  s5.relay.tamper = (dir, text) => {
    const m = JSON.parse(text);
    if (dir === 'h2p' && m.t === 'welcome') return JSON.stringify({ ...m, eph: evil.pub });
    return text;
  };
  assert(await rejectsWith(p5.phone.connect(), 'bad-confirm'), 'handshake with a swapped throwaway key is refused');
  s5.relay.tamper = null;
  await p5.phone.connect();
  assert(p5.phone.ready, 'phone reconnects normally once the relay stops interfering');

  // Flip one character of a ciphertext.
  const before = s5.hostGot.length;
  s5.relay.tamper = (dir, text) => {
    const m = JSON.parse(text);
    if (dir === 'p2h' && m.t === 'enc') {
      const c = m.c[5] === 'A' ? 'B' : 'A';
      return JSON.stringify({ ...m, c: m.c.slice(0, 5) + c + m.c.slice(6) });
    }
    return text;
  };
  await p5.phone.send({ type: 'prompt', text: 'tampered' });
  await settle();
  assert(s5.hostGot.length === before, 'tampered message is not delivered');
  assert(p5.rejects.includes('bad-ciphertext') && !p5.phone.ready, 'laptop drops the session and the phone is told');
  s5.relay.tamper = null;

  // Replay a frame the phone sent earlier.
  await p5.phone.connect();
  await p5.phone.send({ type: 'approve', id: 'once' });
  await settle();
  const captured = s5.relay.lastFrom.get([...s5.relay.phones.keys()][0])!;
  const count = s5.hostGot.filter((m) => m.obj?.id === 'once').length;
  s5.relay.deliverToHost([...s5.relay.phones.keys()][0], captured);
  await settle();
  assert(count === 1 && s5.hostGot.filter((m) => m.obj?.id === 'once').length === 1, 'replayed approve is not run twice');

  // Pretend to be a paired phone using only its public key (which the relay has seen).
  const s6 = await makeHost();
  const sec6 = await s6.host.startPairing();
  const real = await makePhone(s6);
  await real.phone.pair(sec6, 'real');
  const fakeIdentity = { ...(await generateIdentity()), pub: real.phone.identity.pub };
  const impostor = await makePhone(s6, s6.hostIdentity.pub, fakeIdentity);
  assert(await rejectsWith(impostor.phone.connect(), 'bad-confirm'), 'impostor using a paired phone\'s public key is refused');
  await settle();
  assert(!s6.ready.includes(impostor.id), "laptop never treats the impostor as connected");

  console.log('\n[6] Unknown and revoked phones');
  const stranger = await makePhone(s, s.hostIdentity.pub);
  assert(await rejectsWith(stranger.phone.connect(), 'unknown-phone'), 'unpaired phone cannot start a session');

  await s.host.revoke(phoneId.pub);
  await settle();
  assert(a.rejects.includes('revoked') && !a.phone.ready, 'revoked phone is disconnected and told why');
  assert(await rejectsWith(a.phone.connect(), 'unknown-phone'), 'revoked phone cannot reconnect');

  console.log('\n[7] Two phones');
  const s7 = await makeHost();
  const x = await makePhone(s7);
  await x.phone.pair(await s7.host.startPairing(), 'x');
  await x.phone.connect();
  const y = await makePhone(s7);
  await y.phone.pair(await s7.host.startPairing(), 'y');
  await y.phone.connect();
  await settle();
  const start = s7.relay.frames.length;
  await s7.host.broadcast({ type: 'event', v: 1 });
  await settle();
  const toX = s7.relay.frames.slice(start).find((f) => JSON.parse(f).to === x.id);
  const toY = s7.relay.frames.slice(start).find((f) => JSON.parse(f).to === y.id);
  assert(x.got.at(-1)?.v === 1 && y.got.at(-1)?.v === 1, 'broadcast reaches both phones');
  assert(!!toX && !!toY && JSON.parse(JSON.parse(toX).d).c !== JSON.parse(JSON.parse(toY).d).c, 'each phone gets its own ciphertext');
  const yBefore = y.got.length;
  await s7.host.sendTo(x.id, { type: 'only-x' });
  await settle();
  const xFrame = s7.relay.frames.at(-1)!;
  await y.phone.handleRelay(JSON.parse(xFrame).d);
  assert(y.got.length === yBefore, "phone y can't decrypt a message meant for phone x");

  s7.relay.leave(x.id);
  await settle();
  assert(!s7.host.readyPeers().some((p) => p.peerId === x.id), 'laptop forgets a phone that left the room');

  console.log('\n[8] Laptop restart');
  const saved = await exportIdentity(s7.hostIdentity);
  const restored = await importIdentity(saved, { extractable: true });
  const s8 = await makeHost({ identity: restored, registry: s7.registry, room: s7.room });
  const yAgain = await makePhone(s8, y.phone.hostPub, y.phone.identity);
  await yAgain.phone.connect();
  await settle();
  assert(yAgain.phone.ready && s8.ready.includes(yAgain.id), 'paired phone reconnects after the laptop restarts (saved key + list)');
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
