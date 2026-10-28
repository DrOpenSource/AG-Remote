// End-to-end encryption between the laptop (host) and its phones over the hosted relay.
// Plain ES module on WebCrypto only, so this one file runs unchanged in the extension (Node)
// and in the phone page (browser). Design: docs/relay_plan.md "Phase 2 design".
//
// Relay framing (see relay/src/room.ts):
//   phone sends raw text; the host receives {"from":peerId,"d":text}
//   host sends {"to":peerId,"d":text}; that phone receives the raw text
//   either side may receive {"relay":...} presence messages
//
// Inner messages (the "d" text), all JSON with a "t" field:
//   pair    phone -> host  {pub, name, mac}     mac = HMAC(secret, pairing transcript)
//   paired  host -> phone  {pub, mac}
//   hello   phone -> host  {pub, eph}           starts a session for an already paired phone
//   welcome host -> phone  {eph, confirm}       confirm = first sealed message, proves the host's keys
//   enc     both           {n, c}               AES-256-GCM, n = per-direction counter
//   reject  host -> phone  {reason}

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CURVE = { name: 'ECDH', namedCurve: 'P-256' };
const VERSION = 'ag-remote e2e v1';

export const PAIRING_TTL_MS = 5 * 60 * 1000;
export const MAX_PAIRING_FAILURES = 5;
export const MAX_NAME_LENGTH = 64;
// Larger app messages are split so every sealed frame stays under the relay's 64 KB cap.
export const MAX_FRAME_PLAINTEXT = 40000;
const PART_BYTES = 30000; // base64 of this, sealed and base64'd again, is about 54 KB
const MAX_ASSEMBLED_BYTES = 32 * 1024 * 1024;

export class E2EError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// ---------- encoding and primitives ----------

export function toB64u(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new E2EError('bad-encoding');
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  let bin;
  try {
    bin = atob(padded);
  } catch {
    throw new E2EError('bad-encoding');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** 16 random bytes = 22 base64url chars, the format the relay accepts. */
export function newRoomId() {
  return toB64u(randomBytes(16));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function importPub(b64) {
  try {
    return await subtle.importKey('raw', fromB64u(b64), CURVE, true, []);
  } catch {
    throw new E2EError('bad-key');
  }
}

async function ecdh(privateKey, publicKey) {
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256));
}

function importHmac(secretBytes) {
  return subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function pairTranscript(room, phonePub, name) {
  return encoder.encode([VERSION, 'pair', room, phonePub, name].join('|'));
}

function pairedTranscript(room, hostPub, phonePub) {
  return encoder.encode([VERSION, 'paired', room, hostPub, phonePub].join('|'));
}

/** Runs async jobs one at a time, in call order. Counters and decryption depend on order. */
function serial() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

// ---------- identities ----------

/**
 * A long-term key pair. The phone keeps its private key non-extractable (stored as a CryptoKey
 * in IndexedDB); the host makes it extractable so it can save it to disk.
 */
export async function generateIdentity({ extractable = false } = {}) {
  const kp = await subtle.generateKey(CURVE, extractable, ['deriveBits']);
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, pub: toB64u(await subtle.exportKey('raw', kp.publicKey)) };
}

export async function exportIdentity(identity) {
  return { pub: identity.pub, jwk: await subtle.exportKey('jwk', identity.privateKey) };
}

export async function importIdentity(saved, { extractable = false } = {}) {
  const privateKey = await subtle.importKey('jwk', saved.jwk, CURVE, extractable, ['deriveBits']);
  return { privateKey, publicKey: await importPub(saved.pub), pub: saved.pub };
}

// ---------- session keys ----------

class Channel {
  constructor(sendKey, recvKey, role) {
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.sendN = 0;
    this.recvN = -1;
    this.sendAad = encoder.encode(`${VERSION}|${role === 'phone' ? 'p2h' : 'h2p'}`);
    this.recvAad = encoder.encode(`${VERSION}|${role === 'phone' ? 'h2p' : 'p2h'}`);
  }

  static nonce(n) {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, BigInt(n));
    return iv;
  }

  /** Callers must not run seal() concurrently (see serial()). */
  async seal(obj) {
    const n = this.sendN++;
    const c = await subtle.encrypt(
      { name: 'AES-GCM', iv: Channel.nonce(n), additionalData: this.sendAad },
      this.sendKey,
      encoder.encode(JSON.stringify(obj))
    );
    return { n, c: toB64u(c) };
  }

  /** Rejects anything not newer than the last accepted message, then anything that fails authentication. */
  async open(msg) {
    if (!Number.isSafeInteger(msg?.n) || msg.n <= this.recvN || typeof msg.c !== 'string') throw new E2EError('replay');
    let plain;
    try {
      plain = await subtle.decrypt(
        { name: 'AES-GCM', iv: Channel.nonce(msg.n), additionalData: this.recvAad },
        this.recvKey,
        fromB64u(msg.c)
      );
    } catch {
      throw new E2EError('bad-ciphertext');
    }
    this.recvN = msg.n;
    return JSON.parse(decoder.decode(plain));
  }
}

