/**
 * LsBridge contract tests against a fake Antigravity language server.
 * Wire shapes mirror what was verified against the real IDE on 2026-10-22 (NOTES.md §13).
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LsBridge, buildInteraction, extractPending, parseConversations, normalizeWorkspace, parsePsOutput, parseListeningPorts, rankLanguageServers, parseServerCommandLine, type LsServer } from '../src/adapter-antigravity/ls-bridge.ts';
import { AntigravityAdapter } from '../src/adapter-antigravity/index.ts';
import { auditLogger } from '../src/core/logger.ts';
import { parsePromptImages, MAX_PROMPT_IMAGES, MAX_PROMPT_IMAGE_BYTES } from '../src/server/api.ts';
import { collectDiagnostics } from '../src/adapter-antigravity/diagnostics.ts';

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) { passed++; console.log(`  ✅ PASS: ${msg}`); }
  else { failed++; console.log(`  ❌ FAIL: ${msg}`); }
}
async function rejects(fn: () => Promise<unknown>, pattern: RegExp, msg: string) {
  try { await fn(); assert(false, `${msg} (did not throw)`); }
  catch (e: any) { assert(pattern.test(String(e?.message)), `${msg} -> "${e?.message}"`); }
}

console.log('='.repeat(75));
console.log('🧪 TEST SUITE: LANGUAGE-SERVER BRIDGE (fake server, verified wire shapes)');
console.log('='.repeat(75));

const TOKEN = 'live-secret-token-6f1e';
const CASCADE = '11111111-2222-3333-4444-555555555555';

// ---- Fake language server ----
interface FakeState {
  steps: any[];
  acceptInteraction: boolean;
  /** Answer prompts that carry images with an error, like an IDE build without image support. */
  rejectImages: boolean;
  /** Live run status the server reports for CASCADE (GetCascadeTrajectoryResponse.status); undefined = not reported. */
  runStatus?: string;
  /** Folder the fake IDE's conversation list assigns to CASCADE. */
  workspace: string;
  calls: Array<{ method: string; body: any; token: string | undefined }>;
}
const state: FakeState = { steps: [], acceptInteraction: true, rejectImages: false, workspace: '', calls: [] };

function waitingStep(cmd = 'echo hello > probe.txt') {
  return {
    type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
    status: 'CORTEX_STEP_STATUS_WAITING',
    runCommand: { commandLine: cmd, proposedCommandLine: cmd, cwd: 'c:\\sandbox' },
    requestedInteraction: { permission: { resource: { action: 'command', target: cmd }, actionDescription: 'Running command' } }
  };
}
function resetSteps() {
  state.steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { items: [{ text: 'hi' }], userConfig: { plannerConfig: { agenticMode: true } } } },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE' },
    { type: 'CORTEX_STEP_TYPE_RUN_COMMAND', status: 'CORTEX_STEP_STATUS_CANCELED', requestedInteraction: { permission: {} } },
    waitingStep()
  ];
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const method = (req.url || '').split('/').pop() || '';
    const token = req.headers['x-codeium-csrf-token'] as string | undefined;
    let parsed: any = {};
    try { parsed = JSON.parse(body || '{}'); } catch (_) {}
    state.calls.push({ method, body: parsed, token });
    if (token !== TOKEN) { res.writeHead(401); res.end('{"code":"unauthenticated"}'); return; }
    if (method === 'SendUserCascadeMessage' && state.rejectImages && parsed.images) {
      res.writeHead(400); res.end('{"code":"invalid_argument","message":"unknown field images"}'); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (method === 'GetCascadeTrajectory') {
      if (parsed.cascadeId !== CASCADE) { res.end('{}'); return; }
      res.end(JSON.stringify({ trajectory: { trajectoryId: 'traj-1', cascadeId: CASCADE, steps: state.steps }, ...(state.runStatus ? { status: state.runStatus } : {}) }));
    } else if (method === 'HandleCascadeUserInteraction') {
      if (state.acceptInteraction) {
        const i = parsed.interaction?.stepIndex;
        if (state.steps[i]) state.steps[i].status = 'CORTEX_STEP_STATUS_RUNNING';
      }
      res.end('{}');
    } else if (method === 'GetAllCascadeTrajectories') {
      res.end(JSON.stringify({ trajectorySummaries: { [CASCADE]: { summary: 'hi', workspaces: [{ workspaceFolderAbsoluteUri: state.workspace }], lastModifiedTime: new Date().toISOString() } } }));
    } else if (method === 'SendUserCascadeMessage') {
      state.steps.push({ type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' });
      res.end('{}');
    } else {
      res.end('{}');
    }
  });
});

/** A minimal agy: answers the reachability probe and lists one conversation per folder in `folders`. */
async function miniAgy(folders: string[]) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.headers['x-codeium-csrf-token'] !== TOKEN) { res.writeHead(401); res.end('{}'); return; }
      const method = (req.url || '').split('/').pop() || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      if (method === 'GetAllCascadeTrajectories') {
        const summaries: Record<string, any> = {};
        folders.forEach((f, i) => {
          summaries[`conv-${i}-${f.length}`] = { summary: 'chat', workspaces: [{ workspaceFolderAbsoluteUri: 'file:///' + f.replace(/^([a-z]):/, '$1%3A').replace(/ /g, '%20') }], lastModifiedTime: new Date().toISOString() };
        });
        res.end(JSON.stringify({ trajectorySummaries: summaries }));
      } else {
        res.end('{}');
      }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return { server, folders, port: (server.address() as any).port as number };
}

