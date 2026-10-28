import http from 'http';
import { AntigravityAdapter } from '../src/adapter-antigravity/index.ts';
import { SessionManager } from '../src/core/session-manager.ts';
import { RemoteServer } from '../src/server/index.ts';
import { PairingManager } from '../src/pairing/manager.ts';
import { QRCode } from '../src/pairing/qr.ts';
import { bestResultsTips, updateNotice } from '../src/extension/user-guidance.ts';

console.log('='.repeat(75));
console.log('🧪 PAIRING, QR ENCODING & REMOTE ACCESS TEST SUITE (PHASE 5)');
console.log('='.repeat(75));

async function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, desc: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${desc}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${desc}`);
      failed++;
    }
  }

  function fetchUrl(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path, headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
      }).on('error', reject);
    });
  }

  console.log('\n[Suite 1] QR Code Generator (Zero-Dependency)');
  const sampleUrl = 'http://192.168.1.5:49222/pair?t=a1b2c3d4e5f67890';
  const matrix = QRCode.generateMatrix(sampleUrl);
  assert(Array.isArray(matrix) && matrix.length === 33, 'Generated 33x33 QR matrix (Version 4)');
  assert(matrix[0][0] === true && matrix[0][6] === true, 'Top-left finder pattern present');

  const asciiQr = QRCode.toAscii(matrix);
  assert(asciiQr.includes('█'), 'Generated valid Unicode/ASCII terminal QR code');

  const svgQr = QRCode.toSvg(matrix);
  assert(svgQr.startsWith('<svg') && svgQr.includes('</svg>'), 'Generated valid SVG QR code string');

  console.log('\n[Suite 2] IP Address Discovery');
  const adapter = new AntigravityAdapter(process.cwd());
  const sessionManager = new SessionManager(adapter);
  const pairingMgr = new PairingManager(sessionManager.auth);

  const ips = pairingMgr.getLocalIps();
  assert(ips.length > 0, `Discovered local IPs: ${ips.join(', ')}`);
  assert(ips.some((ip) => ip.startsWith('192.168.') || ip.startsWith('10.') || ip === '127.0.0.1' || ip.startsWith('100.')), 'Detected valid reachable IPv4 subnet');

  console.log('\n[Suite 3] Pairing Session Lifecycle & Security Rejection');
  const server = new RemoteServer(sessionManager, { port: 0 });
  const { port: serverPort } = await server.start();

  const pairing = pairingMgr.createPairingSession('127.0.0.1');
  assert(pairing.pairingCode.length === 6 && /^\d{6}$/.test(pairing.pairingCode), 'Pairing code is 6-digit numeric PIN');
  assert(pairing.url.includes(`/pair?t=${pairing.pairingCode}`), 'Pairing URL correctly formatted');

  // 1. Valid exchange
  const ex1 = await fetchUrl(serverPort, `/pair?t=${pairing.pairingCode}`);
  assert(ex1.status === 200, 'Initial pairing exchange returns 200 OK');
  const token = JSON.parse(ex1.body).token;
  assert(token.length >= 32, 'Received valid session token');

  // 2. Reused code rejection (Acceptance criteria: used codes rejected)
  const exReused = await fetchUrl(serverPort, `/pair?t=${pairing.pairingCode}`);
  assert(exReused.status === 401, 'Reused pairing code rejected with 401 Unauthorized');

  // 3. Expired code simulation (Acceptance criteria: expired codes rejected)
  const expiredCode = sessionManager.auth.generatePairingCode();
  // Manually force expiration timestamp to the past
  const entry = (sessionManager.auth as any).pairingCodes.get(expiredCode);
  if (entry) entry.expiresAt = Date.now() - 1000;

  const exExpired = await fetchUrl(serverPort, `/pair?t=${expiredCode}`);
  assert(exExpired.status === 401, 'Expired pairing code rejected with 401 Unauthorized');

  console.log('\n[Suite 4] Session Revocation (Requirement F11)');
  const stateBefore = await fetchUrl(serverPort, '/api/state', { Authorization: `Bearer ${token}` });
  assert(stateBefore.status === 200, 'API authenticated with active token prior to revocation');

  // Revoke pairing
  const { newToken } = pairingMgr.revokeAllPairings();
  assert(newToken !== token, 'Generated new secret token on revocation');

  // Old token must now fail!
  const stateAfter = await fetchUrl(serverPort, '/api/state', { Authorization: `Bearer ${token}` });
  assert(stateAfter.status === 401, 'Old session token immediately rejected with 401 after revocation');

  // New token must work!
  const stateWithNew = await fetchUrl(serverPort, '/api/state', { Authorization: `Bearer ${newToken}` });
  assert(stateWithNew.status === 200, 'New token authenticated successfully after revocation');

  console.log('\n[Suite 5] Server Teardown');
  await server.stop();
  assert(true, 'Server stopped cleanly');

  console.log('\n[Suite 6] Best-results tips and the after-update message');
  const winTips = bestResultsTips('win32');
  const macTips = bestResultsTips('darwin');
  assert(winTips.some(t => t.includes('reload every open Antigravity window') && t.includes('Ctrl+Shift+P')), 'tips: reload every window, with the Windows shortcut');
  assert(macTips.some(t => t.includes('Cmd+Shift+P')) && !macTips.some(t => t.includes('Ctrl+Shift+P')), 'tips: macOS shows Cmd, not Ctrl');
  assert(winTips.some(t => t.includes('Copy Diagnostics')), 'tips: point to Copy Diagnostics when the phone shows no conversation');
  assert(updateNotice(undefined, '0.2.3') === null, 'no update message on a first install');
  assert(updateNotice('0.2.3', '0.2.3') === null, 'no message when the version did not change');
  const notice = updateNotice('0.2.2', '0.2.3') || '';
  assert(notice.includes('0.2.3') && notice.includes('Reload every other open Antigravity window'), 'after an update: says which version and to reload the other windows');

  console.log('\n' + '='.repeat(75));
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(75));

  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