/**
 * Both sides compute the same four ECDH values (long-term and throwaway keys, in every pairing)
 * and stretch them with HKDF into one AES key per direction. The long-term parts authenticate;
 * the throwaway parts give forward secrecy. Same shape as the Noise "KK" pattern.
 */
async function deriveChannel({ role, room, staticPriv, ephPriv, peerStatic, peerEph, phonePub, hostPub, phoneEph, hostEph }) {
  const ss = await ecdh(staticPriv, peerStatic);
  const ee = await ecdh(ephPriv, peerEph);
  // es = phone throwaway x host long-term, se = phone long-term x host throwaway
  const es = role === 'phone' ? await ecdh(ephPriv, peerStatic) : await ecdh(staticPriv, peerEph);
  const se = role === 'phone' ? await ecdh(staticPriv, peerEph) : await ecdh(ephPriv, peerStatic);

  const salt = new Uint8Array(
    await subtle.digest('SHA-256', encoder.encode([VERSION, room, phonePub, hostPub, phoneEph, hostEph].join('|')))
  );
  const base = await subtle.importKey('raw', concat(ss, ee, es, se), 'HKDF', false, ['deriveKey']);
  const key = (info) =>
    subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(`${VERSION}|${info}`) },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  const p2h = await key('p2h');
  const h2p = await key('h2p');
  return role === 'phone' ? new Channel(p2h, h2p, 'phone') : new Channel(h2p, p2h, 'host');
}

/** {app} payloads to seal for one app message: itself, or {part} pieces when it is too big for one frame. */
function splitApp(obj) {
  const bytes = encoder.encode(JSON.stringify({ app: obj }));
  if (bytes.length <= MAX_FRAME_PLAINTEXT) return [{ app: obj }];
  const mid = toB64u(randomBytes(8));
  const n = Math.ceil(bytes.length / PART_BYTES);
  return Array.from({ length: n }, (_, i) => ({
    part: { mid, i, n, b: toB64u(bytes.subarray(i * PART_BYTES, (i + 1) * PART_BYTES)) },
  }));
}

/**
 * Rebuilds split messages. Parts of one message are sealed in one queued job, so they arrive
 * consecutively and in order; anything else is dropped.
 */
class Assembler {
  constructor() {
    this.cur = null;
  }

  /** Returns the decoded payload once the last part arrives, else undefined. */
  add(part) {
    if (!part || typeof part.mid !== 'string' || !Number.isSafeInteger(part.i) || !Number.isSafeInteger(part.n)) return undefined;
    if (part.i === 0) this.cur = { mid: part.mid, n: part.n, chunks: [], size: 0 };
    const cur = this.cur;
    if (!cur || cur.mid !== part.mid || cur.n !== part.n || cur.chunks.length !== part.i) {
      this.cur = null;
      return undefined;
    }
    const bytes = fromB64u(part.b);
    cur.size += bytes.length;
    if (cur.size > MAX_ASSEMBLED_BYTES) {
      this.cur = null;
      return undefined;
    }
    cur.chunks.push(bytes);
    if (cur.chunks.length < cur.n) return undefined;
    this.cur = null;
    return JSON.parse(decoder.decode(concat(...cur.chunks)));
  }
}

/** Feeds one part to an assembler; a malformed part just drops the message. */
function assemble(assembler, part) {
  try {
    return assembler.add(part);
  } catch {
    assembler.cur = null;
    return undefined;
  }
}

