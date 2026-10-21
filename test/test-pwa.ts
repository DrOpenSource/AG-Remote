import http from 'http';
import { AntigravityAdapter } from '../src/adapter-antigravity/index.ts';
import { SessionManager } from '../src/core/session-manager.ts';
import { RemoteServer } from '../src/server/index.ts';

console.log('='.repeat(75));
console.log('🧪 PWA STATIC DELIVERY & MOBILE API TEST SUITE (PHASE 4)');
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

  function fetchUrl(path: string, headers: Record<string, string> = {}): Promise<{ status: number; type: string; body: string }> {
    return new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: serverPort, path, headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            type: res.headers['content-type'] || '',
            body
          });
        });
      }).on('error', reject);
    });
  }

  const adapter = new AntigravityAdapter(process.cwd());
  const sessionManager = new SessionManager(adapter);
  const server = new RemoteServer(sessionManager, { port: 0 });
  const { port: serverPort } = await server.start();
  const token = sessionManager.auth.getSessionToken();

  console.log('\n[Suite 1] Static PWA Asset Delivery');

  // 1. GET / (index.html)
  const indexRes = await fetchUrl('/');
  assert(indexRes.status === 200, 'GET / returns HTTP 200 OK');
  assert(indexRes.type.includes('text/html'), 'GET / serves Content-Type text/html');
  assert(indexRes.body.includes('id="approvalCard"'), 'index.html contains #approvalCard');
  assert(indexRes.body.includes('id="chatFeed"'), 'index.html contains #chatFeed');
  assert(indexRes.body.includes('id="promptForm"'), 'index.html contains #promptForm');
  assert(indexRes.body.includes('id="btnStop"'), 'index.html contains #btnStop');

  // 2. GET /app.css
  const cssRes = await fetchUrl('/app.css');
  assert(cssRes.status === 200, 'GET /app.css returns HTTP 200 OK');
  assert(cssRes.type.includes('text/css'), 'GET /app.css serves Content-Type text/css');
  assert(cssRes.body.includes('--bg-primary'), 'app.css contains dark mode tokens');

  // 3. GET /app.js
  const jsRes = await fetchUrl('/app.js');
  assert(jsRes.status === 200, 'GET /app.js returns HTTP 200 OK');
  assert(jsRes.type.includes('application/javascript'), 'GET /app.js serves Content-Type application/javascript');
  assert(jsRes.body.includes('connectWebSocket'), 'app.js contains WebSocket connection logic');
  assert(jsRes.body.includes('visibilitychange'), 'app.js contains phone sleep/wake auto-reconnect logic');

  // 4. GET /manifest.json
  const manifestRes = await fetchUrl('/manifest.json');
  assert(manifestRes.status === 200, 'GET /manifest.json returns HTTP 200 OK');
  assert(manifestRes.body.includes('"standalone"'), 'manifest.json specifies "standalone" display mode');

  // 5. GET /sw.js
  const swRes = await fetchUrl('/sw.js');
  assert(swRes.status === 200, 'GET /sw.js returns HTTP 200 OK');
  assert(swRes.body.includes('CACHE_NAME'), 'sw.js provides service worker cache implementation');

  console.log('\n[Suite 2] End-to-End Phone Flow Simulation');
  
  // Client pairs
  const pairingCode = sessionManager.auth.generatePairingCode();
  const pairRes = await fetchUrl(`/pair?t=${pairingCode}`);
  assert(pairRes.status === 200, 'Client pairing code exchange succeeds');
  const exchangedToken = JSON.parse(pairRes.body).token;
  assert(exchangedToken === token, 'Exchanged token matches active session token');

  // Client requests initial state
  const stateRes = await fetchUrl('/api/state', { Authorization: `Bearer ${exchangedToken}` });
  assert(stateRes.status === 200, 'Client state sync succeeds with exchanged token');
  const snapshot = JSON.parse(stateRes.body);
  assert(Array.isArray(snapshot.messages), 'State sync returns message history');

  console.log('\n[Suite 3] Server Teardown');
  await server.stop();
  assert(true, 'Server stopped cleanly');

  console.log('\n' + '='.repeat(75));
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(75));

  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
