import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SessionManager } from '../core/session-manager.ts';
import { WebSocketServer } from './websocket.ts';
import { handlePhoneApi } from './api.ts';
import type { AdapterEvent } from '../core/types.ts';
import type { WaitingPhone } from '../relay-host/relay-host.ts';

export interface ServerOptions {
  port?: number;
  host?: string;
  pwaDir?: string;
}

export interface RelayPhone {
  pub: string;
  name: string;
  pairedAt: number;
}

/** Pairing actions only the host window can perform. Relay ones are absent when the relay is off. */
export interface HostControl {
  relayPairUrl?: () => Promise<{ url: string; code?: string } | string | null>;
  relayPhones?: () => RelayPhone[];
  /** Phones that used a valid code and wait for this PC to allow them. */
  relayWaiting?: () => WaitingPhone[];
  /** Allows or denies a waiting phone; false if it is no longer waiting. */
  answerRelayPhone?: (id: string, allow: boolean) => boolean;
  unpairRelayPhone?: (pub: string) => Promise<void>;
  /** Unpairs every phone (Wi-Fi and relay); resolves true if relay phones were included. */
  unpairAll?: () => Promise<boolean>;
}

export function isLoopbackAddress(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export function resolvePwaDirectory(explicitDir?: string): string {
  const candidates: string[] = [];
  if (explicitDir) {
    candidates.push(explicitDir);
  }

  // 1. Relative to this source file: src/server/http-server.ts -> ../pwa or dist/extension.cjs -> ../src/pwa
  try {
    const currentFilePath = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
    const serverDir = path.dirname(currentFilePath);
    candidates.push(path.resolve(serverDir, '..', 'pwa'));
    candidates.push(path.resolve(serverDir, '..', 'src', 'pwa'));
  } catch (_) {}

  // 2. Relative to process.cwd()
  candidates.push(path.join(process.cwd(), 'src', 'pwa'));
  candidates.push(path.join(process.cwd(), 'extension', 'src', 'pwa'));

  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'index.html'))) {
        return dir;
      }
    } catch (_) {}
  }

  return explicitDir || path.join(process.cwd(), 'src', 'pwa');
}

export class RemoteServer {
  private server: http.Server;
  private wsServer: WebSocketServer;
  private sessionManager: SessionManager;
  private host: string;
  private port: number;
  private pwaDir: string;

  constructor(sessionManager: SessionManager, options: ServerOptions = {}) {
    this.sessionManager = sessionManager;
    this.host = options.host || '0.0.0.0'; // Bind to 0.0.0.0 so phone on local Wi-Fi and Tailscale can connect
    this.port = typeof options.port === 'number' ? options.port : 49222;
    this.pwaDir = resolvePwaDirectory(options.pwaDir);

    this.wsServer = new WebSocketServer(this.sessionManager.auth);

    // Relay adapter events to connected WebSocket clients
    this.sessionManager.on('adapter_event', (e: AdapterEvent) => {
      this.wsServer.broadcast(e);
    });

    this.server = http.createServer(this.handleRequest.bind(this));

    // Handle WebSocket Upgrade
    this.server.on('upgrade', (req, socket, head) => {
      this.wsServer.handleUpgrade(req, socket, head);
    });
  }

