import { SessionManager } from '../core/session-manager.ts';

export interface ApiResult {
  status: number;
  body: unknown;
}

/** The IDE window a phone request targets; undefined means the selected window. */
function windowIdOf(body: any): string | undefined {
  return body && typeof body.windowId === 'string' && body.windowId ? body.windowId : undefined;
}

const bad = (error: string): ApiResult => ({ status: 400, body: { error } });

/**
 * The phone's API, independent of transport. The local HTTP server and the hosted relay both call
 * this after authenticating the phone. Returns null for a route that doesn't exist.
 */
export async function handlePhoneApi(
  sm: SessionManager,
  method: string,
  pathname: string,
  query: URLSearchParams,
  body: any
): Promise<ApiResult | null> {
  // GET /api/windows (List active, live Antigravity windows)
  if (method === 'GET' && pathname === '/api/windows') {
    const selected = sm.registry.getSelected();
    return { status: 200, body: { windows: sm.listWindows(), selectedId: selected?.windowId || null } };
  }

  // POST /api/windows/select (Switch active target window from phone)
  if (method === 'POST' && pathname === '/api/windows/select') {
    if (!body || typeof body.windowId !== 'string') return bad('Body must contain "windowId" string');
    const win = sm.selectWindow(body.windowId);
    if (!win) return { status: 404, body: { error: 'Window not found' } };
    return { status: 200, body: { status: 'selected', window: win, snapshot: await sm.getSnapshot() } };
  }

  // GET /api/state
  if (method === 'GET' && pathname === '/api/state') {
    return { status: 200, body: await sm.getSnapshot(query.get('windowId') || undefined) };
  }

  // GET /api/sessions (Discover active Antigravity conversations)
  if (method === 'GET' && pathname === '/api/sessions') {
    return { status: 200, body: { sessions: await sm.listSessions(query.get('windowId') || undefined) } };
  }

  // POST /api/sessions/select (Switch active target session from phone)
  if (method === 'POST' && pathname === '/api/sessions/select') {
    if (!body || typeof body.id !== 'string') return bad('Body must contain "id" string');
    if (!(await sm.setActiveSession(body.id, windowIdOf(body)))) {
      return { status: 404, body: { error: 'Session not found or cannot be activated' } };
    }
    return { status: 200, body: { status: 'switched', snapshot: await sm.getSnapshot(windowIdOf(body)) } };
  }

  // POST /api/prompt
  if (method === 'POST' && pathname === '/api/prompt') {
    if (!body || typeof body.text !== 'string' || body.text.trim().length === 0) {
      return bad('Body must contain non-empty "text" field');
    }
    await sm.sendPrompt(body.text, windowIdOf(body));
    return { status: 200, body: { status: 'sent' } };
  }

  // POST /api/approve
  if (method === 'POST' && pathname === '/api/approve') {
    if (!body || typeof body.id !== 'string') return bad('Body must contain "id" string');
    try {
      const responseText = typeof body.response === 'string' ? body.response : (body.response ? JSON.stringify(body.response) : undefined);
      const option = ['allow_once', 'allow_conversation', 'always_allow'].includes(body.option) ? body.option : undefined;
      await sm.approve(body.id, responseText, option, windowIdOf(body));
      return { status: 200, body: { status: 'approved' } };
    } catch (err: any) {
      return bad(err.message);
    }
  }

  // POST /api/deny
  if (method === 'POST' && pathname === '/api/deny') {
    if (!body || typeof body.id !== 'string') return bad('Body must contain "id" string');
    try {
      const reasonText = typeof body.reason === 'string' ? body.reason : undefined;
      await sm.deny(body.id, reasonText, windowIdOf(body));
      return { status: 200, body: { status: 'denied' } };
    } catch (err: any) {
      return bad(err.message);
    }
  }

  // POST /api/stop
  if (method === 'POST' && pathname === '/api/stop') {
    try {
      await sm.stopGeneration(windowIdOf(body));
    } catch (err: any) {
      return bad(err.message);
    }
    return { status: 200, body: { status: 'stopped' } };
  }

  return null;
}
