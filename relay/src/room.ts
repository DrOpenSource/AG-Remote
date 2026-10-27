import { DurableObject } from 'cloudflare:workers';

/**
 * One room per paired laptop. Holds one host socket (the extension) and a few phone sockets.
 * Text frames only. Message bodies ("d") are forwarded untouched; they are end-to-end encrypted
 * (src/e2e/e2e.js), so the relay can't read them.
 * Uses WebSocket hibernation, so an idle room costs nothing while sockets stay open.
 *
 * Routing:
 *   phone sends raw text      -> host receives {"from":phoneId,"d":text}
 *   host sends {"to":id,"d"}  -> that phone receives d
 *   host sends {"d"}          -> every phone receives d
 *
 * Messages the relay itself sends are JSON with a top-level "relay" key:
 *   {"relay":"hello","you":id,"role":role,"peers":[{role,id}]}  to a socket that just joined
 *   {"relay":"peer-joined","role":role,"peer":id}
 *   {"relay":"peer-left","role":role,"peer":id}
 * A host "d" starting with {"relay" is dropped, so phones can trust that key came from the relay.
 * The text "ping" is answered with "pong" without waking the room.
 */

type Role = 'host' | 'phone';

interface SocketInfo {
  role: Role;
  id: string;
  windowStart: number;
  count: number;
}

export const MAX_PHONES = 4;
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const RATE_WINDOW_MS = 10_000;
export const RATE_MAX_MESSAGES = 200;
// The host sends a separately encrypted copy of each update to every phone.
export const HOST_RATE_MAX_MESSAGES = RATE_MAX_MESSAGES * MAX_PHONES;

export const CLOSE_REPLACED = 4001;
export const CLOSE_ROOM_FULL = 4002;
export const CLOSE_TOO_LARGE = 4003;
export const CLOSE_RATE_LIMITED = 4004;
export const CLOSE_BINARY = 4005;

const encoder = new TextEncoder();

export class Room extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const role = new URL(request.url).searchParams.get('role') as Role;
    const [client, server] = Object.values(new WebSocketPair());

    if (role === 'phone' && this.ctx.getWebSockets('phone').length >= MAX_PHONES) {
      // Accept then close, so the phone gets a readable close code instead of a failed handshake.
      server.accept();
      server.close(CLOSE_ROOM_FULL, 'room full');
      return new Response(null, { status: 101, webSocket: client });
    }

    if (role === 'host') {
      for (const old of this.ctx.getWebSockets('host')) {
        old.close(CLOSE_REPLACED, 'replaced by a new host');
      }
    }

    const info: SocketInfo = { role, id: crypto.randomUUID(), windowStart: Date.now(), count: 0 };
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment(info);

    const peers = this.visiblePeers(role).map((ws) => {
      const peer = ws.deserializeAttachment() as SocketInfo;
      return { role: peer.role, id: peer.id };
    });
    server.send(JSON.stringify({ relay: 'hello', you: info.id, role, peers }));
    this.announce(info, 'peer-joined');

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const info = ws.deserializeAttachment() as SocketInfo;

    if (typeof message !== 'string') {
      ws.close(CLOSE_BINARY, 'text frames only');
      return;
    }
    if (encoder.encode(message).byteLength > MAX_MESSAGE_BYTES) {
      ws.close(CLOSE_TOO_LARGE, 'message too large');
      return;
    }

    const now = Date.now();
    if (now - info.windowStart > RATE_WINDOW_MS) {
      info.windowStart = now;
      info.count = 0;
    }
    info.count++;
    ws.serializeAttachment(info);
    if (info.count > (info.role === 'host' ? HOST_RATE_MAX_MESSAGES : RATE_MAX_MESSAGES)) {
      ws.close(CLOSE_RATE_LIMITED, 'rate limited');
      return;
    }

    if (info.role === 'phone') {
      this.deliver(this.ctx.getWebSockets('host'), `{"from":${JSON.stringify(info.id)},"d":${JSON.stringify(message)}}`);
      return;
    }

    let frame: { to?: unknown; d?: unknown };
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }
    if (typeof frame?.d !== 'string' || frame.d.startsWith('{"relay"')) return;
    const phones = this.ctx.getWebSockets('phone');
    const targets =
      typeof frame.to === 'string'
        ? phones.filter((ws) => (ws.deserializeAttachment() as SocketInfo | null)?.id === frame.to)
        : phones;
    this.deliver(targets, frame.d);
  }

  private deliver(targets: WebSocket[], text: string): void {
    for (const target of targets) {
      try {
        target.send(text);
      } catch {
        // Socket is closing; its close handler announces it.
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.handleGone(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.handleGone(ws);
  }

  private handleGone(ws: WebSocket): void {
    const info = ws.deserializeAttachment() as SocketInfo | null;
    if (!info) return;
    // A host replaced by a new one is not "gone" from the phones' point of view.
    if (info.role === 'host' && this.othersWithRole('host', info.id).length > 0) return;
    this.announce(info, 'peer-left');
  }

  /** Phones see the host; the host sees phones. Phones never see each other. */
  private visiblePeers(role: Role): WebSocket[] {
    return this.ctx.getWebSockets(role === 'host' ? 'phone' : 'host');
  }

  private othersWithRole(role: Role, exceptId: string): WebSocket[] {
    return this.ctx
      .getWebSockets(role)
      .filter((ws) => (ws.deserializeAttachment() as SocketInfo | null)?.id !== exceptId);
  }

  private announce(info: SocketInfo, event: 'peer-joined' | 'peer-left'): void {
    const text = JSON.stringify({ relay: event, role: info.role, peer: info.id });
    for (const ws of this.visiblePeers(info.role)) {
      if ((ws.deserializeAttachment() as SocketInfo | null)?.id === info.id) continue;
      try {
        ws.send(text);
      } catch {
        // Socket is closing.
      }
    }
  }
}
