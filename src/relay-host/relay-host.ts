import { HostE2E } from '../pwa/e2e.js';
import { SessionManager } from '../core/session-manager.ts';
import { handlePhoneApi } from '../server/api.ts';
import crypto from 'crypto';
import type { AdapterEvent, Approval } from '../core/types.ts';
import type { PhoneRecord, RelayStore } from './relay-store.ts';
import { sendPush, validSubscription, type PushSub, type VapidKeys } from './web-push.ts';

export type RelayStatus = 'connecting' | 'online' | 'offline' | 'replaced' | 'stopped';

/** A phone waiting to be allowed. `code` is the check code its screen shows too. */
export interface WaitingPhone {
  id: string;
  name: string;
  code: string;
}

export interface RelayHostOptions {
  /** e.g. https://remote.taqnik.in */
  relayUrl: string;
  store: RelayStore;
  sessionManager: SessionManager;
  onStatus?: (status: RelayStatus) => void;
  onPaired?: (phone: PhoneRecord) => void;
  /** A phone used a valid QR or code and waits until answerApproval() allows or denies it. */
  onApprovalNeeded?: (request: WaitingPhone) => void;
  /** Tests inject a WebSocket class; the extension uses Node's built-in one. */
  WebSocketImpl?: typeof WebSocket;
  /** Tests replace the push sender; the extension posts to the phone's push service. */
  sendPushImpl?: (sub: PushSub, payload: object, vapid: VapidKeys, subject: string) => Promise<'sent' | 'gone' | 'failed'>;
  /** How long a window must stay idle before "finished" is sent. Tests shorten it. */
  doneDelayMs?: number;
}

