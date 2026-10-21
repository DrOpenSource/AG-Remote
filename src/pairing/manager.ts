import os from 'os';
import crypto from 'crypto';
import { QRCode } from './qr.ts';
import { AuthManager } from '../core/auth.ts';

export interface PairingInfo {
  pairingCode: string;
  url: string;
  expiresInSeconds: number;
  asciiQr: string;
  svgQr: string;
}

export class PairingManager {
  private auth: AuthManager;
  private serverPort: number;

  constructor(auth: AuthManager, serverPort: number = 49222) {
    this.auth = auth;
    this.serverPort = serverPort;
  }

  public getLocalIps(): string[] {
    const interfaces = os.networkInterfaces();
    const ips: string[] = [];

    // Prioritize Tailscale IP (starts with 100.)
    let tailscaleIp: string | null = null;

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          if (iface.address.startsWith('100.')) {
            tailscaleIp = iface.address;
          } else {
            ips.push(iface.address);
          }
        }
      }
    }

    if (tailscaleIp) {
      ips.unshift(tailscaleIp);
    }

    if (ips.length === 0) {
      ips.push('127.0.0.1');
    }

    return ips;
  }

  public createPairingSession(customHost?: string): PairingInfo {
    const code = this.auth.generatePairingCode();
    const host = customHost || this.getLocalIps()[0];
    const url = `http://${host}:${this.serverPort}/pair?t=${code}`;

    const matrix = QRCode.generateMatrix(url);
    const asciiQr = QRCode.toAscii(matrix);
    const svgQr = QRCode.toSvg(matrix);

    return {
      pairingCode: code,
      url,
      expiresInSeconds: 300, // 5 minutes
      asciiQr,
      svgQr
    };
  }

  /**
   * Requirement F11: Revoke pairing and regenerate session token from IDE.
   */
  public revokeAllPairings(): { newToken: string } {
    const newToken = crypto.randomBytes(32).toString('hex');
    this.auth.updateSessionToken(newToken);
    return { newToken };
  }
}
