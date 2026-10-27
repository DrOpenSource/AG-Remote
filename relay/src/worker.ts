import { Room } from './room.ts';

export { Room };

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
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

      return env.ROOM.get(env.ROOM.idFromName(roomId)).fetch(request);
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
