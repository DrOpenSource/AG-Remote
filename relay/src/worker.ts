import { Room } from './room.ts';
import { CodeStore } from './codes.ts';
import { ConnLimiter } from './limiter.ts';

export { Room, CodeStore, ConnLimiter };

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  CODES: DurableObjectNamespace<CodeStore>;
  LIMITER: DurableObjectNamespace<ConnLimiter>;
  ASSETS: Fetcher;
  /** New WebSocket connections allowed per IP per minute (wrangler.toml [vars]). */
  WS_CONNECTS_PER_MINUTE?: string;
  /** Pairing-code lookups and registrations allowed per IP per minute (wrangler.toml [vars]). */
  CODE_REQUESTS_PER_MINUTE?: string;
}

// Generous for connections: carriers share one IP across many phones (CGNAT). See limiter.ts.
const DEFAULT_WS_CONNECTS_PER_MINUTE = 60;
// Strict for pairing codes: a person types a code a few times at most, and any lookup is a guess at someone's code.
const DEFAULT_CODE_REQUESTS_PER_MINUTE = 10;
const LIMIT_WINDOW_MS = 60_000;

/** True if this IP is within `limit` per minute for `kind`. Fails open: a limiter error never locks users out. */
async function allow(kind: 'ws' | 'code', limit: number, request: Request, env: Env): Promise<boolean> {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  try {
    return await env.LIMITER.get(env.LIMITER.idFromName(`${kind}:${ip}`)).hit(limit, LIMIT_WINDOW_MS);
  } catch {
    return true;
  }
}

function tooMany(): Response {
  return new Response('Too many requests, try again in a minute', { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } });
}

// 16 random bytes in base64url = 22 chars. Anything else is rejected so rooms can't be guessed.
const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;

// The phone page is the one thing users must trust the relay for, so lock down what it may load.
const PAGE_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-cache'
};

async function withPageHeaders(res: Response): Promise<Response> {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(PAGE_HEADERS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    }

    const ws = url.pathname.match(/^\/ws\/([^/]+)$/);
    if (ws) {
      const roomId = ws[1];
      if (!ROOM_ID.test(roomId)) return new Response('Bad room id', { status: 400 });

      const role = url.searchParams.get('role');
      if (role !== 'host' && role !== 'phone') return new Response('Bad role', { status: 400 });

      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      if (!(await allow('ws', Number(env.WS_CONNECTS_PER_MINUTE) || DEFAULT_WS_CONNECTS_PER_MINUTE, request, env))) return tooMany();

      return env.ROOM.get(env.ROOM.idFromName(roomId)).fetch(request);
    }

    // POST /code — register a short pairing code (called by the extension).
    if (request.method === 'POST' && url.pathname === '/code') {
      if (!(await allow('code', Number(env.CODE_REQUESTS_PER_MINUTE) || DEFAULT_CODE_REQUESTS_PER_MINUTE, request, env))) return tooMany();
      try {
        const body = (await request.json()) as { room?: string; fragment?: string };
        if (typeof body.room !== 'string' || typeof body.fragment !== 'string') {
          return new Response('Bad body', { status: 400 });
        }
        if (!ROOM_ID.test(body.room)) return new Response('Bad room id', { status: 400 });
        const store = env.CODES.get(env.CODES.idFromName('global'));
        const code = await store.store(body.room, body.fragment);
        return Response.json({ code }, { headers: { 'Cache-Control': 'no-store' } });
      } catch {
        return new Response('Bad request', { status: 400 });
      }
    }

    // GET /code/<CODE> — resolve a short pairing code (called by the phone PWA).
    const codeMatch = url.pathname.match(/^\/code\/([A-Za-z0-9]{6})$/);
    if (codeMatch && request.method === 'GET') {
      if (!(await allow('code', Number(env.CODE_REQUESTS_PER_MINUTE) || DEFAULT_CODE_REQUESTS_PER_MINUTE, request, env))) return tooMany();
      const store = env.CODES.get(env.CODES.idFromName('global'));
      const result = await store.lookup(codeMatch[1]);
      if (!result) return Response.json({ error: 'not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
      return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    }

    // /p/<room> is the phone app; the room and #secret are read by the page itself.
    const page = url.pathname.match(/^\/p\/([^/]+)\/?$/);
    if (page) {
      if (!ROOM_ID.test(page[1])) return new Response('Not found', { status: 404 });
      return withPageHeaders(await env.ASSETS.fetch(new Request(new URL('/', url), request)));
    }

    if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/api/') || url.pathname.startsWith('/pair')) {
      return new Response('Not found', { status: 404 });
    }
    return withPageHeaders(await env.ASSETS.fetch(request));
  },
} satisfies ExportedHandler<Env>;
