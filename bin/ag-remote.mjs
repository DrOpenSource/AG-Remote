#!/usr/bin/env node
import path from 'path';
import { fileURLToPath } from 'url';
import { AntigravityAdapter } from '../src/adapter-antigravity/index.ts';
import { SessionManager } from '../src/core/session-manager.ts';
import { RemoteServer } from '../src/server/index.ts';
import { PairingManager } from '../src/pairing/manager.ts';

const PORT = parseInt(process.env.PORT || '49222', 10);
// Bind to 0.0.0.0 so both localhost and mobile devices on Wi-Fi can connect
const HOST = process.env.HOST || '0.0.0.0';

console.log('='.repeat(70));
console.log('🚀 ANTIGRAVITY PHONE REMOTE CONTROL (AG-REMOTE)');
console.log('='.repeat(70));

async function startServer(targetPort) {
  const pwaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pwa');
  const adapter = new AntigravityAdapter(process.cwd());
  const sessionManager = new SessionManager(adapter);
  const server = new RemoteServer(sessionManager, { port: targetPort, host: HOST, pwaDir });
  const pairingManager = new PairingManager(sessionManager.auth, targetPort);

  try {
    const { port } = await server.start();
    const primaryIp = pairingManager.getLocalIps()[0] || '127.0.0.1';

    // Register active workspace with window hub
    const cwd = process.cwd().replace(/\\/g, '/');
    const wsName = cwd.split('/').pop() || 'Workspace';
    sessionManager.registry.register({
      windowId: 'cli-' + Buffer.from(cwd).toString('base64url').slice(0, 12),
      workspaceName: wsName,
      workspacePath: cwd,
      isFocused: true,
      pid: process.pid
    });

    const sessions = sessionManager.listSessions();
    const current = sessions.find(s => s.isCurrent) || sessions[0];

    console.log(`\n✅ AG-Remote Server active:`);
    console.log(`   - PC Localhost:     http://localhost:${port}`);
    console.log(`   - Wi-Fi Network:    http://${primaryIp}:${port}`);
    console.log(`   - Visual QR on PC:  http://localhost:${port}/pair/view`);
    if (current) {
      const ws = current.workspace ? (current.workspace.split(/[\\/]/).pop() || current.workspace) : 'Active Workspace';
      console.log(`   - Attached Window:  [${ws}] ${current.title}`);
    }

    const pairing = pairingManager.createPairingSession(primaryIp);
    console.log('\n📲 SCAN THIS QR CODE WITH YOUR PHONE CAMERA:\n');
    console.log(pairing.asciiQr);
    console.log(`\n🔑 6-DIGIT PAIRING PIN: ${pairing.pairingCode.slice(0, 3)} ${pairing.pairingCode.slice(3)}`);
    console.log(`Direct Pairing Link (5 min single-use):`);
    console.log(`👉 ${pairing.url}\n`);
    console.log(`💡 Tip: If your terminal font distorts the QR code, open this link in your PC browser to view a crisp, scannable QR on your monitor:`);
    console.log(`👉 http://localhost:${port}/pair/view\n`);
    console.log('Press Ctrl+C to stop.\n');
    return server;
  } catch (err) {
    if (err.code === 'EADDRINUSE' && targetPort < 49230) {
      console.log(`⚠️ Port ${targetPort} is in use, trying port ${targetPort + 1}...`);
      return startServer(targetPort + 1);
    }
    throw err;
  }
}

let activeServer = null;
try {
  activeServer = await startServer(PORT);
} catch (err) {
  console.error('❌ Failed to start AG-Remote server:', err);
  process.exit(1);
}

process.on('SIGINT', async () => {
  console.log('\nStopping server...');
  if (activeServer) await activeServer.stop();
  process.exit(0);
});
