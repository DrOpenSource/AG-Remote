import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SessionManager } from '../core/session-manager.ts';
import { WebSocketServer } from './websocket.ts';
import type { AdapterEvent } from '../core/types.ts';

export interface ServerOptions {
  port?: number;
  host?: string;
  pwaDir?: string;
}

export function resolvePwaDirectory(explicitDir?: string): string {
  const candidates: string[] = [];
  if (explicitDir) {
    candidates.push(explicitDir);
  }

  // 1. Relative to this source file: src/server/http-server.ts -> ../pwa
  try {
    const currentFilePath = fileURLToPath(import.meta.url);
    const serverDir = path.dirname(currentFilePath);
    candidates.push(path.resolve(serverDir, '..', 'pwa'));
  } catch (_) {}

  // 2. Relative to process.cwd()
  candidates.push(path.join(process.cwd(), 'src', 'pwa'));
  candidates.push(path.join(process.cwd(), 'extension', 'src', 'pwa'));

  // 3. Known extension directory in Antigravity IDE
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) {
    candidates.push(path.join(home, '.antigravity-ide', 'extensions', 'ag-remote.ag-remote-0.1.0', 'src', 'pwa'));
  }

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
    await this.sessionManager.start();

    return new Promise((resolve, reject) => {
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address() as any;
        this.port = addr.port;
        resolve({ port: this.port, host: this.host });
      });

      this.server.on('error', (err) => {
        reject(err);
      });
    });
  }

  public async stop(): Promise<void> {
    this.wsServer.close();
    await this.sessionManager.stop();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
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

      // Endpoint: GET /pair/view (Browser visual pairing page on PC)
      if (req.method === 'GET' && url.pathname === '/pair/view') {
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
        const isLoopback = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1';
        const authHeader = req.headers['authorization'];
        let token: string | undefined;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          token = authHeader.slice(7).trim();
        }
        const isAuthenticated = token ? this.sessionManager.auth.verifyToken(token, clientIp) : false;

        if (!isLoopback && !isAuthenticated) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: Loopback or valid token required for hub' }));
          return;
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

        // GET /api/windows (List active, live Antigravity windows)
        if (req.method === 'GET' && url.pathname === '/api/windows') {
          const windows = this.sessionManager.listWindows();
          const selected = this.sessionManager.registry.getSelected();
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
          res.end(JSON.stringify({ windows, selectedId: selected?.windowId || null }));
          return;
        }

        // POST /api/windows/select (Switch active target window from phone)
        if (req.method === 'POST' && url.pathname === '/api/windows/select') {
          const body = await this.readJsonBody(req);
          if (!body || typeof body.windowId !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Body must contain "windowId" string' }));
            return;
          }
          const win = this.sessionManager.selectWindow(body.windowId);
          if (win) {
            const snap = await this.sessionManager.getSnapshot();
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
            res.end(JSON.stringify({ status: 'selected', window: win, snapshot: snap }));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Window not found' }));
          }
          return;
        }

        // GET /api/state
        if (req.method === 'GET' && url.pathname === '/api/state') {
          const snapshot = await this.sessionManager.getSnapshot();
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
          res.end(JSON.stringify(snapshot));
          return;
        }

        // GET /api/sessions (Discover active Antigravity conversations)
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          const sessions = await this.sessionManager.listSessions();
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
          res.end(JSON.stringify({ sessions }));
          return;
        }

        // POST /api/sessions/select (Switch active target session from phone)
        if (req.method === 'POST' && url.pathname === '/api/sessions/select') {
          const body = await this.readJsonBody(req);
          if (!body || typeof body.id !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Body must contain "id" string' }));
            return;
          }
          const success = await this.sessionManager.setActiveSession(body.id);
          if (success) {
            const snap = await this.sessionManager.getSnapshot();
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
            res.end(JSON.stringify({ status: 'switched', snapshot: snap }));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session not found or cannot be activated' }));
          }
          return;
        }

        // POST /api/prompt
        if (req.method === 'POST' && url.pathname === '/api/prompt') {
          const body = await this.readJsonBody(req);
          if (!body || typeof body.text !== 'string' || body.text.trim().length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Body must contain non-empty "text" field' }));
            return;
          }
          await this.sessionManager.sendPrompt(body.text);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'sent' }));
          return;
        }

        // POST /api/approve
        if (req.method === 'POST' && url.pathname === '/api/approve') {
          const body = await this.readJsonBody(req);
          if (!body || typeof body.id !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Body must contain "id" string' }));
            return;
          }
          try {
            const responseText = typeof body.response === 'string' ? body.response : (body.response ? JSON.stringify(body.response) : undefined);
            const option = ['allow_once', 'allow_conversation', 'always_allow'].includes(body.option) ? body.option : undefined;
            await this.sessionManager.approve(body.id, responseText, option);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'approved' }));
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }


        // POST /api/deny
        if (req.method === 'POST' && url.pathname === '/api/deny') {
          const body = await this.readJsonBody(req);
          if (!body || typeof body.id !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Body must contain "id" string' }));
            return;
          }
          try {
            const reasonText = typeof body.reason === 'string' ? body.reason : undefined;
            await this.sessionManager.deny(body.id, reasonText);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'denied' }));
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        // POST /api/stop
        if (req.method === 'POST' && url.pathname === '/api/stop') {
          try {
            await this.sessionManager.stopGeneration();
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'stopped' }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
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
        if (data.length > 1024 * 1024) { // 1MB limit
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