function parse(text) {
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

// ---------- paired-phone list ----------

/** In-memory list of paired phones. The extension swaps in a file-backed one with the same methods. */
export class MemoryPhoneRegistry {
  constructor(records = []) {
    this.map = new Map(records.map((r) => [r.pub, r]));
  }
  get(pub) {
    return this.map.get(pub);
  }
  add(record) {
    this.map.set(record.pub, record);
  }
  remove(pub) {
    return this.map.delete(pub);
  }
  list() {
    return [...this.map.values()];
  }
}

// ---------- host (laptop) side ----------

export class HostE2E {
  /**
   * @param opts.room       relay room id
   * @param opts.identity   from generateIdentity/importIdentity
   * @param opts.phones     MemoryPhoneRegistry or equivalent
   * @param opts.send       (text) => void, writes one frame to the relay socket
   * @param opts.onMessage  (peerId, obj, phoneRecord) => void, app message from a phone
   * @param opts.onPhoneReady / onPhoneGone / onPaired  optional notifications
   */
  constructor(opts) {
    this.room = opts.room;
    this.identity = opts.identity;
    this.phones = opts.phones;
    this.sendFrame = opts.send;
    this.onMessage = opts.onMessage || (() => {});
    this.onPhoneReady = opts.onPhoneReady || (() => {});
    this.onPhoneGone = opts.onPhoneGone || (() => {});
    this.onPaired = opts.onPaired || (() => {});
    this.onVisible = opts.onVisible || (() => {});
    this.now = opts.now || Date.now;
    this.peers = new Map(); // relay peer id -> { pub, channel, ready, sendQ }
    this.inQ = new Map(); // relay peer id -> serial queue for incoming
    this.pairing = null;
  }

  /** Opens a one-time pairing window. Returns the secret for the QR #fragment. Replaces any earlier one. */
  async startPairing() {
    const secret = randomBytes(32);
    this.pairing = { key: await importHmac(secret), expiresAt: this.now() + PAIRING_TTL_MS, failures: 0 };
    return toB64u(secret);
  }

  cancelPairing() {
    this.pairing = null;
  }

  /** Feed every frame received from the relay socket. Resolves once that frame is handled. */
  handleRelay(text) {
    const frame = parse(text);
    if (!frame) return Promise.resolve();
    if (frame.relay === 'peer-left' && frame.role === 'phone') {
      this.dropPeer(frame.peer);
      return Promise.resolve();
    }
    if (typeof frame.from !== 'string' || typeof frame.d !== 'string') return Promise.resolve();
    const peerId = frame.from;
    if (!this.inQ.has(peerId)) this.inQ.set(peerId, serial());
    return this.inQ.get(peerId)(() => this.receive(peerId, frame.d));
  }

  async receive(peerId, d) {
    const msg = parse(d);
    if (!msg) return;
    if (msg.t === 'vis') return this.onVisible(peerId, !!msg.v);
    if (msg.t === 'pair') return this.handlePair(peerId, msg);
    if (msg.t === 'hello') return this.handleHello(peerId, msg);
    if (msg.t === 'enc') return this.handleEnc(peerId, msg);
  }

  async handlePair(peerId, msg) {
    const p = this.pairing;
    if (!p) return this.reject(peerId, 'no-pairing');
    if (this.now() > p.expiresAt) {
      this.pairing = null;
      return this.reject(peerId, 'expired');
    }
    const name = typeof msg.name === 'string' ? msg.name.slice(0, MAX_NAME_LENGTH) : '';
    let ok = false;
    if (typeof msg.pub === 'string' && typeof msg.mac === 'string') {
      try {
        await importPub(msg.pub);
        ok = await subtle.verify('HMAC', p.key, fromB64u(msg.mac), pairTranscript(this.room, msg.pub, name));
      } catch {
        ok = false;
      }
    }
    // Another phone may have used the secret while we were verifying.
    if (this.pairing !== p) return this.reject(peerId, 'no-pairing');
    if (!ok) {
      if (++p.failures >= MAX_PAIRING_FAILURES) this.pairing = null;
      return this.reject(peerId, 'bad-secret');
    }

    this.pairing = null;
    const record = { pub: msg.pub, name, pairedAt: this.now() };
    await this.phones.add(record);
    const mac = await subtle.sign('HMAC', p.key, pairedTranscript(this.room, this.identity.pub, msg.pub));
    this.sendPlain(peerId, { t: 'paired', pub: this.identity.pub, mac: toB64u(mac) });
    this.onPaired(record);
  }

  async handleHello(peerId, msg) {
    const record = typeof msg.pub === 'string' ? await this.phones.get(msg.pub) : undefined;
    if (!record) return this.reject(peerId, 'unknown-phone');
    let peerStatic, peerEph;
    try {
      peerStatic = await importPub(msg.pub);
      peerEph = await importPub(msg.eph);
    } catch {
      return this.reject(peerId, 'bad-key');
    }
    const eph = await generateIdentity();
    const channel = await deriveChannel({
      role: 'host',
      room: this.room,
      staticPriv: this.identity.privateKey,
      ephPriv: eph.privateKey,
      peerStatic,
      peerEph,
      phonePub: msg.pub,
      hostPub: this.identity.pub,
      phoneEph: msg.eph,
      hostEph: eph.pub,
    });
    this.dropPeer(peerId);
    const peer = { pub: msg.pub, channel, ready: false, sendQ: serial(), assembler: new Assembler() };
    this.peers.set(peerId, peer);
    await peer.sendQ(async () => {
      const confirm = await channel.seal({ e2e: 'ready' });
      this.sendPlain(peerId, { t: 'welcome', eph: eph.pub, confirm });
    });
  }

  async handleEnc(peerId, msg) {
    const peer = this.peers.get(peerId);
    if (!peer) return this.reject(peerId, 'no-session');
    let inner;
    try {
      inner = await peer.channel.open(msg);
    } catch (err) {
      this.dropPeer(peerId);
      return this.reject(peerId, err.code || 'bad-message');
    }
    // The revoke may have happened while decrypting.
    if (!(await this.phones.get(peer.pub))) {
      this.dropPeer(peerId);
      return this.reject(peerId, 'revoked');
    }
    if (!peer.ready) {
      if (inner?.e2e !== 'ready') {
        this.dropPeer(peerId);
        return this.reject(peerId, 'bad-handshake');
      }
      peer.ready = true;
      this.onPhoneReady(peerId, await this.phones.get(peer.pub));
      return;
    }
    if (inner?.part) inner = assemble(peer.assembler, inner.part);
    if (inner && 'app' in inner) this.onMessage(peerId, inner.app, await this.phones.get(peer.pub));
  }

  /**
   * Sends an app message to one phone. Resolves when written to the relay socket.
   * Allowed before the phone's confirmation arrives: the phone counts as connected one round trip
   * before the host does, and only the real phone can derive these keys anyway.
   */
  sendTo(peerId, obj) {
    const peer = this.peers.get(peerId);
    if (!peer) return Promise.resolve(false);
    return peer.sendQ(async () => {
      if (this.peers.get(peerId) !== peer) return false;
      for (const payload of splitApp(obj)) {
        const sealed = await peer.channel.seal(payload);
        this.sendPlain(peerId, { t: 'enc', ...sealed });
      }
      return true;
    });
  }

  /** Sends an app message to every connected phone (each encrypted with its own key). */
  broadcast(obj) {
    return Promise.all([...this.peers.keys()].map((id) => this.sendTo(id, obj)));
  }

  readyPeers() {
    return [...this.peers.entries()].filter(([, p]) => p.ready).map(([id, p]) => ({ peerId: id, pub: p.pub }));
  }

  /** Forgets a phone and disconnects any session it has open. */
  async revoke(pub) {
    await this.phones.remove(pub);
    for (const [peerId, peer] of [...this.peers]) {
      if (peer.pub !== pub) continue;
      this.dropPeer(peerId);
      this.reject(peerId, 'revoked');
    }
  }

  dropPeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    if (peer.ready) this.onPhoneGone(peerId, peer.pub);
  }

  reject(peerId, reason) {
    this.sendPlain(peerId, { t: 'reject', reason });
  }

  sendPlain(peerId, msg) {
    this.sendFrame(JSON.stringify({ to: peerId, d: JSON.stringify(msg) }));
  }
}

