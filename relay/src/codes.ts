import { DurableObject } from 'cloudflare:workers';

/**
 * Single-instance Durable Object that maps short alphanumeric codes to relay rooms.
 *
 * Codes are single-use and expire after 5 minutes. The extension calls POST /code
 * to register one alongside a QR code; the phone calls GET /code/<code> to resolve it.
 *
 * Alphabet deliberately omits I, O, 0, 1 to avoid confusion when read aloud or from a screen.
 */

const CODE_LENGTH = 6;
const CODE_TTL_MS = 5 * 60 * 1000;
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 28 chars, no I/O/0/1

export class CodeStore extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS codes (
        code     TEXT PRIMARY KEY,
        room     TEXT NOT NULL,
        fragment TEXT NOT NULL,
        expires  INTEGER NOT NULL
      )
    `);
  }

  /** Stores a room+fragment and returns a fresh short code. */
  async store(room: string, fragment: string): Promise<string> {
    this.cleanup();
    let code: string;
    let attempts = 0;
    do {
      code = this.generate();
      attempts++;
    } while (attempts < 20 && this.exists(code));

    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO codes (code, room, fragment, expires) VALUES (?, ?, ?, ?)`,
      code,
      room,
      fragment,
      Date.now() + CODE_TTL_MS
    );
    return code;
  }

  /** Looks up a code, deletes it (single-use), and returns the room+fragment. */
  async lookup(code: string): Promise<{ room: string; fragment: string } | null> {
    this.cleanup();
    const rows = this.ctx.storage.sql.exec(
      `SELECT room, fragment FROM codes WHERE code = ? AND expires > ?`,
      code.toUpperCase(),
      Date.now()
    ).toArray();
    if (rows.length === 0) return null;
    // Single-use: delete after successful lookup.
    this.ctx.storage.sql.exec(`DELETE FROM codes WHERE code = ?`, code.toUpperCase());
    return { room: rows[0].room as string, fragment: rows[0].fragment as string };
  }

  private cleanup(): void {
    this.ctx.storage.sql.exec(`DELETE FROM codes WHERE expires <= ?`, Date.now());
  }

  private exists(code: string): boolean {
    return (
      this.ctx.storage.sql.exec(`SELECT 1 FROM codes WHERE code = ?`, code).toArray().length > 0
    );
  }

  private generate(): string {
    const bytes = new Uint8Array(CODE_LENGTH);
    crypto.getRandomValues(bytes);
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CHARS[bytes[i] % CHARS.length];
    // Ensure at least one letter so it can't be mistaken for a Wi-Fi 6-digit PIN.
    if (/^\d+$/.test(code)) code = CHARS[0] + code.slice(1);
    return code;
  }
}

