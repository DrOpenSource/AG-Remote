// Phone side of the hosted relay (remote.taqnik.in). Used by app.js when the page was opened from a
// relay QR (/p/<room>#<secret>). Pairs once, keeps the phone's key in IndexedDB, and turns the app's
// API calls into end-to-end encrypted requests to the laptop (see src/relay-host/relay-host.ts).
import { PhoneE2E, generateIdentity, checkCode, APPROVAL_TIMEOUT_MS } from './e2e.js';

const REQUEST_TIMEOUT_MS = 20000;
const PAIR_WAIT_MS = 20000;
// Longer than the PC waits for its owner, so the PC's own "timed out" answer arrives first.
const APPROVAL_WAIT_MS = APPROVAL_TIMEOUT_MS + 15000;
const PING_MS = 25000;
const CLOSE_ROOM_FULL = 4002;

// ---------- storage: one pairing per room, CryptoKeys stored as-is (the private key can't be read out) ----------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ag-remote-relay', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('pairings');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** One transaction on a short-lived connection; an open connection would block clearing site data. */
async function dbOp(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pairings', mode);
    const req = fn(tx.objectStore('pairings'));
    tx.oncomplete = () => {
      db.close();
      resolve(req && req.result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

const loadPairing = (room) => dbOp('readonly', (s) => s.get(room));
const savePairing = (room, value) => dbOp('readwrite', (s) => s.put(value, room));
const deletePairing = (room) => dbOp('readwrite', (s) => s.delete(room));

function deviceName() {
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Browser';
}

/** Room id from /p/<room>; the pairing secret from #<secret>, if this page came from a fresh QR. */
export function parseRelayLocation(loc = window.location) {
  const m = loc.pathname.match(/^\/p\/([A-Za-z0-9_-]{22})\/?$/);
  const secret = loc.hash.length > 1 ? loc.hash.slice(1) : null;
  return { room: m ? m[1] : null, secret };
}

/**
 * States reported through onState:
 *   connecting   opening the relay socket
 *   waiting-host relay reached, the laptop (IDE) isn't connected to it
 *   pairing      using the QR secret
 *   approving    the secret was right; waiting for the owner to click Allow on the PC (see checkCode)
 *   ready        encrypted session up; requests work
 *   unpaired     no pairing for this room (or the laptop revoked it): scan a new QR
 *   room-full    too many phones connected to this laptop
 *   offline      relay unreachable; retrying
 */
export class RelayLink {
  constructor({ room, secret, onEvent, onState, onPairError }) {
    this.room = room;
    this.secret = secret;
    this.onEvent = onEvent || (() => {});
    this.onState = onState || (() => {});
    this.onPairError = onPairError || (() => {});
    this.state = 'connecting';
    this.ws = null;
    this.e2e = null;
    this.pairing = null; // stored { identity, hostPub }
    this.hostPresent = false;
    this.pending = new Map();
    this.nextId = 1;
    this.backoff = 1000;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.working = false; // pairing or handshaking right now
    this.checkCode = ''; // shown on the phone and the PC while the PC decides
    this.pairWait = null;
    this.lastActivity = Date.now();
  }

  async start() {
    this.pairing = (await loadPairing(this.room).catch(() => null)) || null;
    if (!this.pairing && !this.secret) {
      this.setState('unpaired');
      return;
    }
    this.connect();
  }

  isReady() {
    return this.state === 'ready';
  }

  /** Synchronous presence frame to host, unencrypted for zero delay on sleep/background. */
  reportVisible(visible) {
    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify({ t: 'vis', v: !!visible }));
      } catch (_) {}
    }
  }

  /**
   * Reconnects immediately if the socket dropped, was suspended by OS sleep, or has gone stale.
   * Eliminates the multi-second delay when returning to the PWA.
   */
  wake() {
    if (this.state === 'unpaired' || this.state === 'room-full') return;
    const now = Date.now();
    const isStale = !this.ws || this.ws.readyState !== 1 || (now - this.lastActivity > 10000);
    if (isStale) {
      if (this.ws) {
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        try { this.ws.close(); } catch (_) {}
        this.ws = null;
      }
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.backoff = 1000;
      this.connect();
    } else {
      try { this.ws.send('ping'); } catch (_) {}
    }
  }

  /** Reconnects now if the socket dropped (e.g. the phone slept). */
  ensureConnected() {
    this.wake();
  }

  /** Same shape the app gets from fetch: { ok, status, data }. Throws when the laptop is unreachable. */
  request(method, path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.isReady()) return Promise.reject(new Error('not-connected'));
    this.lastActivity = Date.now();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.e2e.send({ k: 'req', id, method, path, body }).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  setState(state) {
    if (state === this.state) return;
    this.state = state;
    if (state !== 'ready') this.failPending('not-connected');
    this.onState(state);
  }

  failPending(reason) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/${this.room}?role=phone`);
    this.ws = ws;
    this.hostPresent = false;
    this.setState('connecting');
    this.e2e = this.pairing
      ? this.makeE2E(this.pairing.identity, this.pairing.hostPub)
      : null;

    ws.onopen = () => {
      this.lastActivity = Date.now();
      this.backoff = 1000;
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => ws.readyState === 1 && ws.send('ping'), PING_MS);
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws || typeof e.data !== 'string') return;
      this.lastActivity = Date.now();
      if (e.data === 'pong') return;
      let msg = null;
      try {
        msg = JSON.parse(e.data);
      } catch (_) {}
      if (msg && msg.relay) this.handlePresence(msg);
      if (this.e2e) this.e2e.handleRelay(e.data);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      this.ws = null;
      if (e.code === CLOSE_ROOM_FULL) {
        this.setState('room-full');
        return;
      }
      if (this.state === 'unpaired') return;
      this.setState('offline');
      const isVisible = typeof document !== 'undefined' && document.visibilityState === 'visible';
      const delay = isVisible ? Math.min(this.backoff, 1500) : this.backoff;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
      this.backoff = Math.min(this.backoff * 2, 15000);
    };
  }

  makeE2E(identity, hostPub) {
    return new PhoneE2E({
      room: this.room,
      identity,
      hostPub,
      send: (text) => this.ws && this.ws.readyState === 1 && this.ws.send(text),
      onMessage: (msg) => this.handleMessage(msg),
      onReject: (reason) => this.handleReject(reason),
      onPairWait: () => this.pairWait?.(),
      onHostLeft: () => {},
    });
  }

  handlePresence(msg) {
    if (msg.relay === 'hello') {
      this.hostPresent = (msg.peers || []).some((p) => p.role === 'host');
    } else if (msg.role === 'host') {
      this.hostPresent = msg.relay === 'peer-joined';
    } else {
      return;
    }
    if (this.hostPresent) this.begin();
    else this.setState('waiting-host');
  }

  /** Pairs if needed, then runs the handshake. Called whenever the laptop appears in the room. */
  async begin() {
    if (this.working) return;
    this.working = true;
    try {
      if (!this.pairing) {
        if (!this.secret) {
          this.setState('unpaired');
          return;
        }
        this.setState('pairing');
        const identity = await generateIdentity();
        this.checkCode = await checkCode(identity.pub);
        this.e2e = this.makeE2E(identity, null);
        const secret = this.secret;
        this.secret = null; // single use, whatever happens next
        let timer, fail;
        const wait = (ms) => {
          clearTimeout(timer);
          timer = setTimeout(() => fail(Object.assign(new Error('timeout'), { code: 'timeout' })), ms);
        };
        this.pairWait = () => {
          wait(APPROVAL_WAIT_MS);
          this.setState('approving');
        };
        const hostPub = await Promise.race([
          this.e2e.pair(secret, deviceName()),
          new Promise((_, reject) => {
            fail = reject;
            wait(PAIR_WAIT_MS);
          }),
        ]).finally(() => {
          clearTimeout(timer);
          this.pairWait = null;
        });
        this.pairing = { identity, hostPub };
        await savePairing(this.room, this.pairing);
      }
      await this.e2e.connect();
      this.setState('ready');
    } catch (err) {
      const code = (err && err.code) || 'error';
      if (this.state === 'pairing' || this.state === 'approving') {
        this.e2e = null;
        this.setState('unpaired');
        this.onPairError(code);
      } else if (code === 'unknown-phone' || code === 'revoked') {
        // handled in handleReject
      } else if (this.ws && this.hostPresent) {
        // A failed handshake is retried on the next presence change or reconnect.
        this.setState('waiting-host');
      }
    } finally {
      this.working = false;
    }
  }

  handleMessage(msg) {
    if (!msg) return;
    if (msg.k === 'evt') {
      this.onEvent(msg.event);
    } else if (msg.k === 'res') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve({ ok: msg.status >= 200 && msg.status < 300, status: msg.status, data: msg.body });
    }
  }

  async handleReject(reason) {
    if (reason === 'unknown-phone' || reason === 'revoked') {
      // The laptop no longer knows this phone: forget the pairing so the app asks for a new QR.
      this.pairing = null;
      this.e2e = null;
      await deletePairing(this.room).catch(() => {});
      this.setState('unpaired');
      return;
    }
    // Session-level problem (e.g. the laptop restarted): handshake again.
    if (this.pairing && this.hostPresent && this.state === 'ready') {
      this.setState('connecting');
      this.e2e = this.makeE2E(this.pairing.identity, this.pairing.hostPub);
      this.begin();
    }
  }
}