// ---------- phone side ----------

export class PhoneE2E {
  /**
   * @param opts.room       relay room id
   * @param opts.identity   the phone's long-term identity (non-extractable)
   * @param opts.hostPub    the laptop's public key once paired, else null
   * @param opts.send       (text) => void, writes one frame to the relay socket
   * @param opts.onMessage  (obj) => void, app message from the laptop
   * @param opts.onReject / onHostLeft  optional notifications
   */
  constructor(opts) {
    this.room = opts.room;
    this.identity = opts.identity;
    this.hostPub = opts.hostPub || null;
    this.sendFrame = opts.send;
    this.onMessage = opts.onMessage || (() => {});
    this.onReject = opts.onReject || (() => {});
    this.onHostLeft = opts.onHostLeft || (() => {});
    this.channel = null;
    this.ready = false;
    this.pending = null; // { kind: 'pair'|'hello', resolve, reject, ... }
    this.inQ = serial();
    this.sendQ = serial();
  }

  /** Pairs with the laptop using the secret from the QR #fragment. Resolves with the laptop's public key. */
  async pair(secretB64, name = '') {
    const key = await importHmac(fromB64u(secretB64));
    name = name.slice(0, MAX_NAME_LENGTH);
    const mac = await subtle.sign('HMAC', key, pairTranscript(this.room, this.identity.pub, name));
    return new Promise((resolve, reject) => {
      this.setPending({ kind: 'pair', key, resolve, reject });
      this.sendFrame(JSON.stringify({ t: 'pair', pub: this.identity.pub, name, mac: toB64u(mac) }));
    });
  }

