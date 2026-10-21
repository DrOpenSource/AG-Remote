import http from 'http';
import path from 'path';
import type * as vscodeTypes from 'vscode';
import { AntigravityAdapter } from '../adapter-antigravity/index.ts';
import { SessionManager } from '../core/session-manager.ts';
import { RemoteServer } from '../server/index.ts';
import { PairingManager } from '../pairing/manager.ts';

let server: RemoteServer | null = null;
let sessionManager: SessionManager | null = null;
let pairingManager: PairingManager | null = null;
let statusBarItem: vscodeTypes.StatusBarItem | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let activeWindowId: string | null = null;
let hubPort: number = 49222;

export async function activate(context: vscodeTypes.ExtensionContext): Promise<void> {
  // Dynamically resolve 'vscode' API module provided by extension host
  let vscode: typeof vscodeTypes;
  try {
    vscode = await import('vscode');
  } catch (_) {
    console.warn('[AG-Remote] vscode module not found in runtime environment.');
    return;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const currentWorkspace = workspaceFolders && workspaceFolders.length > 0
    ? workspaceFolders[0].uri.fsPath
    : process.cwd();

  const workspaceName = vscode.workspace.name || path.basename(currentWorkspace) || 'Workspace';
  activeWindowId = Buffer.from(currentWorkspace).toString('base64url').slice(0, 16) || 'win-default';

  const config = vscode.workspace.getConfiguration('agRemote');
  const port = config.get<number>('port', 49222);
  const host = config.get<string>('host') || '0.0.0.0';
  hubPort = port;

  const adapter = new AntigravityAdapter(currentWorkspace);
  sessionManager = new SessionManager(adapter);
  const pwaDir = path.join(context.extensionPath, 'src', 'pwa');
  server = new RemoteServer(sessionManager, { port, host, pwaDir });
  pairingManager = new PairingManager(sessionManager.auth, port);

  try {
    // 1. Primary Window Mode: Successfully bind to port
    const { port: actualPort } = await server.start();
    sessionManager.registry.register({
      windowId: activeWindowId,
      workspaceName,
      workspacePath: currentWorkspace,
      isFocused: vscode.window.state.focused,
      pid: process.pid
    });

    // Window focus change listener
    context.subscriptions.push(
      vscode.window.onDidChangeWindowState((e) => {
        if (sessionManager) {
          sessionManager.registry.register({
            windowId: activeWindowId!,
            workspaceName,
            workspacePath: currentWorkspace,
            isFocused: e.focused,
            pid: process.pid
          });
        }
      })
    );

    setupExtensionUi(context, vscode, pairingManager!, actualPort);
  } catch (err: any) {
    if (err?.code === 'EADDRINUSE') {
      // 2. Secondary Window Mode: Hub server already active on this port
      // Register this window with the primary hub
      registerWithHub(port, {
        windowId: activeWindowId,
        workspaceName,
        workspacePath: currentWorkspace,
        isFocused: vscode.window.state.focused,
        pid: process.pid
      });

      // Start 4s heartbeat
      heartbeatTimer = setInterval(() => {
        sendHubHeartbeat(port, activeWindowId!);
      }, 4000);

      // Report focus changes to hub
      context.subscriptions.push(
        vscode.window.onDidChangeWindowState((e) => {
          registerWithHub(port, {
            windowId: activeWindowId!,
            workspaceName,
            workspacePath: currentWorkspace,
            isFocused: e.focused,
            pid: process.pid
          });
        })
      );

      // Status Bar item for Secondary Window
      statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
      statusBarItem.text = `$(radio-tower) AG-Remote [${workspaceName}]`;
      statusBarItem.tooltip = `Antigravity Phone Remote Control (Linked to Hub on :${port})`;
      statusBarItem.command = 'ag-remote.showPairingQr';
      statusBarItem.show();
      context.subscriptions.push(statusBarItem);

      context.subscriptions.push(
        vscode.commands.registerCommand('ag-remote.showPairingQr', () => {
          vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}/pair/view`));
        })
      );
    } else {
      vscode.window.showErrorMessage(`AG-Remote failed to start: ${err?.message || err}`);
    }
  }
}

function postHubJson(port: number, apiPath: string, data: any): Promise<any> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(data);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: apiPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 1500
      },
      (res) => {
        let respData = '';
        res.on('data', chunk => { respData += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(respData)); } catch (_) { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

function registerWithHub(port: number, info: any): void {
  postHubJson(port, '/api/hub/register', info);
}

function sendHubHeartbeat(port: number, windowId: string): void {
  postHubJson(port, '/api/hub/heartbeat', { windowId });
}

function setupExtensionUi(
  context: vscodeTypes.ExtensionContext,
  vscode: typeof vscodeTypes,
  pairingMgr: PairingManager,
  actualPort: number
) {
  // Create Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = `$(radio-tower) AG-Remote :${actualPort}`;
  statusBarItem.tooltip = 'Antigravity Phone Remote Control (Click to Pair)';
  statusBarItem.command = 'ag-remote.showPairingQr';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Register Command: Show Pairing QR
  context.subscriptions.push(
    vscode.commands.registerCommand('ag-remote.showPairingQr', () => {
      showPairingPanel(vscode, pairingMgr, actualPort);
    })
  );

  // Register Command: Revoke Pairings
  context.subscriptions.push(
    vscode.commands.registerCommand('ag-remote.revokePairings', () => {
      pairingMgr.revokeAllPairings();
      vscode.window.showInformationMessage('AG-Remote: All active phone pairings revoked. Generated new secret token.');
    })
  );

  // Register Command: Restart Server
  context.subscriptions.push(
    vscode.commands.registerCommand('ag-remote.restartServer', async () => {
      if (server) {
        await server.stop();
        await server.start();
        vscode.window.showInformationMessage(`AG-Remote: Server restarted on port ${actualPort}`);
      }
    })
  );
}

export async function deactivate(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (activeWindowId) {
    postHubJson(hubPort, '/api/hub/unregister', { windowId: activeWindowId });
  }
  if (server) {
    await server.stop();
    server = null;
  }
  if (sessionManager) {
    sessionManager.registry.stop();
  }
  if (statusBarItem) {
    statusBarItem.dispose();
    statusBarItem = null;
  }
}

function showPairingPanel(vscode: typeof vscodeTypes, pairingMgr: PairingManager, port: number) {
  const panel = vscode.window.createWebviewPanel(
    'agRemotePairing',
    'Pair Phone - AG-Remote',
    vscode.ViewColumn.Beside,
    { enableScripts: true }
  );

  const pairing = pairingMgr.createPairingSession();

  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 24px;
      background: #0b0f19;
      color: #f8fafc;
      text-align: center;
      line-height: 1.5;
    }
    h2 { font-size: 20px; margin-bottom: 6px; }
    p { color: #94a3b8; font-size: 13px; max-width: 420px; margin: 0 auto 16px auto; }
    .qr-box {
      display: inline-block;
      padding: 16px;
      background: #131b2e;
      border: 1px solid #334155;
      border-radius: 16px;
      margin-bottom: 16px;
    }
    .url-box {
      font-family: monospace;
      font-size: 12px;
      background: #1e293b;
      padding: 8px 12px;
      border-radius: 8px;
      border: 1px solid #334155;
      display: inline-block;
      color: #6366f1;
      word-break: break-all;
      max-width: 90%;
      margin-bottom: 12px;
    }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      background: rgba(245, 158, 11, 0.15);
      color: #f59e0b;
      margin-bottom: 16px;
    }
  </style>
</head>
<body>
  <h2>Pair Your Phone</h2>
  <p>Scan this QR code with your phone camera to connect directly to your Antigravity agent.</p>
  <div class="badge">⏱️ One-Time Code: Expires in 5 minutes</div>
  <div class="qr-box">
    ${pairing.svgQr}
  </div>
  <div style="background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 12px; padding: 12px 16px; margin: 0 auto 16px auto; max-width: 280px;">
    <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #94a3b8; font-weight: 600; margin-bottom: 4px;">6-Digit Pairing PIN</div>
    <div style="font-family: monospace; font-size: 26px; letter-spacing: 4px; color: #38bdf8; font-weight: 800;">${pairing.pairingCode.slice(0, 3)} ${pairing.pairingCode.slice(3)}</div>
  </div>
  <div>
    <div class="url-box">${pairing.url}</div>
  </div>
  <p style="font-size: 11px; color: #64748b;">
    Connected via local Wi-Fi or Tailscale. No data leaves your machine.
  </p>
</body>
</html>`;
}
