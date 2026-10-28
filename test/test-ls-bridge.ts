/**
 * LsBridge contract tests against a fake Antigravity language server.
 * Wire shapes mirror what was verified against the real IDE on 2026-10-22 (NOTES.md §13).
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LsBridge, buildInteraction, extractPending, parseConversations, normalizeWorkspace, type LsServer } from '../src/adapter-antigravity/ls-bridge.ts';
import { AntigravityAdapter } from '../src/adapter-antigravity/index.ts';
import { auditLogger } from '../src/core/logger.ts';
import { parsePromptImages, MAX_PROMPT_IMAGES, MAX_PROMPT_IMAGE_BYTES } from '../src/server/api.ts';

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
      res.end(JSON.stringify({ trajectory: { trajectoryId: 'traj-1', cascadeId: CASCADE, steps: state.steps } }));
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

  state.rejectImages = true;
  state.calls = [];
  await adapter.sendPrompt('look', [{ mimeType: 'image/png', data: Buffer.from('png-bytes').toString('base64') }]);
  const fallback = state.calls.filter(c => c.method === 'SendUserCascadeMessage').pop();
  const saved = /\.ag-remote\/uploads\/[\w-]+\.png/.exec(fallback?.body.items?.[0]?.text || '')?.[0];
  assert(saved && fallback?.body.images === undefined, 'refused images are resent as a text prompt naming the saved file');
  assert(saved && fs.readFileSync(path.join(brain, saved), 'utf8') === 'png-bytes', 'image saved into the workspace with its exact bytes');
  assert(fs.readFileSync(path.join(brain, '.ag-remote', '.gitignore'), 'utf8').trim() === '*', 'upload folder ignores itself in git');
  state.rejectImages = false;
  await adapter.disconnect();

  const offline = new AntigravityAdapter(brain, { brainDir: brain }, { lsBridge: null });
  await rejects(() => offline.sendPrompt('hi'), /live bridge unavailable/, 'prompt without bridge fails loudly (no CLI fallback)');
  await rejects(() => offline.stop(), /live bridge unavailable/, 'stop without bridge fails loudly (no fake /stop prompt)');

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
  const watcher = new SessionWatcher(brain, { ...(await import('../src/adapter-antigravity/config.ts')).defaultConfig, brainDir: brain });
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
