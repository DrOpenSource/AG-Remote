import { Room } from './room.ts';

export { Room };

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
}

// 16 random bytes in base64url = 22 chars. Anything else is rejected so rooms can't be guessed.
const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    }

    const match = url.pathname.match(/^\/ws\/([^/]+)$/);
    if (!match) return new Response('Not found', { status: 404 });

    const roomId = match[1];
    if (!ROOM_ID.test(roomId)) return new Response('Bad room id', { status: 400 });

    const role = url.searchParams.get('role');
    if (role !== 'host' && role !== 'phone') return new Response('Bad role', { status: 400 });

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    return env.ROOM.get(env.ROOM.idFromName(roomId)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
