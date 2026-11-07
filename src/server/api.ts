import os from 'os';
import path from 'path';
import { SessionManager } from '../core/session-manager.ts';
import type { PromptImage, PromptFile } from '../core/types.ts';

export const MAX_PROMPT_IMAGES = 4;
/** Decoded bytes across all images in one prompt. The phone compresses well below this. */
export const MAX_PROMPT_IMAGE_BYTES = 6 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export const MAX_PROMPT_FILES = 5;
/** Decoded bytes across all attached documents/files in one prompt (10 MB). */
export const MAX_PROMPT_FILE_BYTES = 10 * 1024 * 1024;
const BLOCKED_FILE_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.dll', '.msi', '.com', '.scr', '.vbs', '.cpl', '.pif'
]);

/** Validates body.files; returns the list, or an error string. */
export function parsePromptFiles(raw: unknown): PromptFile[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return '"files" must be an array';
  if (raw.length > MAX_PROMPT_FILES) return `At most ${MAX_PROMPT_FILES} files per message`;
  let total = 0;
  const out: PromptFile[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') return 'Invalid file entry';
    if (typeof f.name !== 'string' || !f.name.trim()) return 'Each file must have a non-empty name';
    const ext = path.extname(f.name).toLowerCase();
    if (BLOCKED_FILE_EXTENSIONS.has(ext)) {
      return `Executable files like ${ext} are not allowed`;
    }
    if (typeof f.mimeType !== 'string') return 'Each file must have a mimeType';
    if (typeof f.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(f.data)) return 'File data must be base64';
    total += Math.floor(f.data.length * 3 / 4);
    if (total > MAX_PROMPT_FILE_BYTES) return 'Files are too large';
    out.push({ name: f.name, mimeType: f.mimeType, data: f.data });
  }
  return out;
}

/** Validates body.images; returns the list, or an error string. */
export function parsePromptImages(raw: unknown): PromptImage[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return '"images" must be an array';
  if (raw.length > MAX_PROMPT_IMAGES) return `At most ${MAX_PROMPT_IMAGES} images per message`;
  let total = 0;
  const out: PromptImage[] = [];
  for (const img of raw) {
    if (!img || !IMAGE_TYPES.includes(img.mimeType)) return 'Unsupported image type';
    if (typeof img.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(img.data)) return 'Image data must be base64';
    total += Math.floor(img.data.length * 3 / 4);
    if (total > MAX_PROMPT_IMAGE_BYTES) return 'Images are too large';
    out.push({ mimeType: img.mimeType, data: img.data });
  }
  return out;
}

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
    return { status: 200, body: { windows: sm.listWindows(), selectedId: selected?.windowId || null, hostName: os.hostname() } };
  }

  // POST /api/windows/select (Switch active target window from phone)
  if (method === 'POST' && pathname === '/api/windows/select') {
    if (!body || typeof body.windowId !== 'string') return bad('Body must contain "windowId" string');
    const win = sm.selectWindow(body.windowId);
    if (!win) return { status: 404, body: { error: 'Window not found' } };
    return { status: 200, body: { status: 'selected', window: win, snapshot: await sm.getSnapshot(), hostName: os.hostname() } };
  }

  // GET /api/state
  if (method === 'GET' && pathname === '/api/state') {
    return { status: 200, body: { ...(await sm.getSnapshot(query.get('windowId') || undefined)), hostName: os.hostname() } };
  }

  // GET /api/sessions (Discover active Antigravity conversations)
  if (method === 'GET' && pathname === '/api/sessions') {
    return { status: 200, body: { sessions: await sm.listSessions(query.get('windowId') || undefined) } };
  }

  // POST /api/sessions/select (Switch active target session from phone)
  if (method === 'POST' && pathname === '/api/sessions/select') {
    if (!body || typeof body.id !== 'string') return bad('Body must contain "id" string');
    try {
      if (!(await sm.setActiveSession(body.id, windowIdOf(body)))) {
        return { status: 404, body: { error: 'Session not found or cannot be activated' } };
      }
      return { status: 200, body: { status: 'switched', snapshot: await sm.getSnapshot(windowIdOf(body)) } };
    } catch (err: any) {
      return bad(err.message);
    }
  }

  // POST /api/prompt
  if (method === 'POST' && pathname === '/api/prompt') {
    const images = parsePromptImages(body?.images);
    if (typeof images === 'string') return bad(images);
    const files = parsePromptFiles(body?.files);
    if (typeof files === 'string') return bad(files);
    if (!body || typeof body.text !== 'string' || (body.text.trim().length === 0 && images.length === 0 && files.length === 0)) {
      return bad('Body must contain non-empty "text" field or attachments');
    }
    try {
      await sm.sendPrompt(body.text, windowIdOf(body), images, files);
      return { status: 200, body: { status: 'sent' } };
    } catch (err: any) {
      return bad(err.message);
    }
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
