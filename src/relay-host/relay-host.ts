import { HostE2E } from '../pwa/e2e.js';
import { SessionManager } from '../core/session-manager.ts';
import { handlePhoneApi } from '../server/api.ts';
import type { AdapterEvent } from '../core/types.ts';
import type { PhoneRecord, RelayStore } from './relay-store.ts';

export type RelayStatus = 'connecting' | 'online' | 'offline' | 'replaced' | 'stopped';

export interface RelayHostOptions {
  /** e.g. https://remote.taqnik.in */
  relayUrl: string;
  store: RelayStore;
  sessionManager: SessionManager;
  onStatus?: (status: RelayStatus) => void;
  onPaired?: (phone: PhoneRecord) => void;
  /** Tests inject a WebSocket class; the extension uses Node's built-in one. */
  WebSocketImpl?: typeof WebSocket;
}

const CLOSE_REPLACED = 4001; // relay/src/room.ts: another window became host
const PING_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * The extension's side of the hosted relay. Dials the relay outbound, so it works from any network,
 * and answers the phone over end-to-end encryption:
 *   phone -> {k:'req', id, method, path, body}   answered with {k:'res', id, status, body}
 *   laptop -> {k:'evt', event}                    every SessionManager adapter event
 * Requests run through the same handlePhoneApi as the local HTTP server.
 */
export class RelayHost {
  private opts: RelayHostOptions;
  private e2e!: HostE2E;
  private ws: WebSocket | null = null;
  private status: RelayStatus = 'stopped';
  private stopped = true;
  private backoff = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly onEvent = (event: AdapterEvent) => {
    this.e2e.broadcast({ k: 'evt', event }).catch(() => {});
  };

  constructor(opts: RelayHostOptions) {
    this.opts = { ...opts, relayUrl: opts.relayUrl.replace(/\/+$/, '') };
    this.buildE2E();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.opts.sessionManager.on('adapter_event', this.onEvent);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.opts.sessionManager.off('adapter_event', this.onEvent);
    this.clearTimers();
    this.ws?.close(1000, 'stopping');
    this.ws = null;
    this.setStatus('stopped');
  }

  getStatus(): RelayStatus {
    return this.status;
  }

  /** Opens a 5-minute single-use pairing window. The QR encodes this URL. */
  async createPairingUrl(): Promise<string> {
    const secret = await this.e2e.startPairing();
    return `${this.opts.relayUrl}/p/${this.opts.store.room}#${secret}`;
  }

  pairedPhones(): PhoneRecord[] {
    return this.opts.store.list();
  }

  connectedPhones(): number {
    return this.e2e.readyPeers().length;
  }

  /** Forgets one phone and drops its session. */
  async revoke(pub: string): Promise<void> {
    await this.e2e.revoke(pub);
  }

  /** Forgets every phone and moves to a new room and key, so old QR codes are dead too. */
  async revokeAll(): Promise<void> {
    for (const phone of this.opts.store.list()) await this.e2e.revoke(phone.pub);
    await this.opts.store.reset();
    this.buildE2E();
    if (!this.stopped) {
      this.ws?.close(1000, 'room changed');
      this.ws = null;
      this.clearTimers();
      this.connect();
    }
  }

  private buildE2E(): void {
    const { store } = this.opts;
    this.e2e = new HostE2E({
      room: store.room,
      identity: store.identity,
      phones: store,
      send: (text: string) => {
        if (this.ws?.readyState === 1) this.ws.send(text);
      },
      onMessage: (peerId: string, msg: any) => this.handleRequest(peerId, msg),
      onPaired: (phone: PhoneRecord) => this.opts.onPaired?.(phone)
    });
  }

  private connect(): void {
    if (this.stopped) return;
    const Impl = this.opts.WebSocketImpl || globalThis.WebSocket;
    const url = `${this.opts.relayUrl.replace(/^http/, 'ws')}/ws/${this.opts.store.room}?role=host`;
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new Impl(url);
    } catch (_) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    const e2e = this.e2e;
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.backoff = 1000;
      this.setStatus('online');
      this.pingTimer = setInterval(() => {
        if (ws.readyState === 1) ws.send('ping');
      }, PING_MS);
    });
    ws.addEventListener('message', (e: MessageEvent) => {
      if (this.ws === ws && typeof e.data === 'string') e2e.handleRelay(e.data).catch(() => {});
    });
    ws.addEventListener('close', (e: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (this.stopped) return;
      if (e.code === CLOSE_REPLACED) {
        // Another IDE window is host now. Don't fight it for the room.
        this.setStatus('replaced');
        return;
      }
      this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {});
  }

  private scheduleReconnect(): void {
    this.setStatus('offline');
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  private setStatus(status: RelayStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.opts.onStatus?.(status);
  }

  private async handleRequest(peerId: string, msg: any): Promise<void> {
    if (!msg || msg.k !== 'req' || typeof msg.path !== 'string' || !msg.path.startsWith('/api/')) return;
    const method = msg.method === 'POST' ? 'POST' : 'GET';
    const url = new URL(msg.path, 'http://relay.invalid');
    let status = 500;
    let body: unknown = { error: 'Internal Server Error' };
    try {
      const result = url.pathname.startsWith('/api/hub/')
        ? null // window coordination stays on the local port
        : await handlePhoneApi(this.opts.sessionManager, method, url.pathname, url.searchParams, method === 'POST' ? (msg.body ?? {}) : undefined);
      status = result ? result.status : 404;
      body = result ? result.body : { error: 'Not Found' };
    } catch (err: any) {
      body = { error: err?.message || 'Internal Server Error' };
    }
    await this.e2e.sendTo(peerId, { k: 'res', id: msg.id, status, body });
  }
}