  /** Starts an encrypted session with the paired laptop. Resolves when both sides have proven their keys. */
  async connect() {
    if (!this.hostPub) throw new E2EError('not-paired');
    this.ready = false;
    this.channel = null;
    const eph = await generateIdentity();
    return new Promise((resolve, reject) => {
      this.setPending({ kind: 'hello', eph, resolve, reject });
      this.sendFrame(JSON.stringify({ t: 'hello', pub: this.identity.pub, eph: eph.pub }));
    });
  }

  setPending(p) {
    this.pending?.reject(new E2EError('superseded'));
    this.pending = p;
  }

  settle(kind, value, error) {
    const p = this.pending;
    if (!p || p.kind !== kind) return;
    this.pending = null;
    error ? p.reject(error) : p.resolve(value);
  }

  /** Feed every frame received from the relay socket. Resolves once that frame is handled. */
  handleRelay(text) {
    return this.inQ(() => this.receive(text));
  }

  async receive(text) {
    const msg = parse(text);
    if (!msg) return;
    if (msg.relay) {
      if (msg.relay === 'peer-left' && msg.role === 'host') {
        this.ready = false;
        this.channel = null;
        this.onHostLeft();
      }
      return;
    }
    if (msg.t === 'reject') {
      const err = new E2EError(String(msg.reason));
      if (this.pending) this.settle(this.pending.kind, null, err);
      this.ready = false;
      this.channel = null;
      this.onReject(err.code);
      return;
    }
    if (msg.t === 'paired') return this.handlePaired(msg);
    if (msg.t === 'welcome') return this.handleWelcome(msg);
    if (msg.t === 'enc') return this.handleEnc(msg);
  }

  async handlePaired(msg) {
    const p = this.pending;
    if (p?.kind !== 'pair') return;
    let ok = false;
    try {
      await importPub(msg.pub);
      ok = await subtle.verify('HMAC', p.key, fromB64u(msg.mac), pairedTranscript(this.room, msg.pub, this.identity.pub));
    } catch {
      ok = false;
    }
    if (!ok) return this.settle('pair', null, new E2EError('bad-mac'));
    this.hostPub = msg.pub;
    this.settle('pair', msg.pub);
  }

  async handleWelcome(msg) {
    const p = this.pending;
    if (p?.kind !== 'hello') return;
    try {
      const channel = await deriveChannel({
        role: 'phone',
        room: this.room,
        staticPriv: this.identity.privateKey,
        ephPriv: p.eph.privateKey,
        peerStatic: await importPub(this.hostPub),
        peerEph: await importPub(msg.eph),
        phonePub: this.identity.pub,
        hostPub: this.hostPub,
        phoneEph: p.eph.pub,
        hostEph: msg.eph,
      });
      const confirm = await channel.open(msg.confirm);
      if (confirm?.e2e !== 'ready') throw new E2EError('bad-confirm');
      this.channel = channel;
      this.assembler = new Assembler();
      await this.sendQ(async () => {
        const sealed = await channel.seal({ e2e: 'ready' });
        this.sendFrame(JSON.stringify({ t: 'enc', ...sealed }));
      });
      this.ready = true;
      this.settle('hello', true);
    } catch (err) {
      // Wrong keys mean an impostor (or a bug): never fall back to anything unencrypted.
      this.settle('hello', null, new E2EError(err.code === 'bad-ciphertext' ? 'bad-confirm' : err.code || 'bad-handshake'));
    }
  }

  async handleEnc(msg) {
    if (!this.ready || !this.channel) return;
    let inner;
    try {
      inner = await this.channel.open(msg);
    } catch {
      return; // A replayed or tampered frame is dropped; the session stays up.
    }
    if (inner?.part) inner = assemble(this.assembler, inner.part);
    if (inner && 'app' in inner) this.onMessage(inner.app);
  }

  /** Sends an app message to the laptop. Resolves when written to the relay socket. */
  send(obj) {
    return this.sendQ(async () => {
      if (!this.ready || !this.channel) throw new E2EError('not-connected');
      const channel = this.channel;
      for (const payload of splitApp(obj)) {
        const sealed = await channel.seal(payload);
        this.sendFrame(JSON.stringify({ t: 'enc', ...sealed }));
      }
    });
  }
}
