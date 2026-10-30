import http from 'http';
import { windowRegistry, WindowRegistry } from '../src/core/window-registry.ts';
import { AntigravityAdapter } from '../src/adapter-antigravity/index.ts';
import { SessionManager } from '../src/core/session-manager.ts';
import { RemoteServer } from '../src/server/index.ts';
import { buildInteraction } from '../src/adapter-antigravity/ls-bridge.ts';

console.log('='.repeat(75));
console.log('🧪 TEST SUITE: MULTI-WINDOW COORDINATOR HUB & CDP ACTION ENGINE');
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

  // --- Suite 1: WindowRegistry Invariants ---
  console.log('\n[Suite 1] WindowRegistry Invariants');
  const reg = new WindowRegistry();

  const win1 = reg.register({
    windowId: 'win-fieldmap',
    workspaceName: 'FieldMap',
    workspacePath: 'C:/Projects/FieldMap',
    isFocused: true,
    pid: 1001
  });
  assert(win1.workspaceName === 'FieldMap', 'Window 1 registered with correct name');
  assert(reg.getSelected()?.windowId === 'win-fieldmap', 'First focused window auto-selected');

  const win2 = reg.register({
    windowId: 'win-agremote',
    workspaceName: 'AG-Remote',
    workspacePath: 'C:/Projects/AG-Remote',
    isFocused: false,
    pid: 1002
  });
  assert(reg.getAll().length === 2, 'Both windows tracked in registry');

  reg.selectWindow('win-agremote');
  assert(reg.getSelected()?.windowId === 'win-agremote', 'Explicit window selection switches target');

  const hb = reg.heartbeat('win-fieldmap');
  assert(hb === true, 'Heartbeat accepted for valid window');

  reg.unregister('win-fieldmap');
  assert(reg.getAll().length === 1, 'Unregister cleanly removes window');
  reg.stop();

  // --- Suite 2: Hub REST API Endpoints ---
  console.log('\n[Suite 2] Hub REST API Endpoints');
  const adapter = new AntigravityAdapter(process.cwd());
  const sm = new SessionManager(adapter, 'test-secret-token-123');
  const server = new RemoteServer(sm, { port: 49235, host: '127.0.0.1' });
  await server.start();
  const token = 'test-secret-token-123';

  // Test 1: POST /api/hub/register
  const regRes = await postJson('http://127.0.0.1:49235/api/hub/register', {
    windowId: 'win-ext-test',
    workspaceName: 'TestWorkspace',
    workspacePath: 'C:/TestWorkspace',
    isFocused: true,
    pid: 9999
  });
  assert(regRes.status === 'registered', 'POST /api/hub/register succeeds over loopback');
  assert(regRes.window?.workspaceName === 'TestWorkspace', 'Window correctly returned');

  // Test 2: POST /api/hub/heartbeat
  const hbRes = await postJson('http://127.0.0.1:49235/api/hub/heartbeat', {
    windowId: 'win-ext-test'
  });
  assert(hbRes.ok === true, 'POST /api/hub/heartbeat acknowledged');

  // Test 3: GET /api/windows
  const winList = await getJson('http://127.0.0.1:49235/api/windows', token);
  assert(Array.isArray(winList.windows), 'GET /api/windows returns windows array');
  assert(winList.windows.length >= 1, 'Registered window present in /api/windows');

  // Test 4: POST /api/windows/select
  const selRes = await postJson('http://127.0.0.1:49235/api/windows/select', { windowId: 'win-ext-test' }, token);
  assert(selRes.status === 'selected', 'POST /api/windows/select switches active window');

  // Pairing control for linked windows (Manage Paired Phones from a non-host window)
  const noRelay = await postJson('http://127.0.0.1:49235/api/hub/relay-phones', {});
  assert(noRelay.error === 'Relay is not enabled', 'relay-phones reports relay off before the host sets control');
  const phones = [{ pub: 'pk1', name: 'Android phone', pairedAt: 1 }, { pub: 'pk2', name: 'iPhone', pairedAt: 2 }];
  let unpairedAll = false;
  server.setHostControl({
    relayPairUrl: async () => 'https://relay.example/p/room#secret',
    relayPhones: () => phones,
    unpairRelayPhone: async (pub) => { phones.splice(phones.findIndex(p => p.pub === pub), 1); },
    unpairAll: async () => { unpairedAll = true; return true; }
  });
  const listed = await postJson('http://127.0.0.1:49235/api/hub/relay-phones', {});
  assert(listed.phones?.length === 2 && listed.phones[0].name === 'Android phone', 'relay-phones lists the host\'s paired phones');
  const unpaired = await postJson('http://127.0.0.1:49235/api/hub/relay-unpair', { pub: 'pk1' });
  assert(unpaired.ok === true && phones.length === 1 && phones[0].pub === 'pk2', 'relay-unpair removes only that phone');
  const all = await postJson('http://127.0.0.1:49235/api/hub/unpair-all', {});
  assert(all.ok === true && all.relay === true && unpairedAll, 'unpair-all runs on the host');
  const fromBrowser = await postJson('http://127.0.0.1:49235/api/hub/relay-pair', {}, undefined, { Origin: 'https://evil.example' });
  assert(!fromBrowser.url && fromBrowser.error?.startsWith('Unauthorized'), 'hub rejects browser requests (Origin header) even over loopback');
  const unpairFromBrowser = await postJson('http://127.0.0.1:49235/api/hub/relay-unpair', { pub: 'pk2' }, undefined, { Origin: 'null' });
  assert(!unpairFromBrowser.ok && phones.length === 1, 'a web page cannot unpair phones through loopback');

  // Copy Diagnostics in a linked window asks the host what each window's channel shows
  const noDiag = await postJson('http://127.0.0.1:49235/api/hub/diagnostics', {});
  assert(noDiag.error === 'Not available', 'diagnostics: not available until the host provides it');
  server.setHostControl({ diagnostics: async () => ({ version: '9.9.9', windows: [{ window: 'proj', pid: 1, host: true, shows: { messages: 3 } }] }) });
  const diag = await postJson('http://127.0.0.1:49235/api/hub/diagnostics', {});
  assert(diag.version === '9.9.9' && diag.windows?.[0]?.shows?.messages === 3, "diagnostics: a linked window gets the host's view");
  const diagFromBrowser = await postJson('http://127.0.0.1:49235/api/hub/diagnostics', {}, undefined, { Origin: 'https://evil.example' });
  assert(!diagFromBrowser.windows, 'diagnostics: a web page cannot read it through loopback');

  // --- Suite 3: Live bridge approval options ---
  console.log('\n[Suite 3] Live Bridge Approval Options (verified wire shapes, NOTES.md §13)');
  const p = { cascadeId: 'c', trajectoryId: 't', stepIndex: 4, kind: 'permission', stepType: 'RUN_COMMAND', commandLine: 'echo hi' };
  assert(JSON.stringify(buildInteraction(p, { allow: true, scope: 'once' })) === '{"trajectoryId":"t","stepIndex":4,"permission":{"allow":true,"scope":1}}', 'allow_once maps to permission scope ONCE (1)');
  assert((buildInteraction(p, { allow: true, scope: 'conversation' }) as any).permission.scope === 2, 'allow_conversation maps to scope CONVERSATION (2)');
  assert((buildInteraction(p, { allow: false, instruction: 'use ls' }) as any).permission.userDenyInstruction === 'use ls', 'deny carries the instruction');

  // Test 5: POST /api/approve accepts option parameter without crashing
  const approveRes = await postJson('http://127.0.0.1:49235/api/approve', {
    id: 'fake-approval-id',
    option: 'always_allow'
  }, token);
  // Rejection with 400 is expected due to security ID mismatch rule, but must not crash
  assert(approveRes.error?.includes('mismatch') || approveRes.error?.includes('No pending'), 'Security ID validation protects always_allow approval');

  await server.stop();
  sm.registry.stop();

  console.log('\n' + '='.repeat(75));
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(75));

  if (failed > 0) process.exit(1);
}

function postJson(urlStr: string, body: any, bearerToken?: string, extraHeaders: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const data = JSON.stringify(body);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(data)),
      ...extraHeaders
    };
    if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;

    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers
      },
      (res) => {
        let respData = '';
        res.on('data', chunk => { respData += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(respData)); } catch (_) { resolve({ raw: respData }); }
        });
      }
    );
    req.on('error', (err) => resolve({ error: err.message }));
    req.write(data);
    req.end();
  });
}

function getJson(urlStr: string, bearerToken?: string): Promise<any> {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const headers: Record<string, string> = {};
    if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;

    const req = http.get(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        headers
      },
      (res) => {
        let respData = '';
        res.on('data', chunk => { respData += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(respData)); } catch (_) { resolve({ raw: respData }); }
        });
      }
    );
    req.on('error', (err) => resolve({ error: err.message }));
  });
}

runTests().catch(console.error);