  public async start(): Promise<{ port: number; host: string }> {
    // Claim the port before connecting to the IDE: a window that loses the race to host
    // (EADDRINUSE) must not be left with a half-started session.
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once('error', onError);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', onError);
        const addr = this.server.address() as any;
        this.port = addr.port;
        resolve();
      });
    });
    await this.sessionManager.start();
    return { port: this.port, host: this.host };
  }

  public async stop(): Promise<void> {
    this.wsServer.close();
    await this.sessionManager.stop();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private hostControl: HostControl = {};

  /** Set by the host window, so linked windows can pair, list and unpair phones through it. */
  public setHostControl(control: HostControl): void {
    this.hostControl = control;
  }

  public getPort(): number {
    return this.port;
  }

  public getHost(): string {
    return this.host;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const clientIp = req.socket.remoteAddress || '127.0.0.1';

    // Set Security Headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    // Handle CORS (restrictive)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Endpoint: GET /pair?t=<code\>
      if (req.method === 'GET' && url.pathname === '/pair') {
        const accept = req.headers.accept || '';
        const code = url.searchParams.get('t') || '';

        // If client is a browser or camera scan (Accept: text/html), redirect to PWA UI
        if (accept.includes('text/html')) {
          res.writeHead(302, {
            'Location': `/?t=${encodeURIComponent(code)}`,
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          });
          res.end();
          return;
        }

        const exchange = this.sessionManager.auth.exchangePairingCode(code, clientIp);
        if (!exchange.success) {
          res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
          res.end(JSON.stringify({ error: exchange.error || 'Pairing failed' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify({ token: exchange.token }));
        return;
      }

      // Endpoint: GET /pair/view (Browser visual pairing page on PC - loopback only)
      if (req.method === 'GET' && url.pathname === '/pair/view') {
        if (!isLoopbackAddress(clientIp) || req.headers.origin) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden: Pairing view is only accessible from this PC (loopback)' }));
          return;
        }

        const code = this.sessionManager.auth.generatePairingCode();
        const hostHeader = req.headers.host || `127.0.0.1:${this.port}`;
        // Resolve LAN IP if host is localhost
        const hostName = hostHeader.split(':')[0];
        let displayHost = hostHeader;
        if (hostName === '127.0.0.1' || hostName === 'localhost') {
          const os = await import('os');
          const ifaces = os.networkInterfaces();
          let lanIp = '127.0.0.1';
          for (const name of Object.keys(ifaces)) {
            for (const iface of ifaces[name] || []) {
              if (iface.family === 'IPv4' && !iface.internal) {
                lanIp = iface.address;
                break;
              }
            }
          }
          displayHost = `${lanIp}:${this.port}`;
        }
        const pairingUrl = `http://${displayHost}/pair?t=${code}`;
        const { QRCode } = await import('../pairing/qr.ts');
        const matrix = QRCode.generateMatrix(pairingUrl);
        const svg = QRCode.toSvg(matrix, '#000000', '#ffffff');

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AG-Remote Phone Pairing</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0b0f19;
      color: #f8fafc;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
      text-align: center;
    }
    .card {
      background: #131b2e;
      border: 1px solid #334155;
      border-radius: 20px;
      padding: 32px;
      max-width: 440px;
      box-shadow: 0 12px 36px rgba(0,0,0,0.4);
    }
    h1 { font-size: 22px; margin-bottom: 8px; }
    p { color: #94a3b8; font-size: 14px; margin-bottom: 20px; line-height: 1.4; }
    .qr-container {
      background: #ffffff;
      padding: 16px;
      border-radius: 16px;
      display: inline-block;
      margin-bottom: 20px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.25);
    }
    .badge {
      display: inline-block;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      background: rgba(245, 158, 11, 0.15);
      color: #f59e0b;
      margin-bottom: 20px;
      border: 1px solid rgba(245, 158, 11, 0.3);
    }
    .url-box {
      font-family: monospace;
      font-size: 13px;
      background: #0b0f19;
      border: 1px solid #334155;
      padding: 10px 14px;
      border-radius: 8px;
      color: #818cf8;
      word-break: break-all;
      margin-bottom: 12px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>📱 Scan with Phone Camera</h1>
    <p>Point your phone camera at the QR code below to connect to your Antigravity agent.</p>
    <div class="badge">⏱️ Single-Use Code: Valid for 5 Minutes</div>
    <div class="qr-container">
      ${svg}
    </div>
    <div style="background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 12px; padding: 14px 16px; margin-bottom: 16px; text-align: center;">
      <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #94a3b8; font-weight: 600; margin-bottom: 6px;">6-Digit Pairing PIN (for Manual Entry)</div>
      <div style="font-family: monospace; font-size: 32px; letter-spacing: 6px; color: #38bdf8; font-weight: 800; user-select: all;">${code.slice(0, 3)} ${code.slice(3)}</div>
      <div style="font-size: 11px; color: #64748b; margin-top: 4px;">Type these 6 digits on your phone</div>
    </div>
    <div style="text-align: left; margin-bottom: 8px;">
      <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #94a3b8; font-weight: 600; margin-bottom: 4px;">Direct Link</div>
      <div class="url-box"><a href="${pairingUrl}" target="_blank" style="color: #818cf8; text-decoration: none;">${pairingUrl}</a></div>
    </div>
    <p style="font-size: 12px; color: #64748b; margin-top: 14px; margin-bottom: 0;">
      Ensure your phone is connected to the same Wi-Fi network as this PC.
    </p>
  </div>
</body>
</html>`;

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // Hub endpoints: Allow loopback callers or valid auth token
      if (url.pathname.startsWith('/api/hub/')) {
        const isLoopback = isLoopbackAddress(clientIp);
        const authHeader = req.headers['authorization'];
        let token: string | undefined;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          token = authHeader.slice(7).trim();
        }
        const isAuthenticated = token ? this.sessionManager.auth.verifyToken(token, clientIp) : false;

        // IDE windows call these from Node, which sends no Origin. A browser always does, so a web page
        // the user happens to have open can't reach the hub through loopback.
        if (req.headers.origin || (!isLoopback && !isAuthenticated)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: Loopback or valid token required for hub' }));
          return;
        }

        // Pairing control for linked IDE windows. These hand out or remove pairings, so this PC only,
        // never a token holder.
        const control = this.hostControl;
        const sendJson = (status: number, payload: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(payload));
        };
        const pairingPaths = ['/api/hub/relay-pair', '/api/hub/relay-phones', '/api/hub/relay-answer', '/api/hub/relay-unpair', '/api/hub/unpair-all'];
        if (req.method === 'POST' && pairingPaths.includes(url.pathname)) {
          if (!isLoopback) return sendJson(403, { error: 'Only IDE windows on this PC can manage pairing' });
          if (url.pathname === '/api/hub/unpair-all') {
            if (!control.unpairAll) return sendJson(404, { error: 'Not available' });
            return sendJson(200, { ok: true, relay: await control.unpairAll() });
          }
          if (!control.relayPairUrl || !control.relayPhones || !control.unpairRelayPhone) {
            return sendJson(404, { error: 'Relay is not enabled' });
          }
          if (url.pathname === '/api/hub/relay-pair') {
            const pairResult = await control.relayPairUrl();
            if (!pairResult) return sendJson(404, { error: 'Relay is not enabled' });
            return typeof pairResult === 'string' ? sendJson(200, { url: pairResult }) : sendJson(200, pairResult);
          }
          if (url.pathname === '/api/hub/relay-phones') {
            return sendJson(200, { phones: control.relayPhones(), waiting: control.relayWaiting?.() || [] });
          }
          const body = await this.readJsonBody(req);
          if (url.pathname === '/api/hub/relay-answer') {
            if (typeof body?.id !== 'string' || typeof body?.allow !== 'boolean') return sendJson(400, { error: 'Body must contain id and allow (true or false)' });
            return sendJson(200, { ok: control.answerRelayPhone?.(body.id, body.allow) === true });
          }
          if (typeof body?.pub !== 'string') return sendJson(400, { error: 'Body must contain pub' });
          await control.unpairRelayPhone(body.pub);
          return sendJson(200, { ok: true });
        }

        if (req.method === 'POST' && url.pathname === '/api/hub/register') {
          const body = await this.readJsonBody(req);
          if (!body || !body.windowId || !body.workspacePath) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Body must contain windowId and workspacePath' }));
            return;
          }
          const win = this.sessionManager.registry.register(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'registered', window: win }));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/hub/heartbeat') {
          const body = await this.readJsonBody(req);
          if (!body || !body.windowId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Body must contain windowId' }));
            return;
          }
          const ok = this.sessionManager.registry.heartbeat(body.windowId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok }));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/hub/unregister') {
          const body = await this.readJsonBody(req);
          if (body?.windowId) {
            this.sessionManager.registry.unregister(body.windowId);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      }

      // Authenticate all /api/* endpoints
      if (url.pathname.startsWith('/api/')) {
        const authHeader = req.headers['authorization'];
        let token: string | undefined;

        if (authHeader && authHeader.startsWith('Bearer ')) {
          token = authHeader.slice(7).trim();
        }

        if (!this.sessionManager.auth.verifyToken(token, clientIp)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: Valid Bearer token required' }));
          return;
        }

        // Bad JSON is a 500 (via the catch below), except for stop, which needs no body.
        const body = req.method === 'POST'
          ? await this.readJsonBody(req).catch((err) => { if (url.pathname === '/api/stop') return {}; throw err; })
          : undefined;
        const result = await handlePhoneApi(this.sessionManager, req.method || 'GET', url.pathname, url.searchParams, body);
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (req.method === 'GET' || result?.status === 200) headers['Cache-Control'] = 'no-cache';
        res.writeHead(result ? result.status : 404, headers);
        res.end(JSON.stringify(result ? result.body : { error: 'Not Found' }));
        return;
      }

      // Serve static PWA files if directory exists
      if (req.method === 'GET') {
        const filePath = path.join(this.pwaDir, url.pathname === '/' ? 'index.html' : url.pathname);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath);
          const mimeTypes: Record<string, string> = {
            '.html': 'text/html',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.json': 'application/json',
            '.png': 'image/png',
            '.svg': 'image/svg+xml'
          };
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
          res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
          fs.createReadStream(filePath).pipe(res);
          return;
        }
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'Internal Server Error' }));
    }
  }

  private readJsonBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => {
        data += chunk;
        if (data.length > 10 * 1024 * 1024) { // 10MB: room for base64 image attachments
          reject(new Error('Body payload too large'));
        }
      });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (e) {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', err => reject(err));
    });
  }
}
