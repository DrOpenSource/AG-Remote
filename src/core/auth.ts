import fs from 'fs';
import path from 'path';
import { dataDir } from './data-dir.ts';
import crypto from 'crypto';

export interface PairingCode {
  code: string;
  expiresAt: number;
  used: boolean;
}

export class AuthManager {
  private sessionToken: string;
  private pairingCodes: Map<string, PairingCode> = new Map();
  private failedAttempts: Map<string, { count: number; lockedUntil: number }> = new Map();

  private readonly MAX_FAILED_ATTEMPTS = 5;
  private readonly LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes
  private readonly PAIRING_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  private tokenFilePath: string | null = null;

  constructor(customSessionToken?: string, storageDir?: string) {
    if (customSessionToken) {
      this.sessionToken = customSessionToken;
    } else {
      // Persist session token to disk so server restarts don't invalidate phone pairings
      try {
        const dir = storageDir || dataDir();
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        this.tokenFilePath = path.join(dir, 'session.token');
        if (fs.existsSync(this.tokenFilePath)) {
          const saved = fs.readFileSync(this.tokenFilePath, 'utf8').trim();
          if (/^[a-f0-9]{64}$/i.test(saved)) {
            this.sessionToken = saved;
          }
        }
      } catch (_) {}

      if (!this.sessionToken) {
        this.sessionToken = crypto.randomBytes(32).toString('hex');
        if (this.tokenFilePath) {
          try {
            fs.writeFileSync(this.tokenFilePath, this.sessionToken, { mode: 0o600 });
          } catch (_) {}
        }
      }
    }
  }

  public getSessionToken(): string {
    return this.sessionToken;
  }

  /**
   * Generates a single-use 6-digit numeric pairing code (e.g. "849201") with a 5-minute expiration.
   * Also clears temporary IP lockouts since generating a new pairing is an explicit user authorization.
   */
  public generatePairingCode(): string {
    // Unblock any previously locked clients when host initiates a pairing session
    this.failedAttempts.clear();

    const num = crypto.randomInt(100000, 1000000);
    const code = num.toString();
    this.pairingCodes.set(code, {
      code,
      expiresAt: Date.now() + this.PAIRING_CODE_TTL_MS,
      used: false
    });
    return code;
  }

  /**
   * Exchanges a one-time 6-digit pairing code for the persistent session token.
   * Single-use only; immediately invalidated.
   */
  public exchangePairingCode(rawCode: string, clientIp: string = '127.0.0.1'): { success: boolean; token?: string; error?: string } {
    if (this.isLocked(clientIp)) {
      return { success: false, error: 'Too many failed attempts. Client temporarily locked out.' };
    }

    if (!rawCode || typeof rawCode !== 'string') {
      this.recordFailedAttempt(clientIp);
      return { success: false, error: 'Invalid pairing code.' };
    }

    // Normalize code by stripping spaces, hyphens, and whitespace (e.g. "849 201" -> "849201")
    const code = rawCode.trim().replace(/[\s-]/g, '');
    const entry = this.pairingCodes.get(code);
    if (!entry) {
      this.recordFailedAttempt(clientIp);
      return { success: false, error: 'Invalid pairing code.' };
    }

    if (entry.used) {
      this.recordFailedAttempt(clientIp);
      return { success: false, error: 'Pairing code has already been used.' };
    }

    if (Date.now() > entry.expiresAt) {
      this.pairingCodes.delete(code);
      this.recordFailedAttempt(clientIp);
      return { success: false, error: 'Pairing code has expired.' };
    }

    // Invalidate immediately
    entry.used = true;
    this.pairingCodes.delete(code);

    // Reset failed attempts on success
    this.failedAttempts.delete(clientIp);

    return { success: true, token: this.sessionToken };
  }

  /**
   * Constant-time verification of session token using crypto.timingSafeEqual.
   */
  public verifyToken(providedToken: string | undefined | null, clientIp: string = '127.0.0.1'): boolean {
    if (this.isLocked(clientIp)) {
      return false;
    }

    if (!providedToken || typeof providedToken !== 'string') {
      this.recordFailedAttempt(clientIp);
      return false;
    }

    // Constant-time length and content comparison
    const expectedBuf = Buffer.from(this.sessionToken, 'utf8');
    const providedBuf = Buffer.from(providedToken, 'utf8');

    if (expectedBuf.length !== providedBuf.length) {
      this.recordFailedAttempt(clientIp);
      return false;
    }

    const matches = crypto.timingSafeEqual(expectedBuf, providedBuf);
    if (!matches) {
      this.recordFailedAttempt(clientIp);
      return false;
    }

    // Success resets failed count
    this.failedAttempts.delete(clientIp);
    return true;
  }

  private isLocked(clientIp: string): boolean {
    const entry = this.failedAttempts.get(clientIp);
    if (!entry) return false;
    if (Date.now() < entry.lockedUntil) return true;
    if (Date.now() >= entry.lockedUntil && entry.count >= this.MAX_FAILED_ATTEMPTS) {
      // Lock expired
      this.failedAttempts.delete(clientIp);
      return false;
    }
    return false;
  }

  private recordFailedAttempt(clientIp: string): void {
    const now = Date.now();
    const entry = this.failedAttempts.get(clientIp) || { count: 0, lockedUntil: 0 };
    entry.count++;

    if (entry.count >= this.MAX_FAILED_ATTEMPTS) {
      entry.lockedUntil = now + this.LOCKOUT_DURATION_MS;
    }

    this.failedAttempts.set(clientIp, entry);
  }

  public resetPairingCodes(): void {
    this.pairingCodes.clear();
  }

  public updateSessionToken(newToken: string): void {
    this.sessionToken = newToken;
    this.resetPairingCodes();
    this.failedAttempts.clear();
    if (this.tokenFilePath) {
      try {
        fs.writeFileSync(this.tokenFilePath, this.sessionToken, { mode: 0o600 });
      } catch (_) {}
    }
  }
}
