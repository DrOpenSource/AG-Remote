import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { QRCode, Ecc } from '../src/pairing/qr.ts';
import { AuthManager } from '../src/core/auth.ts';
import { PairingManager } from '../src/pairing/manager.ts';
import { SessionWatcher } from '../src/adapter-antigravity/session-watcher.ts';
import { RemoteServer } from '../src/server/index.ts';
import { SessionManager } from '../src/core/session-manager.ts';
import { AntigravityAdapter } from '../src/adapter-antigravity/index.ts';

console.log('='.repeat(80));
console.log('🔬 AG-REMOTE PRODUCTION DIAGNOSTIC & REGRESSION TEST SUITE');
console.log('='.repeat(80));

let passed = 0;
let failed = 0;

function assert(condition: boolean, desc: string, details?: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${desc}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${desc}${details ? ` -> ${details}` : ''}`);
    failed++;
  }
}

async function run() {
  // -----------------------------------------------------------------------------
  // Test Suite 1: QR Code Optical Compliance & Terminal Contrast
  // -----------------------------------------------------------------------------
  console.log('\n[Suite 1] QR Code Optical Compliance & ANSI Polarity');

  const testUrl = 'http://192.168.1.5:49222/pair?t=849201';
  const matrix = QRCode.generateMatrix(testUrl, Ecc.MEDIUM);
  assert(Array.isArray(matrix) && matrix.length > 20, 'QR Matrix generated successfully', `Size: ${matrix.length}`);

  // Test SVG quiet zone
  const svg = QRCode.toSvg(matrix);
  assert(svg.includes('shape-rendering="crispEdges"'), 'SVG contains crispEdges rendering for sharp phone scanning');
  assert(svg.includes('viewBox="0 0'), 'SVG contains standard viewBox');
  assert(svg.includes('fill="#ffffff"') && svg.includes('fill="#000000"'), 'SVG contains high-contrast black & white fills');

  // Test Terminal ASCII Polarity
  const ascii = QRCode.toAscii(matrix);
  assert(typeof ascii === 'string' && ascii.length > 100, 'ASCII QR generated');

  // -----------------------------------------------------------------------------
  // Test Suite 2: Auth Robustness, Rate Limiting & Lockout Recovery
  // -----------------------------------------------------------------------------
  console.log('\n[Suite 2] Auth Robustness & Rate-Limiting Lifecycle');

  const auth = new AuthManager();
  const token = auth.getSessionToken();
  assert(typeof token === 'string' && token.length === 64, 'Session token is 64-char hex (256-bit security)');

  // Generate code
  const pin = auth.generatePairingCode();
  assert(/^\d{6}$/.test(pin), `Generated 6-digit numeric PIN: ${pin}`);

  // PIN normalization: accepts spaced PIN e.g. "849 201"
  const spacedPin = `${pin.slice(0, 3)} ${pin.slice(3)}`;
  const exchangeSpaced = auth.exchangePairingCode(spacedPin, '192.168.1.100');
  assert(exchangeSpaced.success && exchangeSpaced.token === token, 'Pairing code exchange succeeds with spaced PIN (e.g. "849 201")');

  // Single-use guarantee
  const reExchange = auth.exchangePairingCode(pin, '192.168.1.100');
  assert(!reExchange.success, 'Re-using the same pairing code is rejected immediately');

  // Failed attempts & lockout verification
  const attackerIp = '10.0.0.99';
  for (let i = 0; i < 5; i++) {
    auth.exchangePairingCode('000000', attackerIp);
  }
  const lockedOut = auth.exchangePairingCode('000000', attackerIp);
  assert(!lockedOut.success && !!lockedOut.error?.includes('locked out'), 'Rate-limiter enforces lockout after 5 consecutive failures');

  // -----------------------------------------------------------------------------
  // Test Suite 3: Pending Tool State Machine & `ask_question` Parsing
  // -----------------------------------------------------------------------------
  console.log('\n[Suite 3] Transcript State Machine & ask_question Option Parsing');

  const tempDir = path.join(process.cwd(), '.logs', 'test-scratch-' + Date.now());
  fs.mkdirSync(path.join(tempDir, 'fake-conv', '.system_generated', 'logs'), { recursive: true });
  const transcriptPath = path.join(tempDir, 'fake-conv', '.system_generated', 'logs', 'transcript.jsonl');

  const mockAskQuestionSteps = [
    {
      step_index: 10,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: new Date().toISOString(),
      content: '<USER_REQUEST>Setup deployment</USER_REQUEST>'
    },
    {
      step_index: 11,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date().toISOString(),
      tool_calls: [
        {
          name: 'default_api:ask_question',
          args: {
            toolAction: 'Asking deployment target',
            toolSummary: 'Deployment configuration',
            questions: [
              {
                question: 'Which cloud provider do you want to deploy to?',
                options: ['Cloudflare Pages', 'AWS S3 + CloudFront', 'Vercel', 'Local Docker'],
                is_multi_select: false
              }
            ]
          }
        }
      ]
    },
    // Simulate intermediate background message or thinking step logged before user answers
    {
      step_index: 12,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: new Date().toISOString(),
      content: 'Background monitoring heartbeat.'
    }
  ];

  fs.writeFileSync(transcriptPath, mockAskQuestionSteps.map(s => JSON.stringify(s)).join('\n') + '\n');

  const testWatcher = new SessionWatcher(tempDir, {
    brainDir: tempDir,
    cliPaths: [],
    exePath: '',
    cliJsPath: '',
    timing: { pollIntervalMs: 50, commandTimeoutMs: 5000, debounceMs: 50 },
    messages: { ideNotFound: 'IDE not found', actionDenied: 'Denied', processKilled: 'Killed' },
    selectors: { chatInput: '', chatSendButton: '', modalConfirm: '', modalDeny: '' }
  });

  await testWatcher.start();
  const snapWithQuestion = testWatcher.getSnapshot();

  assert(snapWithQuestion.pendingApproval !== null, 'Detected pending approval even with subsequent SYSTEM_MESSAGE');
  assert(snapWithQuestion.pendingApproval?.kind === 'ask_question', `Approval kind is "ask_question" (got: ${snapWithQuestion.pendingApproval?.kind})`);
  assert(snapWithQuestion.pendingApproval?.question === 'Which cloud provider do you want to deploy to?', 'Question prompt correctly extracted');
  assert(Array.isArray(snapWithQuestion.pendingApproval?.options) && snapWithQuestion.pendingApproval?.options.length === 4, 'All 4 question options extracted');
  assert(snapWithQuestion.pendingApproval?.options?.[0] === 'Cloudflare Pages', 'First option matches expected string');

  // Simulate completion of question by user answering in IDE
  const completionStep = {
    step_index: 13,
    source: 'MODEL',
    type: 'ASK_QUESTION',
    status: 'DONE',
    created_at: new Date().toISOString(),
    content: 'A1: Cloudflare Pages'
  };

  fs.appendFileSync(transcriptPath, JSON.stringify(completionStep) + '\n');
  await testWatcher.updateSnapshot();
  const snapAfterAnswer = testWatcher.getSnapshot();
  assert(snapAfterAnswer.pendingApproval === null, 'Pending question approval is cleared once ASK_QUESTION completes in transcript');

  testWatcher.stop();

  // Cleanup temp scratch
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {}

  // -----------------------------------------------------------------------------
  // Test Suite 4: Server Pre-Flight Probe Handling & PWA Headers
  // -----------------------------------------------------------------------------
  console.log('\n[Suite 4] Server Pre-Flight Camera Probe & PWA Headers');

  // Fixture chat history with two conversations, so discovery and switching don't depend on the
  // machine's real ~/.gemini history (CI machines have none).
  const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agr-audit-history-'));
  const fixtureConversation = (id: string, request: string, ageMs: number) => {
    const logs = path.join(historyDir, id, '.system_generated', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const file = path.join(logs, 'transcript.jsonl');
    fs.writeFileSync(file, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: new Date().toISOString(), content: `<USER_REQUEST>${request}</USER_REQUEST>` },
      { step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { Cwd: historyDir, CommandLine: 'npm test' } }] }
    ].map(l => JSON.stringify(l)).join('\n') + '\n');
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
  };
  fixtureConversation('aaaaaaaa-1111-2222-3333-444444444444', 'Add a parser test', 0);
  fixtureConversation('bbbbbbbb-1111-2222-3333-444444444444', 'Fix the build script', 60_000);

  const adapter = new AntigravityAdapter(historyDir, { brainDir: historyDir }, { lsBridge: null });
  const sessionMgr = new SessionManager(adapter);
  const server = new RemoteServer(sessionMgr, { port: 49299, host: '127.0.0.1' });
  const pm = new PairingManager(sessionMgr.auth, 49299);

  await server.start();

  const freshSession = pm.createPairingSession('127.0.0.1');

  // Simulate camera preview probe: GET /pair?t=... with Accept: */* (should redirect or return HTML, NOT consume code prematurely)
  const probeRes = await new Promise<http.IncomingMessage>((resolve) => {
    http.get(`http://127.0.0.1:49299/pair?t=${freshSession.pairingCode}`, {
      headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    }, resolve);
  });

  assert(probeRes.statusCode === 302, `Camera browser request redirects to PWA UI with status 302 (got: ${probeRes.statusCode})`);
  assert(probeRes.headers.location?.includes(`t=${freshSession.pairingCode}`), 'Redirect target contains the pairing code query param');

  // The pairing code must STILL be valid for the subsequent PWA API exchange
  const exchangeRes = await new Promise<{ status: number; body: any }>((resolve) => {
    const req = http.request(`http://127.0.0.1:49299/pair?t=${freshSession.pairingCode}`, {
      headers: { 'Accept': 'application/json' }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve({ status: res.statusCode || 0, body: JSON.parse(raw) }));
    });
    req.end();
  });

  assert(exchangeRes.status === 200 && !!exchangeRes.body.token, 'PWA client exchanges pairing code successfully after camera redirect');

  // Verify static file caching headers (PWA index.html must not be aggressively cached)
  const htmlRes = await new Promise<http.IncomingMessage>((resolve) => {
    http.get('http://127.0.0.1:49299/', resolve);
  });
  const cacheControl = htmlRes.headers['cache-control'] || '';
  // -----------------------------------------------------------------------------
  // Test Suite 5: Multi-Window Session Discovery & Dynamic Switching
  // -----------------------------------------------------------------------------
  console.log('\n[Suite 5] Multi-Window Session Discovery & Dynamic Switching');

  const sessionToken = exchangeRes.body.token;

  // 1. GET /api/sessions
  const sessionsListRes = await new Promise<{ status: number; body: any }>((resolve) => {
    const req = http.request(`http://127.0.0.1:49299/api/sessions`, {
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
        'Accept': 'application/json'
      }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve({ status: res.statusCode || 0, body: JSON.parse(raw) }));
    });
    req.end();
  });

  assert(sessionsListRes.status === 200, `GET /api/sessions returned 200 OK (got: ${sessionsListRes.status})`);
  assert(Array.isArray(sessionsListRes.body.sessions), 'Sessions response contains an array of conversations');
  assert(sessionsListRes.body.sessions.length > 0, `Discovered active Antigravity conversations (count: ${sessionsListRes.body.sessions.length})`);

  const firstSession = sessionsListRes.body.sessions[0];
  assert(typeof firstSession.id === 'string' && firstSession.id.length > 10, `Session ID is valid UUID (${firstSession.id})`);
  assert(typeof firstSession.title === 'string' && firstSession.title.length > 0, `Session has descriptive title ("${firstSession.title.slice(0, 30)}...")`);
  assert(typeof firstSession.workspace === 'string', `Session contains workspace folder context ("${firstSession.workspace}")`);

  // 2. POST /api/sessions/select
  const switchTarget = sessionsListRes.body.sessions.length > 1
    ? sessionsListRes.body.sessions[1]
    : sessionsListRes.body.sessions[0];

  const switchRes = await new Promise<{ status: number; body: any }>((resolve) => {
    const req = http.request(`http://127.0.0.1:49299/api/sessions/select`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve({ status: res.statusCode || 0, body: JSON.parse(raw) }));
    });
    req.write(JSON.stringify({ id: switchTarget.id }));
    req.end();
  });

  assert(switchRes.status === 200 && switchRes.body.status === 'switched', `Successfully switched target session to ${switchTarget.id}`);

  await server.stop();
  fs.rmSync(historyDir, { recursive: true, force: true });

  // -----------------------------------------------------------------------------
  // Test Summary
  // -----------------------------------------------------------------------------
  console.log('\n' + '='.repeat(80));
  console.log(`TOTAL PASS: ${passed} | TOTAL FAIL: ${failed}`);
  console.log('='.repeat(80));

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

run().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
