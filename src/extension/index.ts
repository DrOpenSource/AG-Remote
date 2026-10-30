import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type * as vscodeTypes from 'vscode';
import { AntigravityAdapter } from '../adapter-antigravity/index.ts';
import { LsBridge } from '../adapter-antigravity/ls-bridge.ts';
import { collectDiagnostics } from '../adapter-antigravity/diagnostics.ts';
import { bestResultsTips, updateNotice } from './user-guidance.ts';
import { SessionManager } from '../core/session-manager.ts';
import { RemoteServer } from '../server/index.ts';
import type { RelayPhone } from '../server/http-server.ts';
import { PairingManager, type PairingInfo } from '../pairing/manager.ts';
import { QRCode } from '../pairing/qr.ts';
import { RelayHost, type RelayStatus, type WaitingPhone } from '../relay-host/relay-host.ts';
import { RelayStore } from '../relay-host/relay-store.ts';
import { dataDir } from '../core/data-dir.ts';

let server: RemoteServer | null = null;
let sessionManager: SessionManager | null = null;
let pairingManager: PairingManager | null = null;
let relayHost: RelayHost | null = null;
let statusBarItem: vscodeTypes.StatusBarItem | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let activeWindowId: string | null = null;
let hubPort: number = 49222;
let isHost = false;
/** Set while this window hosts the phone server: its view for diagnostics. */
let hostDiagnostics: (() => Promise<any>) | null = null;

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
  // Hash of the full folder path: a prefix of the path itself is identical for every project under one user.
  activeWindowId = crypto.createHash('sha256').update(currentWorkspace.toLowerCase()).digest('hex').slice(0, 16);

  const config = vscode.workspace.getConfiguration('agRemote');
  const port = config.get<number>('port', 49222);
  // Relay-only by default: the local server then accepts this PC only. Wi-Fi/Tailscale with a PIN is opt-in.
  const transport = config.get<string>('transport', 'relay');
  const relayOn = transport === 'both' || transport === 'relay';
  const wifiOn = transport !== 'relay';
  const relayUrl = config.get<string>('relayUrl') || 'https://remote.taqnik.in';
  // Relay-only still needs the local port for window coordination, but nothing off this PC may reach it.
  const host = wifiOn ? (config.get<string>('host') || '0.0.0.0') : '127.0.0.1';
  hubPort = port;
  // Packaged builds ship the minified copy (npm run build:pwa); a dev checkout serves the sources.
  const builtPwa = path.join(context.extensionPath, 'dist', 'pwa');
  const pwaDir = fs.existsSync(path.join(builtPwa, 'index.html')) ? builtPwa : path.join(context.extensionPath, 'src', 'pwa');
  const identity = () => ({
    windowId: activeWindowId!,
    workspaceName,
    workspacePath: currentWorkspace,
    isFocused: vscode.window.state.focused,
    pid: process.pid
  });

  // Status bar and commands exist once per window; what they do depends on whether this window hosts.
  // Once per new version: other open windows keep the old version until they are reloaded.
  // Versions before 0.2.3 didn't record theirs; an existing data folder means this is an update.
  const version: string = context.extension?.packageJSON?.version || '';
  const lastVersion = context.globalState.get<string>('agRemote.lastVersion') ?? (fs.existsSync(dataDir()) ? 'an earlier version' : undefined);
  const notice = updateNotice(lastVersion, version);
  if (version) context.globalState.update('agRemote.lastVersion', version);
  if (notice) vscode.window.showInformationMessage(notice);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'ag-remote.showPairingQr';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  const relayLabels: Record<RelayStatus, string> = {
    online: 'relay on',
    connecting: 'relay connecting',
    offline: 'relay offline',
    replaced: 'relay moved to another window',
    stopped: 'relay off'
  };
  const showStatus = () => {
    if (!statusBarItem) return;
    const relayStatus = relayHost?.getStatus();
    const icon = relayStatus === 'offline' ? '$(cloud-offline)' : '$(radio-tower)';
    statusBarItem.text = isHost ? `${icon} AG-Remote :${port}` : `$(radio-tower) AG-Remote [${workspaceName}]`;
    statusBarItem.tooltip = isHost
      ? `Antigravity Phone Remote Control (Click to Pair)${relayStatus ? `\nRelay: ${relayLabels[relayStatus]} (${relayUrl})` : ''}`
      : `Antigravity Phone Remote Control (Linked to Hub on :${port})`;
  };

  // Pairing state lives in the host window. Any window can act on it: the host directly, the others
  // over loopback. A null result means the host couldn't be reached.
  const notReachable = () => vscode.window.showWarningMessage('AG-Remote: Could not reach the AG-Remote server window. Try again in a few seconds.');
  const hostRelayList = async (): Promise<{ phones: RelayPhone[]; waiting: WaitingPhone[] } | 'off' | null> => {
    if (isHost) return relayHost ? { phones: relayHost.pairedPhones(), waiting: relayHost.pendingApprovals() } : 'off';
    const res = await postHubJson(port, '/api/hub/relay-phones', {});
    if (!res) return null;
    return Array.isArray(res.phones) ? { phones: res.phones, waiting: Array.isArray(res.waiting) ? res.waiting : [] } : 'off';
  };
  const hostRelayPhones = async (): Promise<RelayPhone[] | 'off' | null> => {
    const list = await hostRelayList();
    return list && list !== 'off' ? list.phones : list;
  };
  const refreshPairingPanel = async () => {
    if (!pairingPanel) return;
    const list = await hostRelayList();
    if (list && list !== 'off') updatePairingPanelPhones(list.phones, list.waiting);
  };
  // Also catches pairings and unpairings made from another window or from the phone.
  const panelPoll = setInterval(() => { if (pairingPanel?.visible) refreshPairingPanel(); }, 3000);
  context.subscriptions.push({ dispose: () => clearInterval(panelPoll) });
  const hostUnpairPhone = async (pub: string): Promise<boolean> => {
    if (isHost) {
      if (!relayHost) return false;
      await relayHost.revoke(pub);
      return true;
    }
    return (await postHubJson(port, '/api/hub/relay-unpair', { pub }))?.ok === true;
  };
  const hostUnpairAll = async (): Promise<{ relay: boolean } | null> => {
    if (isHost) return { relay: await unpairAllHere() };
    const res = await postHubJson(port, '/api/hub/unpair-all', {});
    return res?.ok ? { relay: !!res.relay } : null;
  };
  const unpairAllHere = async (): Promise<boolean> => {
    pairingManager?.revokeAllPairings();
    if (!relayHost) return false;
    await relayHost.revokeAll();
    return true;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('ag-remote.showPairingQr', async () => {
      const list = await hostRelayList();
      const paired = list && list !== 'off' ? list.phones : [];
      if (isHost && pairingManager) {
        const relayPair = relayHost ? await relayHost.createPairingUrl() : undefined;
        showPairingPanel(vscode, {
          relayPairUrl: typeof relayPair === 'string' ? relayPair : relayPair?.url,
          relayCode: typeof relayPair === 'object' ? relayPair?.code : undefined,
          wifi: wifiOn ? pairingManager.createPairingSession() : undefined,
          paired
        });
        return;
      }
      if (relayOn) {
        // The relay connection lives in the host window; ask it (over loopback) for a QR.
        const res = await postHubJson(port, '/api/hub/relay-pair', {});
        if (res?.url) {
          showPairingPanel(vscode, { relayPairUrl: res.url, relayCode: res.code, paired });
          return;
        }
      }
      vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}/pair/view`));
    }),
    // Allow / Deny links in the pairing panel, and the host window's notification.
    vscode.commands.registerCommand('ag-remote.answerPhone', async (id: unknown, allow: unknown) => {
      if (typeof id !== 'string' || typeof allow !== 'boolean') return;
      const answered = isHost
        ? !!relayHost?.answerApproval(id, allow)
        : (await postHubJson(port, '/api/hub/relay-answer', { id, allow }))?.ok === true;
      if (!answered) {
        vscode.window.showWarningMessage('AG-Remote: That phone is no longer waiting (it timed out or left). Pair it again with a new QR code.');
      } else if (!allow && pairingPanel) {
        // The denied phone used up the QR code; show a fresh one for the right phone.
        vscode.commands.executeCommand('ag-remote.showPairingQr');
        return;
      }
      await refreshPairingPanel();
    }),
    vscode.commands.registerCommand('ag-remote.revokePairings', async () => {
      const result = await hostUnpairAll();
      if (!result) return notReachable();
      // The open panel's QR code stopped working, so show a fresh one
      if (pairingPanel) vscode.commands.executeCommand('ag-remote.showPairingQr');
      vscode.window.showInformationMessage(result.relay
        ? 'AG-Remote: All phones unpaired (Wi-Fi and relay). Old QR codes no longer work; pair again to reconnect.'
        : 'AG-Remote: All active phone pairings revoked. Generated new secret token.');
    }),
    vscode.commands.registerCommand('ag-remote.managePhones', async () => {
      const phones = await hostRelayPhones();
      if (phones === null) return notReachable();
      if (phones === 'off') {
        vscode.window.showInformationMessage('AG-Remote: Wi-Fi pairings share one token; use "Revoke All Pairings" to remove them.');
        return;
      }
      if (phones.length === 0) {
        vscode.window.showInformationMessage('AG-Remote: No phones are paired through the relay.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        phones.map((p) => ({ label: p.name || 'Phone', description: `paired ${new Date(p.pairedAt).toLocaleString()}`, pub: p.pub })),
        { placeHolder: 'Select a phone to unpair' }
      );
      if (!pick) return;
      const confirm = await vscode.window.showWarningMessage(`Unpair "${pick.label}"? It will need a new QR code to connect again.`, { modal: true }, 'Unpair');
      if (confirm !== 'Unpair') return;
      if (!(await hostUnpairPhone(pick.pub))) return notReachable();
      await refreshPairingPanel();
      vscode.window.showInformationMessage(`AG-Remote: "${pick.label}" unpaired.`);
    }),
    vscode.commands.registerCommand('ag-remote.restartServer', async () => {
      if (server) {
        await server.stop();
        await server.start();
        vscode.window.showInformationMessage(`AG-Remote: Server restarted on port ${port}`);
      }
    }),
    vscode.commands.registerCommand('ag-remote.diagnostics', async () => {
      // The window serving the phone runs every window's channel with its own code, so ask it what it sees.
      // A host on 0.2.4 or older has no such endpoint and answers with an error.
      const fromHost = isHost && hostDiagnostics ? await hostDiagnostics() : await postHubJson(port, '/api/hub/diagnostics', {});
      const report = await collectDiagnostics({
        workspacePath: currentWorkspace,
        extensionVersion: context.extension?.packageJSON?.version,
        hostsPhoneServer: isHost,
        hostReport: fromHost && Array.isArray(fromHost.windows) ? fromHost : null
      });
      await vscode.env.clipboard.writeText(report);
      const doc = await vscode.workspace.openTextDocument({ content: report, language: 'markdown' });
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage('AG-Remote: Diagnostics copied to the clipboard. They contain no tokens or chat titles.');
    }),
    vscode.window.onDidChangeWindowState((e) => {
      const info = { ...identity(), isFocused: e.focused };
      if (isHost) sessionManager?.registry.register(info);
      else registerWithHub(port, info);
    })
  );

  /**
   * Tries to host the phone server in this window. Only one process can hold the port, so when several
   * windows try at once exactly one wins; the rest get EADDRINUSE and stay linked to the winner.
   */
  const becomeHost = async (): Promise<boolean> => {
    // A bridge per window: newer Antigravity builds run one agent server (agy) per window, and actions
    // must reach that window's. With the older single shared server, every bridge finds the same one.
    // A window's agy is a child of that window's extension host, whose pid each window registers.
    const bridgeFor = (workspacePath: string, ownerPid?: number) =>
      process.env.AG_REMOTE_LIVE_BRIDGE === '0' ? null : new LsBridge({ workspace: workspacePath, ownerPid });
    const adapter = new AntigravityAdapter(currentWorkspace, {}, { lsBridge: bridgeFor(currentWorkspace, process.pid) });
    const sm = new SessionManager(adapter, undefined, {
      hostWindowId: activeWindowId!,
      createChannel: (workspacePath: string, pid?: number) => new AntigravityAdapter(workspacePath, {}, { lsBridge: bridgeFor(workspacePath, pid) })
    });
    const srv = new RemoteServer(sm, { port, host, pwaDir });
    try {
      await srv.start();
    } catch (err: any) {
      sm.dispose();
      if (err?.code !== 'EADDRINUSE') vscode.window.showErrorMessage(`AG-Remote failed to start: ${err?.message || err}`);
      return false;
    }
    sessionManager = sm;
    server = srv;
    pairingManager = new PairingManager(sm.auth, port);
    isHost = true;
    sm.registry.register(identity());
    if (relayOn) await startRelay(sm, srv);
    hostDiagnostics = async () => ({
      version: context.extension?.packageJSON?.version,
      relay: relayHost ? relayHost.getStatus() : 'off',
      relayPhones: relayHost ? relayHost.pairedPhones().length : 0,
      windows: await sm.describeChannels()
    });
    srv.setHostControl({
      unpairAll: unpairAllHere,
      diagnostics: hostDiagnostics,
      ...(relayHost && {
        relayPairUrl: () => relayHost!.createPairingUrl(),
        relayPhones: () => relayHost!.pairedPhones(),
        relayWaiting: () => relayHost!.pendingApprovals(),
        answerRelayPhone: (id: string, allow: boolean) => relayHost!.answerApproval(id, allow),
        unpairRelayPhone: (pub: string) => relayHost!.revoke(pub)
      })
    });
    showStatus();
    return true;
  };

  const startRelay = async (sm: SessionManager, srv: RemoteServer) => {
    if (typeof globalThis.WebSocket !== 'function') {
      vscode.window.showWarningMessage('AG-Remote: This IDE build has no WebSocket client, so the relay is off. Wi-Fi pairing still works.');
      return;
    }
    try {
      const rh = new RelayHost({
        relayUrl,
        store: await RelayStore.load(),
        sessionManager: sm,
        onStatus: () => showStatus(),
        onPaired: (phone) => {
          refreshPairingPanel();
          vscode.window.showInformationMessage(`AG-Remote: Paired "${phone.name || 'phone'}" through the relay.`);
        },
        onApprovalNeeded: (request) => {
          refreshPairingPanel();
          // The open pairing panel asks already. Otherwise ask here; a linked window's panel asks too.
          if (pairingPanel?.visible) return;
          vscode.window.showWarningMessage(
            `AG-Remote: Allow "${request.name || 'phone'}" to control Antigravity? Allow it only if your phone shows the code ${request.code}.`,
            'Allow',
            'Deny'
          ).then((choice) => {
            if (choice) vscode.commands.executeCommand('ag-remote.answerPhone', request.id, choice === 'Allow');
          });
        }
      });
      rh.start();
      relayHost = rh;
    } catch (err: any) {
      vscode.window.showWarningMessage(`AG-Remote: Relay could not start (${err?.message || err}). Wi-Fi pairing still works.`);
    }
  };

  // A linked window checks in every 4s. If the host is gone (closed or reloaded) it tries to take over;
  // the phone stays paired because the session token is stored on disk, not in the host window.
  let takingOver = false;
  const linkToHub = () => {
    if (!isHost) registerWithHub(port, identity());
    showStatus();
    heartbeatTimer = setInterval(async () => {
      if (isHost) {
        sessionManager?.registry.heartbeat(activeWindowId!);
        return;
      }
      const res = await postHubJson(port, '/api/hub/heartbeat', { windowId: activeWindowId });
      if (res && res.ok === false) {
        registerWithHub(port, identity()); // a new host that doesn't know us yet
      } else if (!res && !takingOver) {
        takingOver = true;
        // Spread simultaneous attempts a little; the port decides the winner either way.
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 1000)));
        if (!(await becomeHost())) registerWithHub(port, identity());
        takingOver = false;
      }
    }, 4000);
  };

  // Host if no other window does yet; otherwise link to the window that does.
  await becomeHost();
  linkToHub();
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

export async function deactivate(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (activeWindowId) {
    postHubJson(hubPort, '/api/hub/unregister', { windowId: activeWindowId });
  }
  if (relayHost) {
    relayHost.stop();
    relayHost = null;
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

/**
 * Relay QR (any network) when the relay is on, plus the Wi-Fi PIN/QR when direct mode is on.
 * The relay QR's #fragment is a one-time secret, so it is drawn but not printed as text.
 */
// One pairing panel at a time. Its paired-phones list is redrawn when phones pair or unpair.
let pairingPanel: vscodeTypes.WebviewPanel | null = null;
let pairingPanelState: { relayQr?: string; relayCode?: string; wifi?: PairingInfo; paired: RelayPhone[]; waiting: WaitingPhone[] } | null = null;

function showPairingPanel(vscode: typeof vscodeTypes, opts: { relayPairUrl?: string; relayCode?: string; wifi?: PairingInfo; paired?: RelayPhone[] }) {
  if (!opts.relayPairUrl && !opts.wifi) return;
  if (pairingPanel) {
    pairingPanel.reveal(vscode.ViewColumn.Beside);
  } else {
    pairingPanel = vscode.window.createWebviewPanel(
      'agRemotePairing',
      'Pair Phone - AG-Remote',
      vscode.ViewColumn.Beside,
      // Command links only, no scripts: "Manage" opens the unpair picker, Allow / Deny answer a waiting phone.
      { enableScripts: false, enableCommandUris: ['ag-remote.managePhones', 'ag-remote.answerPhone'] }
    );
    pairingPanel.onDidDispose(() => {
      pairingPanel = null;
      pairingPanelState = null;
    });
  }
  pairingPanelState = {
    relayQr: opts.relayPairUrl ? QRCode.toSvg(QRCode.generateMatrix(opts.relayPairUrl)) : undefined,
    relayCode: opts.relayCode,
    wifi: opts.wifi,
    paired: opts.paired || [],
    waiting: []
  };
  renderPairingPanel();
}

/** Redraws the open panel's phone lists; the QR code and PIN stay the same. */
function updatePairingPanelPhones(paired: RelayPhone[], waiting: WaitingPhone[]) {
  if (!pairingPanelState) return;
  const key = (p: RelayPhone[], w: WaitingPhone[]) => [...p.map((x) => `${x.pub}:${x.name}`), ...w.map((x) => `wait:${x.id}`)].join('|');
  if (key(paired, waiting) === key(pairingPanelState.paired, pairingPanelState.waiting)) return;
  pairingPanelState.paired = paired;
  pairingPanelState.waiting = waiting;
  renderPairingPanel();
}

function renderPairingPanel() {
  if (!pairingPanel || !pairingPanelState) return;
  const { relayQr, relayCode, wifi, paired, waiting } = pairingPanelState;
  if (relayQr) pairingPanel.webview.html = relayPanelHtml(relayQr, relayCode, wifi, paired, waiting);
  else if (wifi) pairingPanel.webview.html = wifiPanelHtml(wifi);
}

function wifiPanelHtml(pairing: PairingInfo): string {
  return `<!DOCTYPE html>
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
    }${TIPS_CSS}
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
  ${tipsHtml()}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** "For best results" box shared by both pairing panels. */
function tipsHtml(): string {
  return `<div class="tips">
    <p><strong>For best results</strong></p>
    <ul>${bestResultsTips(process.platform).map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
  </div>`;
}

const TIPS_CSS = `
    .tips { border-top: 1px solid #334155; margin: 8px auto 0 auto; padding-top: 16px; max-width: 420px; text-align: left; }
    .tips p { text-align: center; }
    .tips ul { margin: 0; padding-left: 18px; }
    .tips li { color: #94a3b8; font-size: 12px; margin-bottom: 8px; }`;

function relayPanelHtml(relayQrSvg: string, relayCode: string | undefined, wifi: PairingInfo | undefined, paired: RelayPhone[], waiting: WaitingPhone[]): string {
  const pin = wifi ? `${wifi.pairingCode.slice(0, 3)} ${wifi.pairingCode.slice(3)}` : '';
  const answer = (id: string, allow: boolean) => `command:ag-remote.answerPhone?${encodeURIComponent(JSON.stringify([id, allow]))}`;
  const waitingHtml = waiting.map((w) => `<div class="ask">
    <p><strong>${escapeHtml(w.name || 'A phone')} wants to connect</strong></p>
    <p>Allow it only if your phone shows this code:</p>
    <div class="pin">${escapeHtml(w.code)}</div>
    <p><a class="btn allow" href="${answer(w.id, true)}">Allow</a> <a class="btn deny" href="${answer(w.id, false)}">Deny</a></p>
  </div>`).join('');
  // Phone names come from the phone, so they are escaped.
  const pairedHtml = paired.length === 0
    ? '<p>No phones paired through the relay yet.</p>'
    : `<ul>${paired.map((p) => `<li><strong>${escapeHtml(p.name || 'Phone')}</strong> <span>paired ${escapeHtml(new Date(p.pairedAt).toLocaleString())}</span></li>`).join('')}</ul>
    <p><a href="command:ag-remote.managePhones">Unpair a phone…</a></p>`;
  return `<!DOCTYPE html>
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
    .wifi {
      border-top: 1px solid #334155;
      margin: 8px auto 0 auto;
      padding-top: 16px;
      max-width: 420px;
    }
    .pin { font-family: monospace; font-size: 22px; letter-spacing: 4px; color: #38bdf8; font-weight: 800; }
    .paired ul { list-style: none; padding: 0; margin: 0 auto 8px auto; max-width: 420px; }
    .paired li { font-size: 13px; padding: 4px 0; }
    .paired li span { color: #64748b; font-size: 11px; }
    .paired a { color: #818cf8; font-size: 13px; }
    .ask { border: 1px solid #f59e0b; background: rgba(245, 158, 11, 0.08); border-radius: 12px; padding: 12px 16px 4px; margin: 0 auto 16px auto; max-width: 380px; }
    .ask p { color: #f8fafc; margin-bottom: 8px; }
    .ask .pin { margin-bottom: 12px; }
    .btn { display: inline-block; padding: 6px 20px; border-radius: 8px; font-weight: 600; font-size: 13px; text-decoration: none; margin: 0 4px 8px; }
    .btn.allow { background: #22c55e; color: #052e16; }
    .btn.deny { background: #334155; color: #f8fafc; }${TIPS_CSS}
  </style>
</head>
<body>
  ${waitingHtml}
  <h2>Pair Your Phone</h2>
  <p>Scan this QR code with your phone camera. It works on any network: mobile data, office or home Wi-Fi.</p>
  <div class="badge">⏱️ One-time code: expires in 5 minutes</div>
  <div class="qr-box">
    ${relayQrSvg}
  </div>
  ${relayCode ? `
  <div style="background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 12px; padding: 12px 16px; margin: 0 auto 16px auto; max-width: 280px;">
    <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #94a3b8; font-weight: 600; margin-bottom: 4px;">Pairing Code</div>
    <div style="font-family: monospace; font-size: 26px; letter-spacing: 4px; color: #38bdf8; font-weight: 800;">${escapeHtml(relayCode.slice(0, 3))} ${escapeHtml(relayCode.slice(3))}</div>
  </div>` : ''}
  <p style="font-size: 11px; color: #64748b;">
    End-to-end encrypted. The relay only forwards scrambled messages; it can't read your code or prompts, or approve anything.
  </p>
  ${wifi ? `<div class="wifi">
    <p>Phone on the same Wi-Fi as this PC? You can also open <strong>${wifi.url.replace(/\/pair\?t=.*$/, '')}</strong> and type this PIN:</p>
    <div class="pin">${pin}</div>
  </div>` : ''}
  <div class="wifi paired">
    <p><strong>Paired phones</strong></p>
    ${pairedHtml}
  </div>
  ${tipsHtml()}
</body>
</html>`;
}
