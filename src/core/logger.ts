import fs from 'fs';
import path from 'path';

/**
 * Local-only audit logger.
 * Security Requirement 7: Logs all actions to local disk with timestamps.
 * Zero telemetry, zero external network communication.
 */
export class AuditLogger {
  private logFilePath: string;

  constructor(customPath?: string) {
    const defaultDir = path.join(process.cwd(), '.logs');
    if (!fs.existsSync(defaultDir)) {
      try {
        fs.mkdirSync(defaultDir, { recursive: true });
      } catch (_) {}
    }
    this.logFilePath = customPath || path.join(defaultDir, 'audit.log');
  }

  public log(action: 'PROMPT' | 'APPROVE' | 'DENY' | 'STOP' | 'CONNECT' | 'DISCONNECT', detail: Record<string, unknown>): void {
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      ...detail
    };
    try {
      fs.appendFileSync(this.logFilePath, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      console.error('[AuditLogger] Failed to write log entry:', err);
    }
  }

  public getLogPath(): string {
    return this.logFilePath;
  }
}

export const auditLogger = new AuditLogger();