const CLOSE_REPLACED = 4001; // relay/src/room.ts: another window became host
const DONE_DELAY_MS = 3000;
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
  /** Phones that said their app is on screen; they get no push, they already see it. Stored with last-seen timestamp to expire stale visibility. */
  private visiblePeers = new Map<string, number>();
  /** Last status per IDE window ('' without multi-window), to spot a task finishing. */
  private lastStatus = new Map<string, string>();
  /** Per window: a "finished" push waiting to see the agent stay idle. */
  private doneTimers = new Map<string, NodeJS.Timeout>();
  private readonly onEvent = (event: AdapterEvent) => {
    this.e2e.broadcast({ k: 'evt', event }).catch(() => {});
    this.maybeNotify(event as AdapterEvent & { windowId?: string });
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
    for (const timer of this.doneTimers.values()) clearTimeout(timer);
    this.doneTimers.clear();
    this.ws?.close(1000, 'stopping');
    this.ws = null;
    this.setStatus('stopped');
  }

  getStatus(): RelayStatus {
    return this.status;
  }

  /** Opens a 5-minute single-use pairing window. Returns the QR URL and an optional short code. */
  async createPairingUrl(): Promise<{ url: string; code?: string }> {
    const secret = await this.e2e.startPairing();
    const url = `${this.opts.relayUrl}/p/${this.opts.store.room}#${secret}`;
    let code: string | undefined;
    try {
      const res = await fetch(`${this.opts.relayUrl}/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: this.opts.store.room, fragment: secret }),
      });
      if (res.ok) {
        const data = (await res.json()) as { code: string };
        code = data.code;
      }
    } catch {
      // Short code is optional — the QR still works without it.
    }
    return { url, code };
  }

  pairedPhones(): PhoneRecord[] {
    return this.opts.store.list().map(({ pub, name, pairedAt }) => ({ pub, name, pairedAt }));
  }

  connectedPhones(): number {
    return this.e2e.readyPeers().length;
  }

  pendingApprovals(): WaitingPhone[] {
    return this.e2e.pendingApprovals();
  }

  /** Allows or denies a waiting phone. False if it stopped waiting (answered, timed out or left). */
  answerApproval(id: string, allow: boolean): boolean {
    return this.e2e.answerApproval(id, allow);
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
      onMessage: (peerId: string, msg: any, phone?: PhoneRecord) => {
        if (this.visiblePeers.has(peerId)) this.visiblePeers.set(peerId, Date.now());
        this.handleRequest(peerId, msg, phone);
      },
      onVisible: (peerId: string, visible: boolean) => {
        if (visible) this.visiblePeers.set(peerId, Date.now());
        else this.visiblePeers.delete(peerId);
      },
      onPhoneGone: (peerId: string) => this.visiblePeers.delete(peerId),
      onPaired: (phone: PhoneRecord) => this.opts.onPaired?.(phone),
      // Every new phone needs a yes on the PC, so a leaked or guessed code alone can't pair one.
      onApprovalNeeded: (request: WaitingPhone) => this.opts.onApprovalNeeded?.(request)
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

  private async handleRequest(peerId: string, msg: any, phone?: PhoneRecord): Promise<void> {
    if (!msg || msg.k !== 'req' || typeof msg.path !== 'string' || !msg.path.startsWith('/api/')) return;
    const method = msg.method === 'POST' ? 'POST' : 'GET';
    const url = new URL(msg.path, 'http://relay.invalid');
    let status = 500;
    let body: unknown = { error: 'Internal Server Error' };
    try {
      const result = url.pathname.startsWith('/api/hub/')
        ? null // window coordination stays on the local port
        : url.pathname.startsWith('/api/push/')
        ? await this.handlePushApi(peerId, phone, url.pathname, msg.body)
        : await handlePhoneApi(this.opts.sessionManager, method, url.pathname, url.searchParams, method === 'POST' ? (msg.body ?? {}) : undefined);
      status = result ? result.status : 404;
      body = result ? result.body : { error: 'Not Found' };
    } catch (err: any) {
      body = { error: err?.message || 'Internal Server Error' };
    }
    await this.e2e.sendTo(peerId, { k: 'res', id: msg.id, status, body });
  }

  /**
   * Notifications exist only over the relay (phones allow them on HTTPS pages only), so these routes
   * live here, where the phone's identity is known, rather than in handlePhoneApi.
   */
  private async handlePushApi(peerId: string, phone: PhoneRecord | undefined, pathname: string, body: any) {
    if (!phone) return { status: 403, body: { error: 'Unknown phone' } };
    if (pathname === '/api/push/key') return { status: 200, body: { key: this.opts.store.vapid.publicKey } };
    if (pathname === '/api/push/visible') {
      if (body?.visible) this.visiblePeers.set(peerId, Date.now());
      else this.visiblePeers.delete(peerId);
      return { status: 200, body: { ok: true } };
    }
    if (pathname === '/api/push/subscribe') {
      const sub = validSubscription(body?.subscription);
      if (!sub) return { status: 400, body: { error: 'Not a push subscription from a known push service' } };
      await this.opts.store.setPush(phone.pub, sub);
      return { status: 200, body: { ok: true } };
    }
    if (pathname === '/api/push/unsubscribe') {
      await this.opts.store.setPush(phone.pub, null);
      return { status: 200, body: { ok: true } };
    }
    return null;
  }

  /** Approval needed, or a task finished: push to every phone that turned notifications on and isn't looking. */
  private maybeNotify(event: AdapterEvent & { windowId?: string }): void {
    const key = event.windowId || '';
    if (event.type === 'approval_requested') {
      this.cancelDone(key);
      this.notify('approval', event.windowId, requestCategory(event.approval));
      return;
    }
    if (event.type !== 'status_changed') return;
    const before = this.lastStatus.get(key);
    this.lastStatus.set(key, event.status);
    if (event.status === 'idle' && (before === 'generating' || before === 'awaiting_approval')) {
      // The agent can pause between steps; only a run that stays idle counts as finished.
      this.cancelDone(key);
      this.doneTimers.set(key, setTimeout(() => {
        this.doneTimers.delete(key);
        this.notify('done', event.windowId);
      }, this.opts.doneDelayMs ?? DONE_DELAY_MS));
    } else if (event.status !== 'idle') {
      this.cancelDone(key);
    }
  }

  private cancelDone(key: string): void {
    const timer = this.doneTimers.get(key);
    if (timer) clearTimeout(timer);
    this.doneTimers.delete(key);
  }

  /** The window an event came from; events without a windowId come from the only window. */
  private windowOf(windowId?: string): { id: string; name: string } {
    const all = this.opts.sessionManager.registry.getAll();
    const win = windowId ? all.find((w) => w.windowId === windowId) : all.length === 1 ? all[0] : undefined;
    return { id: win?.windowId || windowId || '', name: win?.workspaceName || '' };
  }

  private notify(kind: 'approval' | 'done', windowId?: string, ask?: PushAsk): void {
    const now = Date.now();
    const VISIBILITY_TTL_MS = 15000;
    const watching = new Set(
      this.e2e.readyPeers()
        .filter((p) => {
          const lastSeen = this.visiblePeers.get(p.peerId);
          return lastSeen !== undefined && (now - lastSeen) < VISIBILITY_TTL_MS;
        })
        .map((p) => p.pub)
    );
    const win = this.windowOf(windowId);
    // The payload is encrypted to the phone; the push service sees only that something was sent.
    // It names the project and the kind of request, never the command, file or question: it can
    // show on a locked screen. `win` keeps one notification per project on the phone.
    const payload = {
      kind,
      ...(ask ? { ask } : {}),
      ws: win.name,
      win: crypto.createHash('sha256').update(win.id).digest('base64url').slice(0, 10),
      at: now,
      url: `/p/${this.opts.store.room}`,
    };
    const send = this.opts.sendPushImpl || sendPush;
    for (const phone of this.opts.store.list()) {
      if (!phone.push || watching.has(phone.pub)) continue;
      const sub = phone.push;
      send(sub, payload, this.opts.store.vapid, this.opts.relayUrl).then((result) => {
        // The phone turned notifications off or reinstalled: forget the subscription.
        if (result === 'gone' && this.opts.store.get(phone.pub)?.push === sub) this.opts.store.setPush(phone.pub, null);
      }).catch(() => {});
    }
  }
}

/** What a notification may say about a request. */
export type PushAsk = 'command' | 'new-file' | 'edit-file' | 'question' | 'browser' | 'web' | 'tool' | 'other';

/** The kind of request only: the phone shows "wants to run a command", never which command. */
export function requestCategory(approval: Approval | undefined): PushAsk {
  const kind = String(approval?.kind || '').toLowerCase();
  if (kind === 'ask_question' || (approval?.options?.length ?? 0) > 0) return 'question';
  if (kind === 'run_command') return 'command';
  if (kind === 'write_to_file') return 'new-file';
  if (kind.includes('file')) return 'edit-file';
  if (kind.includes('browser')) return 'browser';
  if (kind.includes('url')) return 'web';
  if (kind.includes('mcp')) return 'tool';
  return 'other';
}
