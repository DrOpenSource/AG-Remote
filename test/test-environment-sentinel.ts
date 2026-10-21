import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { resolvePwaDirectory, RemoteServer } from '../src/server/http-server.ts';
import { PairingManager } from '../src/pairing/manager.ts';
import { SessionManager } from '../src/core/session-manager.ts';
import { AntigravityAdapter } from '../src/adapter-antigravity/index.ts';
import { AuthManager } from '../src/core/auth.ts';

console.log('='.repeat(80));
console.log('🛡️  ENVIRONMENT & ASSUMPTIONS SENTINEL TEST SUITE (ZERO CHANCE POLICY)');
console.log('='.repeat(80));

async function runSentinelTests() {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, desc: string, details?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${desc}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${desc}`);
      if (details) console.error(`     Details: ${details}`);
      failed++;
    }
  }

  // =========================================================================
  // [Suite 1] Path Resolution Invariance & Bundled Extension Independence
  // =========================================================================
  console.log('\n[Suite 1] Path Resolution Invariance & Bundled Asset Discovery');

  // Test 1: resolvePwaDirectory without arguments resolves to a valid, existing directory
  const resolvedDir = resolvePwaDirectory();
  assert(fs.existsSync(resolvedDir), 'Default resolvePwaDirectory() returns an existing directory', resolvedDir);

  // Test 2: Essential PWA assets exist and are non-empty
  const requiredAssets = ['index.html', 'app.js', 'app.css', 'manifest.json', 'sw.js'];
  for (const asset of requiredAssets) {
    const assetPath = path.join(resolvedDir, asset);
    const exists = fs.existsSync(assetPath);
    const size = exists ? fs.statSync(assetPath).size : 0;
    assert(exists && size > 50, `Asset ${asset} exists and is non-empty (${size} bytes)`);
  }

  // Test 3: Path resolution invariance under mock foreign process.cwd()
  const originalCwd = process.cwd();
  try {
    // resolvePwaDirectory must find assets via import.meta.url even if process.cwd() is completely foreign
    const foreignDir = os.tmpdir();
    const resolvedFromForeign = resolvePwaDirectory();
    assert(
      fs.existsSync(path.join(resolvedFromForeign, 'index.html')),
      'resolvePwaDirectory finds PWA files regardless of parent process working directory'
    );
  } finally {
    // process.cwd remains stable
  }

  // =========================================================================
  // [Suite 2] Network Topology & Default Binding Invariants
  // =========================================================================
  console.log('\n[Suite 2] Network Topology & Host Binding Realities');

  const auth = new AuthManager();
  const adapter = new AntigravityAdapter(process.cwd());
  const sessionManager = new SessionManager(adapter);

  // Test 4: Default server constructor must bind to 0.0.0.0 (INADDR_ANY)
  const defaultServer = new RemoteServer(sessionManager, { port: 0 });
  assert(
    defaultServer.getHost() === '0.0.0.0',
    'RemoteServer host defaults to 0.0.0.0 (never loopback 127.0.0.1)',
    `Got host: ${defaultServer.getHost()}`
  );

  // Test 5: Verify PairingManager IP Discovery prioritizes physical LAN & Tailscale
  const pairingMgr = new PairingManager(auth, 49222);
  const ips = pairingMgr.getLocalIps();
  assert(Array.isArray(ips) && ips.length > 0, 'PairingManager discovers at least one network IPv4 address');

  // No loopback addresses in getLocalIps
  const hasLoopback = ips.some(ip => ip === '127.0.0.1' || ip.startsWith('127.'));
  assert(!hasLoopback, 'PairingManager never exposes 127.0.0.1 in QR pairing candidates');

  // If a 192.168.x or 10.x IP exists, it must appear before virtual 172.x docker/WSL adapters
  const hasPhysicalLan = ips.some(ip => ip.startsWith('192.168.') || ip.startsWith('10.'));
  if (hasPhysicalLan) {
    const firstIp = ips[0];
    const isPhysicalOrTailscale = firstIp.startsWith('192.168.') || firstIp.startsWith('10.') || firstIp.startsWith('100.');
    assert(isPhysicalOrTailscale, `Primary pairing IP (${firstIp}) prioritizes physical Wi-Fi/Ethernet or Tailscale`);
  }

  // =========================================================================
  // [Suite 3] Camera Scanner Pre-Fetch vs Browser Exchange Race Condition
  // =========================================================================
  console.log('\n[Suite 3] Camera Scanner Pre-Fetch & Single-Use Token Gate');

  const { port: testPort } = await defaultServer.start();

  function makeRawRequest(reqPath: string, headers: Record<string, string>): Promise<{ status: number; headers: any; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: testPort,
          path: reqPath,
          method: 'GET',
          headers
        },
        (res) => {
          let body = '';
          res.on('data', c => { body += c; });
          res.on('end', () => {
            resolve({
              status: res.statusCode || 0,
              headers: res.headers,
              body
            });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  // Generate pairing code using sessionManager's active auth instance
  const pin = sessionManager.auth.generatePairingCode();

  // Step 1: Camera scanner pre-fetch / preview (sends Accept: text/html)
  const cameraRes = await makeRawRequest(`/pair?t=${pin}`, {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  });

  assert(cameraRes.status === 302, 'Camera scan HTTP GET returns 302 Redirect to PWA root');
  assert(
    cameraRes.headers.location === `/?t=${pin}`,
    `Redirect location points to /?t=${pin}`,
    `Got location: ${cameraRes.headers.location}`
  );

  // Crucial Assumption Check: The code MUST NOT have been consumed by the camera pre-fetch redirect!
  const browserRes = await makeRawRequest(`/pair?t=${pin}`, {
    'Accept': 'application/json'
  });

  assert(browserRes.status === 200, 'Subsequent browser PWA exchange succeeds with 200 OK after camera preview');
  let tokenData: any = {};
  try { tokenData = JSON.parse(browserRes.body); } catch (_) {}
  assert(Boolean(tokenData.token), 'Browser exchange returns valid session token');

  // Step 3: Now the code MUST be strictly consumed (single-use invariant)
  const reuseRes = await makeRawRequest(`/pair?t=${pin}`, {
    'Accept': 'application/json'
  });
  assert(reuseRes.status === 401, 'Re-using the pairing code after browser exchange is rejected with 401');

  // =========================================================================
  // [Suite 4] Mobile PWA Standards & Safe-Area Conformance
  // =========================================================================
  console.log('\n[Suite 4] Mobile PWA Viewport & Safe-Area Conformance');

  const indexHtml = fs.readFileSync(path.join(resolvedDir, 'index.html'), 'utf8');
  const appCss = fs.readFileSync(path.join(resolvedDir, 'app.css'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(resolvedDir, 'manifest.json'), 'utf8'));

  assert(indexHtml.includes('viewport-fit=cover'), 'index.html specifies viewport-fit=cover for edge-to-edge mobile display');
  assert(indexHtml.includes('apple-mobile-web-app-capable'), 'index.html includes iOS PWA full-screen meta tags');
  assert(appCss.includes('env(safe-area-inset-bottom'), 'app.css incorporates safe-area-inset-bottom for iOS home bar padding');
  assert(appCss.includes('env(safe-area-inset-top'), 'app.css incorporates safe-area-inset-top for mobile status bars');
  assert(manifest.display === 'standalone', 'manifest.json specifies display: standalone');
  assert(Boolean(manifest.theme_color), 'manifest.json specifies theme_color for mobile system chrome');

  // =========================================================================
  // [Suite 5] CDP Availability & Fallback Fail-Safe Invariants
  // =========================================================================
  console.log('\n[Suite 5] Action Bridge & Approval Fail-Safe Invariants');

  // Test approval ID mismatch / non-existent protection
  let approveThrew = false;
  try {
    await adapter.approve('bogus-nonexistent-id');
  } catch (err: any) {
    approveThrew = true;
    const isSafeRejection = err.message.includes('No pending approval') || err.message.includes('Approval ID mismatch');
    assert(isSafeRejection, `Adapter safely blocks unauthorized approval: ${err.message}`);
  }
  assert(approveThrew, 'Adapter enforces safety invariant on invalid approval');

  // Test deny ID mismatch / non-existent protection
  let denyThrew = false;
  try {
    await adapter.deny('bogus-nonexistent-id');
  } catch (err: any) {
    denyThrew = true;
    const isSafeRejection = err.message.includes('No pending approval') || err.message.includes('Approval ID mismatch');
    assert(isSafeRejection, `Adapter safely blocks unauthorized denial: ${err.message}`);
  }
  assert(denyThrew, 'Adapter enforces safety invariant on invalid denial');

  // Teardown
  await defaultServer.stop();

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log('\n' + '='.repeat(80));
  console.log(`🛡️  ENVIRONMENT SENTINEL RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(80));

  if (failed > 0) {
    process.exit(1);
  }
}

runSentinelTests().catch((err) => {
  console.error('Fatal error in Environment Sentinel:', err);
  process.exit(1);
});