async function run() {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  const servers: LsServer[] = [
    // Per-workspace server: holds stale state; must never be used for live actions.
    { pid: 10, workspaceId: 'file_c_3A_Users_x', token: 'stale-workspace-token', ports: [port] },
    { pid: 20, workspaceId: null, token: TOKEN, ports: [port] }
  ];
  const bridge = new LsBridge({ discover: async () => servers, verifyTimeoutMs: 600, discoveryCooldownMs: 0 });

  console.log('\n[Suite 1] Pure helpers');
  resetSteps();
  const pending = extractPending(CASCADE, { trajectoryId: 'traj-1', steps: state.steps });
  assert(pending?.stepIndex === 3 && pending.kind === 'permission', 'extractPending picks the WAITING step, ignores CANCELED');
  assert(pending?.commandLine === 'echo hello > probe.txt' && pending.cwd === 'c:\\sandbox', 'extractPending exposes command and cwd');
  assert(extractPending(CASCADE, { trajectoryId: 't', steps: [{ status: 'CORTEX_STEP_STATUS_DONE' }] }) === null, 'no pending when nothing waits');
  const p = pending!;
  assert(JSON.stringify(buildInteraction(p, { allow: true, scope: 'once' })) === '{"trajectoryId":"traj-1","stepIndex":3,"permission":{"allow":true,"scope":1}}', 'approve once = exact verified shape');
  assert((buildInteraction({ ...p, kind: 'runCommand' }, { allow: true, scope: 'once' }) as any).runCommand.confirm === true, 'runCommand kind uses confirm');
  assert((buildInteraction({ ...p, kind: 'mcp' }, { allow: false }) as any).mcp.confirm === false, 'confirm-only kinds');
  let threw = false;
  try { buildInteraction({ ...p, kind: 'filePermission' }, { allow: true, scope: 'once' }); } catch (_) { threw = true; }
  assert(threw, 'filePermission without a path is refused (fail closed)');
  threw = false;
  try { buildInteraction({ ...p, kind: 'somethingNew' }, { allow: true, scope: 'once' }); } catch (_) { threw = true; }
  assert(threw, 'unknown interaction kinds are refused (fail closed)');

  console.log('\n[Suite 1b] macOS / Linux discovery parsers');
  // Shapes from a real macOS machine (2026-10-28), tokens replaced
  const BIN = '/Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm';
  const ps = [
    '  301     1 /Applications/Antigravity IDE.app/Contents/MacOS/Electron',
    ` 2084     1 ${BIN} --csrf_token=stale-tok --extension_server_port 49276 --app_data_dir antigravity-ide --subclient_type ide --cloud_code_endpoint https://cloudcode-pa.googleapis.com`,
    ` 4043   350 ${BIN} --enable_lsp --csrf_token=live-tok --extension_server_port 58994 --subclient_type ide --app_data_dir antigravity-ide --parent_pipe_path /var/folders/9g/T/server_938c`,
    `60612   351 ${BIN} --enable_lsp --csrf_token=ws-tok --workspace_id file_Volumes_External_proj --app_data_dir antigravity-ide --parent_pipe_path /var/folders/9g/T/server_c40a`,
    '92607   400 grep language_server',
    '  600     1 language_server_linux_x64 --csrf_token linux-tok'
  ].join('\n');
  const procs = parsePsOutput(ps);
  assert(procs.length === 4, 'ps: finds language servers, skips the IDE and processes without a token');
  assert(procs[0].pid === 2084 && procs[0].token === 'stale-tok' && procs[0].workspaceId === null && procs[0].ppid === 1, 'ps: path with spaces, --csrf_token=, no workspace id, parent pid');
  assert(procs[1].attached && !procs[0].attached, 'ps: --parent_pipe_path marks a server attached to a running IDE');
  assert(procs[2].workspaceId === 'file_Volumes_External_proj' && procs[2].token === 'ws-tok', 'ps: workspace id');
  assert(procs[3].pid === 600, 'ps: bare binary name (Linux)');
  const ranked = rankLanguageServers(procs.filter(p => !p.workspaceId));
  assert(ranked[0].pid === 4043, 'two workspace-less servers: the one attached to the IDE is tried before the leftover');
  assert(ranked[ranked.length - 1].ppid === 1 && !ranked[ranked.length - 1].attached, 'orphaned servers are tried last');
  assert(rankLanguageServers([{ ppid: 5, attached: false, pid: 1 }, { ppid: 6, attached: false, pid: 2 }])[0].pid === 1, 'equal candidates keep their order');
  const lsof = [
    'COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'language_  4043 me       7u  IPv4 0xe43d4fbcc0e94ea0      0t0  TCP 127.0.0.1:59002 (LISTEN)',
    'language_  4043 me       8u  IPv4 0xb7f91768069d20c1      0t0  TCP 127.0.0.1:59003 (LISTEN)',
    'language_  4043 me      26u  IPv4 0xff4a303f9dcdbd80      0t0  TCP 127.0.0.1:59014 (LISTEN)',
    'language_ 60612 me      12u  IPv6 0x8f1c2a3b4d5e6f72      0t0  TCP [::1]:53200 (LISTEN)'
  ].join('\n');
  const lsofPorts = parseListeningPorts(lsof);
  assert(JSON.stringify(lsofPorts.get(4043)) === '[59002,59003,59014]', 'lsof: loopback ports per pid');
  assert(!lsofPorts.has(60612), 'lsof: IPv6-only listener skipped (bridge connects to 127.0.0.1)');
  const ss = 'LISTEN 0      4096       127.0.0.1:41234      0.0.0.0:*    users:(("language_server",pid=600,fd=9))';
  assert(JSON.stringify(parseListeningPorts(ss).get(600)) === '[41234]', 'ss: loopback port per pid (Linux without lsof)');

  console.log('\n[Suite 1c] agy servers (Antigravity builds from late Oct 2026), same parser on every OS');
  // Shape seen on Windows 2026-10-28: one agy.exe per IDE window, token replaced
  const winAgy = parseServerCommandLine('"C:\\Users\\me\\.gemini\\bin\\agy.exe" --hub --hub-port 53397 --app_data_dir antigravity --csrf_token abc-123 --add-dir "c:\\Users\\me\\Projects\\My App"');
  assert(winAgy?.kind === 'agy' && winAgy.token === 'abc-123', 'Windows agy.exe: recognised, token read');
  assert(winAgy?.workspaceId === null && JSON.stringify(winAgy.addDirs) === '["c:/users/me/projects/my app"]', 'agy: no workspace id; --add-dir with a space, normalized');
  assert(winAgy?.appDataDir === 'antigravity', 'agy: --app_data_dir read');
  assert(parseServerCommandLine('C:\\x\\agy.exe --csrf_token=t --add-dir=C:\\work\\proj')?.addDirs?.[0] === 'c:/work/proj', 'agy: --flag=value form');
  const winLs = parseServerCommandLine('C:\\Users\\me\\AppData\\Local\\Programs\\antigravity\\resources\\bin\\language_server_windows_x64.exe --extension_server_csrf_token other --csrf_token real --workspace_id file_c_3A_proj');
  assert(winLs?.kind === 'language_server' && winLs.token === 'real' && winLs.workspaceId === 'file_c_3A_proj', 'older Windows language_server: token not confused with --extension_server_csrf_token');
  assert(parseServerCommandLine('C:\\x\\agy-helper.exe --csrf_token t') === null, 'a different program with a similar name is ignored');
  assert(parseServerCommandLine('node agy.js --csrf_token t') === null, 'a script named agy is ignored');
  assert(parseServerCommandLine('C:\\x\\agy.exe --hub --add-dir C:\\p') === null, 'a server without a token is ignored');
  const macAgy = parsePsOutput(' 700   412 /Users/me/.gemini/bin/agy --hub --hub-port 51000 --app_data_dir antigravity --csrf_token mac-tok --add-dir /Users/me/proj');
  assert(macAgy.length === 1 && macAgy[0].kind === 'agy' && macAgy[0].addDirs?.[0] === '/users/me/proj', 'macOS agy from ps output');
  const twoWindows = [
    { pid: 1, ppid: 9, attached: false, addDirs: ['c:/users/me/projects/a'] },
    { pid: 2, ppid: 9, attached: false, addDirs: ['c:/users/me/projects/b'] }
  ];
  assert(rankLanguageServers(twoWindows, 'C:\\Users\\me\\Projects\\B\\')[0].pid === 2, "one agy per window: this window's server comes first");
  assert(rankLanguageServers(twoWindows, 'C:\\Users\\me\\Projects\\A')[0].pid === 1, 'and the other window gets its own');
  assert(rankLanguageServers(twoWindows)[0].pid === 1, 'no folder given: order kept');

  console.log('\n[Suite 2] Bridge against fake server');
  state.calls = [];
  const live = await bridge.findPending(CASCADE);
  assert(live?.stepIndex === 3, 'findPending reads the live server');
  assert(state.calls.every(c => c.token !== 'stale-workspace-token'), 'never talks to the per-workspace (stale) server');
  assert(state.calls.some(c => c.token === TOKEN), 'sends the csrf token header to the live server');

  state.calls = [];
  await bridge.respond(live!, { allow: true, scope: 'once' });
  const sent = state.calls.find(c => c.method === 'HandleCascadeUserInteraction');
  assert(sent && sent.body.cascadeId === CASCADE && sent.body.interaction.permission.scope === 1, 'respond sends HandleCascadeUserInteraction with verified body');
  assert(state.steps[3].status === 'CORTEX_STEP_STATUS_RUNNING', 'fake IDE moved step out of WAITING');

  resetSteps();
  state.acceptInteraction = false;
  const again = await bridge.findPending(CASCADE);
  await rejects(() => bridge.respond(again!, { allow: true, scope: 'once' }), /did not accept/, 'respond fails loudly if the IDE ignores the answer');
  state.acceptInteraction = true;

  resetSteps();
  await rejects(() => bridge.respond({ ...again!, stepIndex: 2 }, { allow: true, scope: 'once' }), /no longer pending/, 'respond refuses a stale/mismatched step');

  state.calls = [];
  await bridge.sendPrompt(CASCADE, 'continue please');
  const prompt = state.calls.find(c => c.method === 'SendUserCascadeMessage');
  assert(prompt?.body.items?.[0]?.text === 'continue please', 'sendPrompt sends items[].text');
  assert(prompt?.body.cascadeConfig?.plannerConfig?.agenticMode === true, 'sendPrompt reuses the conversation\'s last user config');
  assert(prompt?.body.images === undefined, 'text-only prompt sends no images field');

  state.calls = [];
  await bridge.sendPrompt(CASCADE, 'what is wrong here?', [{ mimeType: 'image/jpeg', data: 'AAAA' }]);
  const withImg = state.calls.find(c => c.method === 'SendUserCascadeMessage');
  assert(withImg?.body.items?.[0]?.text === 'what is wrong here?', 'image prompt keeps its text');
  assert(JSON.stringify(withImg?.body.images) === '[{"base64Data":"AAAA","mimeType":"image/jpeg"}]', 'images sent as ImageData{base64Data, mimeType}');

  state.calls = [];
  await bridge.sendPrompt(CASCADE, '', [{ mimeType: 'image/png', data: 'AAAA' }]);
  const imgOnly = state.calls.find(c => c.method === 'SendUserCascadeMessage');
  assert(Array.isArray(imgOnly?.body.items) && imgOnly.body.items.length === 0, 'image-only prompt sends no empty text item');

  state.rejectImages = true;
  try {
    await bridge.sendPrompt(CASCADE, 'x', [{ mimeType: 'image/png', data: 'AAAA' }]);
    assert(false, 'refused images throw');
  } catch (e: any) {
    assert(e.imagesRejected === true, 'IDE refusing images is flagged so the adapter can fall back');
  }
  state.rejectImages = false;

  console.log('\n[Suite 2b] Prompt image validation');
  assert(Array.isArray(parsePromptImages(undefined)) && (parsePromptImages(undefined) as any[]).length === 0, 'no images is fine');
  assert(typeof parsePromptImages('x') === 'string', 'images must be an array');
  assert(typeof parsePromptImages([{ mimeType: 'image/svg+xml', data: 'AAAA' }]) === 'string', 'svg refused (only raster types)');
  assert(typeof parsePromptImages([{ mimeType: 'image/png', data: 'not base64!' }]) === 'string', 'non-base64 data refused');
  assert(typeof parsePromptImages(Array(MAX_PROMPT_IMAGES + 1).fill({ mimeType: 'image/png', data: 'AAAA' })) === 'string', 'too many images refused');
  assert(typeof parsePromptImages([{ mimeType: 'image/png', data: 'A'.repeat(MAX_PROMPT_IMAGE_BYTES * 4 / 3 + 8) }]) === 'string', 'oversized images refused');
  const ok = parsePromptImages([{ mimeType: 'image/jpeg', data: 'AAAA', extra: 'dropped' }]);
  assert(Array.isArray(ok) && JSON.stringify(ok) === '[{"mimeType":"image/jpeg","data":"AAAA"}]', 'valid image passes with only known fields');

  state.calls = [];
  await bridge.cancel(CASCADE);
  const cancel = state.calls.find(c => c.method === 'CancelCascadeInvocation');
  assert(cancel?.body.cascadeId === CASCADE && cancel.body.killBackgroundTasks === true, 'cancel matches the IDE stop button call');

  const lonely = new LsBridge({ discover: async () => [servers[0]], discoveryCooldownMs: 0 });
  assert(await lonely.findPending(CASCADE) === null, 'no workspace-less server -> no pending (fail closed)');
  await rejects(() => lonely.cancel(CASCADE), /not reachable/, 'actions fail loudly when the live server is missing');

  // Two windows, one agy each (both answer on the fake port): each bridge must pick its own window's
  const agyServers: LsServer[] = [
    { pid: 41, workspaceId: null, token: TOKEN, ports: [port], kind: 'agy', addDirs: ['c:/users/me/projects/a'] },
    { pid: 42, workspaceId: null, token: TOKEN, ports: [port], kind: 'agy', addDirs: ['c:/users/me/projects/b'] }
  ];
  const bridgeB = new LsBridge({ discover: async () => agyServers, discoveryCooldownMs: 0, workspace: 'C:\\Users\\me\\Projects\\B' });
  await bridgeB.findPending(CASCADE);
  assert(bridgeB.describeEndpoint()?.pid === 42, "window B's bridge talks to window B's agy");
  const bridgeA = new LsBridge({ discover: async () => agyServers, discoveryCooldownMs: 0, workspace: 'C:\\Users\\me\\Projects\\A' });
  await bridgeA.findPending(CASCADE);
  assert(bridgeA.describeEndpoint()?.pid === 41 && bridgeA.describeEndpoint()?.kind === 'agy', "window A's bridge talks to window A's agy");

  console.log('\n[Suite 2c] agy without --add-dir: each window finds its agent by its conversations');
  // Seen on a Windows PC (Oct 2026, 0.2.4 diagnostics): two windows, two agy, neither started with
  // --add-dir. Each agy lists only its own window's chats. Both bridges used the first agy, so one
  // window's phone tab stayed empty.
  const eduhub = 'e:/d drive/coding/html css projects/eduhub';
  const career = 'e:/d drive/coding/html css projects/careerforge ai';
  const agyX = await miniAgy([eduhub]);
  const agyY = await miniAgy([career]);
  const noDirServers = (): LsServer[] => [
    { pid: 19448, workspaceId: null, token: TOKEN, ports: [agyX.port], kind: 'agy', appDataDir: 'antigravity', attached: false, ppid: 18056 },
    { pid: 17392, workspaceId: null, token: TOKEN, ports: [agyY.port], kind: 'agy', appDataDir: 'antigravity', attached: false, ppid: 14684 }
  ];
  const careerBridge = new LsBridge({ discover: async () => noDirServers(), discoveryCooldownMs: 0, workspace: 'E:\\D Drive\\Coding\\HTML CSS Projects\\CareerForge AI' });
  const careerConvs = await careerBridge.listConversations();
  assert(careerBridge.describeEndpoint()?.pid === 17392, "CareerForge window talks to CareerForge's agy, not the first one found");
  assert(!!careerConvs && careerConvs.some(c => c.workspaces.includes(career)), "CareerForge window sees CareerForge's conversations");
  assert(careerBridge.describeEndpoint()?.matchedBy === 'conversations', 'diagnostics can tell it was matched by its conversations');
  const eduBridge = new LsBridge({ discover: async () => noDirServers(), discoveryCooldownMs: 0, workspace: 'E:\\D Drive\\Coding\\HTML CSS Projects\\EduHub' });
  await eduBridge.listConversations();
  assert(eduBridge.describeEndpoint()?.pid === 19448, 'EduHub window still talks to its own agy');

  // A window with no chat yet can't be matched; once its first chat exists, the bridge must move to that agy.
  const fresh = 'e:/projects/fresh';
  const freshBridge = new LsBridge({ discover: async () => noDirServers(), discoveryCooldownMs: 0, workspace: 'E:\\Projects\\Fresh' });
  const before = await freshBridge.listConversations();
  assert(!!before && !before.some(c => c.workspaces.includes(fresh)), 'window without a chat: no conversation of another project is claimed as its own');
  assert(freshBridge.describeEndpoint()?.matchedBy === 'unconfirmed', 'that connection is marked unconfirmed');
  agyY.folders.push(fresh);
  const after = await freshBridge.listConversations();
  assert(freshBridge.describeEndpoint()?.pid === 17392 && !!after?.some(c => c.workspaces.includes(fresh)), "after the window's first chat, the bridge moves to the agy that holds it");

  // Older builds: one shared language_server plus a leftover one (0.2.2 Mac fix). Keep choosing the
  // attached server even if the leftover lists conversations for this folder (its state is stale).
  const lsLive = await miniAgy([]);
  const lsLeftover = await miniAgy([career]);
  const macBridge = new LsBridge({
    discover: async () => [
      { pid: 2084, workspaceId: null, token: TOKEN, ports: [lsLeftover.port], kind: 'language_server', attached: false, ppid: 1 },
      { pid: 4043, workspaceId: null, token: TOKEN, ports: [lsLive.port], kind: 'language_server', attached: true, ppid: 350 }
    ],
    discoveryCooldownMs: 0,
    workspace: 'E:\\D Drive\\Coding\\HTML CSS Projects\\CareerForge AI'
  });
  await macBridge.listConversations();
  assert(macBridge.describeEndpoint()?.pid === 4043, 'language_server: the attached server still wins over a leftover (unchanged)');

  console.log('\n[Suite 2d] agy without --add-dir: each window finds its agent by its parent (the extension host)');
  // The diagnostics as reported (Windows, 0.2.4): the EduHub window's own agy (parent 10116) has no
  // chat loaded yet; the other lists CareerForge's. Both windows were on 17392.
  const agyCareer = await miniAgy([career]);
  const agyEdu = await miniAgy([]);
  const reported = (): LsServer[] => [
    { pid: 17392, workspaceId: null, token: TOKEN, ports: [agyCareer.port], kind: 'agy', appDataDir: 'antigravity', attached: false, ppid: 14684 },
    { pid: 14732, workspaceId: null, token: TOKEN, ports: [agyEdu.port], kind: 'agy', appDataDir: 'antigravity', attached: false, ppid: 10116 }
  ];
  const eduOwn = new LsBridge({ discover: async () => reported(), discoveryCooldownMs: 0, workspace: 'E:\\D Drive\\Coding\\HTML CSS Projects\\EduHub', ownerPid: 10116 });
  const eduConvs = await eduOwn.listConversations();
  assert(eduOwn.describeEndpoint()?.pid === 14732 && eduOwn.describeEndpoint()?.matchedBy === 'parent', "EduHub window talks to the agy its extension host started, even with no chat in it");
  assert(!!eduConvs && !eduConvs.some(c => c.workspaces.includes(career)), "EduHub window doesn't list CareerForge's chat");
  const careerOwn = new LsBridge({ discover: async () => reported(), discoveryCooldownMs: 0, workspace: 'E:\\D Drive\\Coding\\HTML CSS Projects\\CareerForge AI', ownerPid: 14684 });
  await careerOwn.listConversations();
  assert(careerOwn.describeEndpoint()?.pid === 17392 && careerOwn.describeEndpoint()?.matchedBy === 'parent', 'CareerForge window talks to its own agy');

  // Windows restored together at IDE start: this window's agy may not listen yet when its bridge looks.
  let ownUp = false;
  const starting = new LsBridge({
    discover: async () => reported().filter(s => ownUp || s.pid !== 14732),
    discoveryCooldownMs: 0,
    workspace: 'E:\\D Drive\\Coding\\HTML CSS Projects\\EduHub',
    ownerPid: 10116
  });
  await starting.listConversations();
  assert(starting.describeEndpoint()?.pid === 17392 && starting.describeEndpoint()?.matchedBy === 'unconfirmed', "while its own agy is starting, another window's lone agy is only a provisional choice");
  ownUp = true;
  await new Promise(r => setTimeout(r, 5));
  await starting.listConversations();
  // Rechecks reuse the last process list for a minute; a failing call or a minute later rediscovers.
  (starting as any).knownServersAt = 0;
  await starting.listConversations();
  assert(starting.describeEndpoint()?.pid === 14732 && starting.describeEndpoint()?.matchedBy === 'parent', 'once its own agy starts, the window moves to it');

  // A leftover agy from a closed window of the same folder still lists its chats; this window's own agy wins.
  const leftover = await miniAgy([career]);
  const withLeftover = new LsBridge({
    discover: async () => [
      { pid: 9001, workspaceId: null, token: TOKEN, ports: [leftover.port], kind: 'agy', attached: false, ppid: 7777 },
      ...reported()
    ],
    discoveryCooldownMs: 0,
    workspace: 'E:\\D Drive\\Coding\\HTML CSS Projects\\CareerForge AI',
    ownerPid: 14684
  });
  await withLeftover.listConversations();
  assert(withLeftover.describeEndpoint()?.pid === 17392, "a closed window's leftover agy that lists this folder loses to this window's own");
  for (const s of [agyX, agyY, lsLive, lsLeftover, agyCareer, agyEdu, leftover]) s.server.close();

  console.log('\n[Suite 3] Adapter wired to the bridge');
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'agr-brain-'));
  const logs = path.join(brain, CASCADE, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'transcript.jsonl'),
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: new Date().toISOString(), content: '<USER_REQUEST>hi</USER_REQUEST>' }) + '\n');
  resetSteps();
  state.workspace = brain;
  const adapter = new AntigravityAdapter(brain, { brainDir: brain }, { lsBridge: bridge, livePollMs: 60000 });
  const events: string[] = [];
  adapter.onEvent(e => events.push(e.type));
  await adapter.connect();
  const snap = await adapter.getSnapshot();
  assert(snap.status === 'awaiting_approval' && snap.pendingApproval?.id.startsWith('ls:'), 'snapshot shows the live pending approval');
  assert(snap.pendingApproval?.kind === 'run_command' && snap.pendingApproval.detail === 'echo hello > probe.txt', 'approval card carries kind and exact command');
  assert(JSON.stringify(snap.pendingApproval?.actions) === '["allow_once","allow_conversation","deny"]', 'approval advertises the IDE options');
  assert(events.includes('approval_requested'), 'approval_requested event emitted');
  await rejects(() => adapter.approve('ls:wrong', undefined, 'allow_once'), /mismatch/, 'approve rejects a mismatched id');
  state.calls = [];
  await adapter.approve(snap.pendingApproval!.id, undefined, 'allow_conversation');
  const conv = state.calls.find(c => c.method === 'HandleCascadeUserInteraction');
  assert(conv?.body.interaction.permission.scope === 2, 'adapter maps allow_conversation to scope 2');
  assert((await adapter.getSnapshot()).pendingApproval === null, 'approval clears after the IDE accepts');

  // The agy agent (Oct 2026) accepts the images field without error but the agent never sees it
  // (owner's live test, 0.2.3-B3). So images always go into the project as files the agent can open.
  const uploadsDir = path.join(brain, '.ag-remote', 'uploads');
  const savedPaths = (text: string) => [...text.matchAll(/(\S+[\\/]\.ag-remote[\\/]uploads[\\/][\w-]+\.png)/g)].map(m => m[1]);
  state.calls = [];
  await adapter.sendPrompt('what is wrong here?', [{ mimeType: 'image/png', data: Buffer.from('png-bytes').toString('base64') }]);
  const accepted = state.calls.filter(c => c.method === 'SendUserCascadeMessage');
  const acceptedText = accepted[0]?.body.items?.[0]?.text || '';
  const acceptedPath = savedPaths(acceptedText)[0];
  assert(accepted.length === 1 && acceptedText.startsWith('what is wrong here?'), 'image prompt sent once, keeping the user\'s text first');
  assert(!!acceptedPath && path.isAbsolute(acceptedPath), 'prompt names the saved image by its full path');
  assert(!!acceptedPath && fs.readFileSync(acceptedPath, 'utf8') === 'png-bytes', 'image saved into the project with its exact bytes');
  assert(accepted[0]?.body.images?.length === 1, 'the images field is still sent, for builds that support it');
  assert(fs.readFileSync(path.join(brain, '.ag-remote', '.gitignore'), 'utf8').trim() === '*', 'upload folder ignores itself in git');

  state.rejectImages = true;
  state.calls = [];
  await adapter.sendPrompt('', [{ mimeType: 'image/png', data: Buffer.from('second').toString('base64') }]);
  const retried = state.calls.filter(c => c.method === 'SendUserCascadeMessage');
  const retryText = retried.pop()?.body.items?.[0]?.text || '';
  assert(savedPaths(retryText).length === 1 && retried.pop()?.body.images?.length === 1, 'refused images field: resent without it, still naming the file');
  assert(fs.readdirSync(uploadsDir).filter(f => f.endsWith('.png')).length === 2, 'each image saved once, even when resent');
  state.rejectImages = false;

  // Uploads older than a week are removed when new ones are saved
  const stale = path.join(uploadsDir, '1000000000000-1.png');
  fs.writeFileSync(stale, 'old');
  const weekAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  fs.utimesSync(stale, weekAgo, weekAgo);
  await adapter.sendPrompt('again', [{ mimeType: 'image/png', data: Buffer.from('third').toString('base64') }]);
  assert(!fs.existsSync(stale), 'uploads older than 7 days are cleaned up');
  await adapter.disconnect();

  const offline = new AntigravityAdapter(brain, { brainDir: brain }, { lsBridge: null });
  await rejects(() => offline.sendPrompt('hi'), /live bridge unavailable/, 'prompt without bridge fails loudly (no CLI fallback)');
  await rejects(() => offline.stop(), /live bridge unavailable/, 'stop without bridge fails loudly (no fake /stop prompt)');

  console.log('\n[Suite 3b] Diagnostics report');
  const report = await collectDiagnostics({ workspacePath: brain, extensionVersion: '9.9.9', discover: async () => servers, brainDir: brain });
  assert(report.includes('Language servers found: 2') && report.includes('Connected to: pid 20'), 'report lists the servers and the one the bridge picks');
  assert(report.includes('Conversations for this window\'s folder: 1') && report.includes('← this window'), 'report shows whether a conversation matches this window');
  assert(!report.includes(TOKEN) && !report.includes('stale-workspace-token'), 'report never contains a csrf token');
  assert(!report.includes('Conversation ') || !report.includes('hi'), 'report leaves out conversation titles');
  const none = await collectDiagnostics({ workspacePath: brain, discover: async () => [], brainDir: path.join(brain, 'nope') });
  assert(none.includes('Language servers found: 0') && none.includes('Connected to: none') && none.includes('(missing)'), 'report explains when nothing is found');
  const agyReport = await collectDiagnostics({
    workspacePath: brain, brainDir: brain,
    discover: async () => [{ pid: 51, workspaceId: null, token: TOKEN, ports: [port], kind: 'agy', addDirs: [normalizeWorkspace(brain)], appDataDir: 'antigravity' }]
  });
  assert(agyReport.includes('agy') && agyReport.includes('data ~/.gemini/antigravity') && agyReport.includes('← this window'), "report names agy servers, their data folder and this window's server");
  assert(agyReport.includes('Connected to: pid 51 (agy)') && !agyReport.includes(TOKEN), 'report shows the agy it connected to, no token');
  assert(/pid 20: .*lists \d+ conversation\(s\), \d+ for this window/.test(report), 'report asks every server for its own conversations');
  assert(report.includes("Newest one's history: in"), "report says where the window's newest conversation's transcript is");
  const fromHost = await collectDiagnostics({
    workspacePath: brain, brainDir: brain, extensionVersion: '0.2.5', discover: async () => [],
    hostReport: { version: '0.2.4', relay: 'online', relayPhones: 1, windows: [
      { window: 'proj', pid: 10116, host: true, shows: { folder: brain, server: { pid: 14732, matchedBy: 'parent' }, conversationsListed: 1, conversationsForFolder: 1, newestHistoryFolder: 'missing', shownConversation: null, messages: 0, status: 'idle' } }
    ] }
  });
  assert(fromHost.includes('differs from this window') && fromHost.includes('Relay: online; phones paired through it: 1'), "report flags a serving window on another version and shows the relay");
  assert(/`proj` \(serving\), extension host pid 10116 ← this window: agy pid 14732 \(parent\); 1 of 1 .*history ⚠ missing; shows no conversation; 0 message/.test(fromHost), "report shows what the serving window shows the phone for each window");
  const noHost = await collectDiagnostics({ workspacePath: brain, brainDir: brain, discover: async () => [], hostReport: null });
  assert(noHost.includes('⚠ No answer'), 'report says when the serving window is too old to answer');

  console.log('\n[Suite 3c] Chat history in either folder');
  // Antigravity moved history from ~/.gemini/antigravity-ide/brain to ~/.gemini/antigravity/brain (Oct 2026)
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agr-old-brain-'));
  const newDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agr-new-brain-'));
  const putTranscript = (dir: string, id: string, text: string) => {
    const d = path.join(dir, id, '.system_generated', 'logs');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'transcript.jsonl'), JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: new Date().toISOString(), content: `<USER_REQUEST>${text}</USER_REQUEST>` }) + '\n');
  };
  putTranscript(oldDir, 'old-conv-0000-0000-000000000000', 'from before the update');
  putTranscript(newDir, 'new-conv-0000-0000-000000000000', 'from after the update');
  const { SessionWatcher: Watcher, } = await import('../src/adapter-antigravity/session-watcher.ts');
  const { defaultConfig: defaults } = await import('../src/adapter-antigravity/config.ts');
  const both = new Watcher(newDir, { ...defaults, brainDir: newDir, brainDirs: [newDir, oldDir] });
  assert(await both.setActiveConversationId('new-conv-0000-0000-000000000000'), 'opens a conversation from the new folder');
  assert(both.getSnapshot().messages.some(m => m.text === 'from after the update'), "reads the new folder's messages");
  assert(await both.setActiveConversationId('old-conv-0000-0000-000000000000'), 'still opens one from the old folder');
  assert(both.listAllSessions().length === 2, 'lists conversations from both folders');
  both.stop();
  const only = new AntigravityAdapter(oldDir, { brainDir: oldDir }, { lsBridge: null });
  assert(((only as any).config.brainDirs || []).length === 1, 'an explicit single folder (tests) reads only that folder');
  fs.rmSync(oldDir, { recursive: true, force: true });
  fs.rmSync(newDir, { recursive: true, force: true });

  console.log('\n[Suite 3d] "Working" comes from the agent, not a guess from the chat file');
  // A chat whose last line is the user's message looks "still generating" to the file-based guess,
  // e.g. after an error or a closed window. Seen 2026-10-28: an old chat showed "Working" + Stop for good.
  const idleBrain = fs.mkdtempSync(path.join(os.tmpdir(), 'agr-idle-'));
  const idleLogs = path.join(idleBrain, CASCADE, '.system_generated', 'logs');
  fs.mkdirSync(idleLogs, { recursive: true });
  const idleTranscript = path.join(idleLogs, 'transcript.jsonl');
  fs.writeFileSync(idleTranscript, JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: new Date().toISOString(), content: '<USER_REQUEST>left unanswered</USER_REQUEST>' }) + '\n');
  state.steps = [{ type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { items: [{ text: 'left unanswered' }] } }];
  state.workspace = idleBrain;

  state.runStatus = 'CASCADE_RUN_STATUS_IDLE';
  await bridge.findPending(CASCADE);
  assert(bridge.isRunning(CASCADE) === false, 'bridge: IDLE from the agent means not running');
  state.runStatus = 'CASCADE_RUN_STATUS_BUSY';
  await bridge.findPending(CASCADE);
  assert(bridge.isRunning(CASCADE) === true, 'bridge: BUSY means running');
  state.runStatus = undefined;
  await bridge.findPending(CASCADE);
  assert(bridge.isRunning(CASCADE) === null, 'bridge: no status reported means unknown');

  state.runStatus = 'CASCADE_RUN_STATUS_IDLE';
  const idleAdapter = new AntigravityAdapter(idleBrain, { brainDir: idleBrain }, { lsBridge: bridge, livePollMs: 60000 });
  await idleAdapter.connect();
  assert((await idleAdapter.getSnapshot()).status === 'idle', 'agent says IDLE: the phone shows Ready, not Working, even though the file ends with a question');
  state.runStatus = 'CASCADE_RUN_STATUS_RUNNING';
  await (idleAdapter as any).pollLive();
  assert((await idleAdapter.getSnapshot()).status === 'generating', 'agent says RUNNING: the phone shows Working');
  state.runStatus = 'CASCADE_RUN_STATUS_IDLE';
  await (idleAdapter as any).pollLive();
  assert((await idleAdapter.getSnapshot()).status === 'idle', 'back to IDLE: Working clears without any new message');
  const described = await idleAdapter.describe();
  assert(described.shownConversation === CASCADE.slice(0, 8) && (described.messages as number) >= 1 && described.newestHistoryFolder === idleBrain && described.conversationsForFolder === 1,
    'describe(): which conversation the phone gets, its message count and where its history is');
  assert(!JSON.stringify(described).includes('left unanswered') && !JSON.stringify(described).includes(TOKEN), 'describe(): no message text, no token');
  await idleAdapter.disconnect();

  // Without a live status (no agent connection), the file guess still works, but not forever
  const { SessionWatcher: GuessWatcher } = await import('../src/adapter-antigravity/session-watcher.ts');
  const { defaultConfig: guessDefaults } = await import('../src/adapter-antigravity/config.ts');
  const guess = new GuessWatcher(idleBrain, { ...guessDefaults, brainDir: idleBrain, brainDirs: [idleBrain] });
  await guess.setActiveConversationId(CASCADE);
  assert(guess.getSnapshot().status === 'generating', 'no live status, fresh unanswered message: guessed as working');
  const longAgo = new Date(Date.now() - 20 * 60 * 1000);
  fs.utimesSync(idleTranscript, longAgo, longAgo);
  await guess.setActiveConversationId(CASCADE);
  assert(guess.getSnapshot().status === 'idle', 'no live status, unanswered for 20 minutes: not shown as working');
  guess.stop();
  state.runStatus = undefined;
  fs.rmSync(idleBrain, { recursive: true, force: true });

  const audit = fs.existsSync(auditLogger.getLogPath()) ? fs.readFileSync(auditLogger.getLogPath(), 'utf8') : '';
  assert(!audit.includes(TOKEN), 'csrf token never written to the audit log');

  console.log('\n[Suite 4a] Conversation list (shape read from the agent panel code)');
  const convs = parseConversations({ trajectorySummaries: {
    old: { summary: 'Old chat', workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c%3A/Users/u/Proj-A' }], lastModifiedTime: '2026-10-20T10:00:00Z' },
    fresh: { summary: '', trajectoryMetadata: { workspaceUris: ['file:///c%3A/Users/u/Proj-B'] }, lastUserInputTime: { seconds: '1800000000' } }
  } });
  assert(convs[0].cascadeId === 'fresh' && convs[1].cascadeId === 'old', 'conversations sorted newest first');
  assert(convs[1].workspaces[0] === 'c:/users/u/proj-a', 'workspace URI from workspaces[] normalised to a path');
  assert(convs[0].workspaces[0] === 'c:/users/u/proj-b', 'trajectoryMetadata.workspaceUris preferred when present');
  assert(convs[0].title === 'Conversation fresh', 'untitled conversation gets a fallback title');
  assert(parseConversations({}).length === 0 && parseConversations(null).length === 0, 'empty or missing response yields no conversations');
  assert(normalizeWorkspace('C:\\Users\\u\\Proj-A\\') === 'c:/users/u/proj-a', 'Windows path and file URI normalise to the same key');

  console.log('\n[Suite 4] Following a new conversation');
  const writeTranscript = (id: string, lines: object[], mtime: Date) => {
    const dir = path.join(brain, id, '.system_generated', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    fs.utimesSync(file, mtime, mtime);
  };
  const userInput = (text: string) => ({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: new Date().toISOString(), content: `<USER_REQUEST>${text}</USER_REQUEST>` });
  const ranIn = (cwd: string) => ({ step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { Cwd: cwd, CommandLine: 'dir' } }] });
  const past = new Date(Date.now() - 60000);
  writeTranscript(CASCADE, [userInput('hi')], past);

  const SessionWatcher = (await import('../src/adapter-antigravity/session-watcher.ts')).SessionWatcher;
  const watcher = new SessionWatcher(brain, { ...(await import('../src/adapter-antigravity/config.ts')).defaultConfig, brainDir: brain, brainDirs: [brain] });
  const seen: any[] = [];
  watcher.on('event', e => seen.push(e));
  await watcher.start();
  watcher.stop();
  assert(watcher.getActiveConversationId() === CASCADE, 'starts on the only conversation');

  const FOREIGN = '99999999-0000-0000-0000-000000000000';
  writeTranscript(FOREIGN, [userInput('elsewhere'), ranIn('D:/other-project')], new Date());
  (watcher as any).lastFollowCheck = 0;
  await watcher.updateSnapshot();
  assert(watcher.getActiveConversationId() === CASCADE, 'ignores a newer chat whose commands ran in another workspace');

  const NEW_CHAT = '22222222-0000-0000-0000-000000000000';
  writeTranscript(NEW_CHAT, [userInput('brand new chat')], new Date(Date.now() + 1000));
  (watcher as any).lastFollowCheck = 0;
  seen.length = 0;
  await watcher.updateSnapshot();
  assert(watcher.getActiveConversationId() === NEW_CHAT, 'switches to a new chat opened in the IDE');
  assert(seen[0]?.type === 'session_changed' && seen[0].conversationId === NEW_CHAT, 'tells the phone the conversation changed before its messages');
  assert(seen.some(e => e.type === 'message' && e.message.text === 'brand new chat'), 'streams the new chat\'s messages');

  server.close();
  fs.rmSync(brain, { recursive: true, force: true });

  console.log('\n' + '='.repeat(75));
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(75));
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test harness error:', err);
  process.exit(1);
});
