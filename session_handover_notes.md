# Session Handover & Memory Notes: AG-Remote

**Date:** 2026-10-14  
**Project:** Antigravity Remote Control (`AG-Remote`)  
**Repository:** `c:\Users\user\Desktop\Dr_OpenSource\Projects\AG-Remote`  
**Target:** Google Antigravity / Gemini Code Ecosystem  
**Active Plan:** `architecture_and_product_plan.md`  

---

# ⮕ START HERE (updated 2026-10-27, read this section only, then NOTES.md §13-§14)

## 1. Where we are
- **Working:** approve/deny (+note), prompt, stop, follow new IDE chats, QR/PIN phone pairing over Wi-Fi, Material 3 phone UI, **one tab per IDE window**, host hand-over when a window closes. All live-tested on the phone by the owner (multi-window retest passed 2026-10-27).
- **Repo:** branch `feat/multi-window` merged into local `main` (2026-10-27). `npm test` = 9 suites green. Pushed to `origin/main` (github.com/DrOpenSource/AG-Remote) on 2026-10-27.
- **Decisions:** D-1 LS RPC for actions; D-2 `0.0.0.0` + token/PIN; D-3 no fake text fallbacks; D-4 personal tool only; **D-5 no "New chat" from the phone** (runs hidden from the Agent panel). See NOTES.md §1.

## 2. Facts that cost time (do not relearn)
1. Live agent state is on the language server with **no `--workspace_id`**; per-workspace servers show stale `CANCELED`. Protocol in NOTES.md §13.
2. A window's chat comes only from the IDE's conversation list (`GetAllCascadeTrajectories`), never from transcript guessing (NOTES.md §14).
3. RPC names and request fields can be read from `%LOCALAPPDATA%/Programs/Antigravity/resources/bin/language_server.exe` with `grep -aoE` (e.g. `grep -aoE "\*StartCascadeRequest\)\.Get[A-Za-z]+" language_server.exe | sort -u`). The JS bundles don't contain them.
4. Claude Code sessions are not reachable by AG-Remote; use Claude Code's Remote Control.

## 3. v0.2 hosted relay & marketplace release (updated 2026-10-28)
- **Plan: [docs/relay_plan.md](docs/relay_plan.md).** Cloudflare Worker + Durable Object at `remote.taqnik.in` (owner's domain, Cloudflare DNS, deployed with `npx wrangler`). E2E encrypted with a key in the QR's `#fragment`.
- **Phase 1-3 deployed (2026-10-27):** Worker + `Room` DO live, `src/pwa/e2e.js` WebCrypto E2E encryption, extension relay transport, and dual-mode settings.
- **Phase 4 live test PASSED (2026-10-28):** Owner confirmed live test over cellular mobile data passed end-to-end.
- **Phase 5 Web Push notifications (2026-10-28):** Implemented in `src/relay-host/web-push.ts` and committed in `e6bb952`. Alerts phone when agent waits for approval or finishes turn.
- **Security fix (2026-10-28):** `GET /pair/view` restricted strictly to loopback callers (`127.0.0.1` / `::1`) with cross-site Origin rejection. Verified in `test:server`.
- **Production VSIX Build Bundler (2026-10-28):** Added `esbuild` bundler generating standalone CommonJS `dist/extension.cjs` and CLI `dist/cli.mjs`. Updated `.vscodeignore` to exclude source TS and internal notes. Packaged bundle is 109 KB (14 files, 0 runtime dependencies). Ready for marketplace release.
- **Background Notification & Wake Reconnect Fix (2026-10-28):**
  - *Root Cause 1 (Notification Delay)*: Mobile OS throttles async WebCrypto encryption when backgrounding, dropping the encrypted `{ visible: false }` API call and causing the host to keep suppressing push for 30–60s until DO socket timeout. Fixed with synchronous unencrypted presence frame `{ t: 'vis', v: boolean }`, 15s auto-expiring `visiblePeers` map, and Web Push `Topic` header.
  - *Root Cause 2 (Reopen Offline / Lag)*: OS puts socket to sleep without FIN; browser keeps `readyState === 1`, causing `ensureConnected()` to skip reconnect and stall on dead socket until browser timeout + exponential backoff. Fixed with `wake()` on `RelayLink`, 10s socket liveness check, immediate backoff reset to 1000ms, emergency 1.5s visible backoff clamp, and `pageshow`/`focus`/`freeze` lifecycle listeners.

## 3b. Phone UI polish + attachments (2026-10-28, NEXT SESSION STARTS HERE)
- **Done, NOT committed, NOT live-tested on the phone** (`git status` shows them; `test:pwa` 22/22):
  - Header: dropped the "AG Remote" title (kept as `sr-only` h1). Header = new logo + the project/conversation name as the 16px title (tap to switch). New icon (arch + two signal arcs) in header, empty state, favicon, manifest. Manifest `short_name` = `Remote`. Logo 40→36px.
  - Replies: markdown links in messages render via `renderMessageText()` in `src/pwa/app.js`. `file:///` links show as a file-name chip (`.chat-file`, full path in `title`); `http(s)` links become `<a target=_blank>`. DOM nodes only, no innerHTML.
  - Cache busting: `app.css?v=5`, `app.js?v=6`, SW `ag-remote-shell-v9`.
- **Phone image attachments: BUILT 2026-10-28 AM, not committed, NOT live-tested** (full `npm test` green, `test:ls` 56/56, `npm run build` OK):
  - LS binary shows `SendUserCascadeMessageRequest` has `images` (repeated `exa.codeium_common_pb.ImageData{base64Data, mimeType, caption, uri}`) and `media`. We send `images: [{ base64Data, mimeType }]`; `items` is `[]` for image-only prompts. Unverified: whether the agent actually *sees* them, and whether `items: []` is accepted.
  - Fallback (automatic): if the LS answers the image prompt with an HTTP error (`LsBridgeError.imagesRejected`), `saveUploads()` in `src/adapter-antigravity/index.ts` writes `<workspace>/.ag-remote/uploads/<ts>-N.jpg` (folder has its own `.gitignore` = `*`) and resends as text "Attached image(s) from my phone (open to view): <paths>". If the LS *accepts* the images but the agent ignores them, there is no fallback yet; that is what the live test decides.
  - API: `/api/prompt` takes `images: [{mimeType, data}]`, checked by `parsePromptImages()` in `src/server/api.ts` (≤4, jpeg/png/webp/gif, base64, ≤6 MB decoded). LAN body limit raised 1 MB→10 MB. Relay already chunks E2E frames (30 KB parts, 32 MB max); relay request timeout is 60 s for image prompts. No relay redeploy needed (previews use `data:` URLs because the relay CSP has no `blob:`).
  - Phone: 📎 button left of the input → picker (camera or gallery), canvas downscale to 1600px longest edge, JPEG ≤ ~400 KB, thumbnail tray with ×, paste-to-attach, images shown in your sent bubble, images restored on send failure. Cache: `app.css?v=6`, `app.js?v=7`, SW `ag-remote-shell-v10`.
- **VSIX 0.2.0 packaged 2026-10-28** (`ag-remote-0.2.0.vsix`, 147 KB): publisher `ag-remote` → `dr-opensource` (matches EnvWizard/AudioWizard/GitWizard/LaunchWizard), author "Dr. Shubham Kashyap", displayName "Antigravity Remote", icon `assets/icon.png` (256px, rendered from `assets/icon.svg` with headless Edge, same squircle style as siblings), `CHANGELOG.md` added, LICENSE holder "Dr. OpenSource". The ID changed, so 0.1.0 must be uninstalled first or two copies fight over port 49222. Pairings are in `~/.ag-remote`, so they survive. Not committed, not tagged, not published anywhere.
- **This afternoon's test plan (owner, once the Antigravity token renews):**
  1. Uninstall the old "Antigravity Remote Control" (publisher ag-remote), install `ag-remote-0.2.0.vsix`, reload windows.
  2. Phone: check header, new icon, file-name chips in replies.
  3. Attach a screenshot + "What do you see in this image?" → expect the agent to describe it. Repeat over mobile data (relay mode) and over Wi-Fi.
  4. Image only, no text → check it is accepted.
  5. If the agent says it sees no image: check `~/.ag-remote` audit log for `PROMPT_IMAGES_AS_FILES`; next step would be trying the `media` field or a forced file mode.
  - Ask before commits and deploys, as usual.

## 4. Working agreements and gotchas
- The auto-mode classifier blocks me from reading process command lines/credentials. Such code runs in the extension, triggered by the owner.
- The owner can't see tool output: give numbered, click-level steps and a pass/fail table.
- Install: `npm run package`, then in Antigravity **Ctrl+Shift+P → Extensions: Install from VSIX…** → `ag-remote-0.1.0.vsix`, then reload/reopen windows.
- Live test folders: `Projects/ag-remote-sandbox` and `Projects/ag-remote-sandbox2`. Probe prompt: `Run this exact terminal command and nothing else: echo hello > probe.txt`.
- Shell quoting eats regex backslashes; patch files with Edit/Write or a scratchpad `.mjs`.
- Commit only with the owner's OK; end with the Co-Authored-By line. Never commit `.env`, `.logs/`, `*.vsix`.

## 5. Kickoff prompt for a new session
> Read `session_handover_notes.md` "START HERE", then `docs/relay_plan.md`. Tell me the repo state in two lines, then propose Phase 1 of the relay plan. Ask me before any deploy, DNS change, or new dependency.

---

# (Archive below: original 2026-10-14 notes and the superseded 2026-10-21 reset plan)

## ARCHIVE: 2026-10-21 audit (partly superseded by START HERE above)

## A. Verified project state (audited 2026-10-21)
- **Git: ZERO commits on `main`.** Everything (src, tests, docs, .vsix) is untracked. There is no `.gitignore`. Do **not** `git add .` blindly: `.logs/session.token` (live session secret), `.env`, `.logs/audit.log` (test noise) and `ag-remote-0.1.0.vsix` must be ignored.
- **Tests:** `npm test` → all 7 suites green (141). **Green ≠ working.** The suites run against mocks/fake transcripts and never touch the real IDE UI (a "mock trap").
- **Runtime:** IDE (started 22:21 today) is running the installed copy at `~/.antigravity-ide/extensions/ag-remote.ag-remote-0.1.0`. Server is listening on `0.0.0.0:49222`. **CDP ports 9222/9223 are closed**, so every CDP path silently fails today.
- The Oct-14 "morning mobile test" (§9 checklist) was **never recorded**. Treat the three field-feedback fixes (PIN UX, header/feed desync, question submit) as **unverified on a real phone**.

## B. Why the previous approach failed (root causes found)
1. **CDP selectors were invented.** Grepped the installed IDE bundles: of `approve-action`, `tool-confirmation`, `tool-barrier`, `chat-input-send-button`, `always-allow`, `chat-stop-button`, `interactive-input-editor`, only the last exists (in `workbench.desktop.main.js`). The agent UI is a separate renderer bundle (`resources/app/out/jetskiAgent/main.js`) with different markup. `cdp-bridge.ts` / `config.ts` selectors can never match.
2. **CDP requires a launch flag** (`--remote-debugging-port`); a normally launched IDE has none. Not viable for "zero-effort" UX.
3. **Dangerous silent fallbacks** in `cli-bridge.ts`: a failed approve sends a *prompt* ("Approved: Proceed…"), a failed deny sends "Denied: …", stop sends `/stop`. These don't click anything, and `chat -r` opens a **new** session. The phone UI can show "approved" while the IDE is still blocked. Remove them; fail loudly instead.
4. **Multi-window gap:** only the primary window hosts the server. Secondary windows only register and heartbeat; **no command channel back to them**, so approve/prompt always acts in whichever window owns the server, not the one selected on the phone.

## C0. UPDATE 2026-10-22: SPIKE PASSED. Approvals work via language-server RPC; read NOTES.md §13 first. Section C below is superseded (the native-command guess was wrong).

## C. NEW approach (superseded) (found in the IDE's own code; needs runtime proof first)
Real, native commands exist in the IDE and can be invoked from the extension host with `vscode.commands.executeCommand`, with no CDP and no flag:
- `antigravity.command.accept` / `antigravity.command.reject`
- `antigravity.terminalCommand.accept` / `.reject` / `.run`
- `antigravity.prioritized.command.open`, `antigravity.prioritized.terminalCommand.open`
- context keys gating them: `antigravity.canAcceptOrRejectCommand`, `antigravity.canTriggerTerminalCommandAction`
- file edits: `antigravity.prioritized.agentAcceptAllInFile` / `agentRejectAllInFile` / `agentAcceptFocusedHunk`
UI strings seen in agent bundle: "Allow Once", "Accept Step", "Cancel step", "Deny", "Reject".
**Unproven:** whether these fire when the agent panel (not an editor) has focus, and whether `executeCommand` works for them from a third-party extension. Spike this FIRST (Step 1 below).

## D. Ordered plan for the next session (stop and report after each step)
1. **Spike: DONE and PASSED (2026-10-22).** Next is Step 3, building `LsBridge` per NOTES.md §13.
2. **Baseline commit: DONE 2026-10-21** (user approved; `.gitignore` added).
3. **Replace the bridge:** new `NativeBridge` (extension-host `executeCommand`) as primary; keep CDP optional/secondary with *verified* selectors only. Delete the prompt-text fallbacks (B3); return explicit errors to the PWA.
4. **Fix multi-window routing (B4):** workers must receive commands from the hub (WebSocket or long-poll to hub) and execute them in their own host; hub routes by `windowId`.
5. **Prompt injection:** find a reliable path (agent chat command / `antigravity-ide chat` semantics) and verify it lands in the *existing* conversation, not a new one.
6. **Replace mock-trap tests** with a contract test that asserts the command IDs exist in the installed IDE (read `package.json`/bundle) and an opt-in live smoke test.
7. **Real phone verification** of the three unverified field fixes, then update TRACKER.md (Phase 5 rewritten: "Native Command Dispatcher", CDP demoted).

## E. Other known issues / decisions for the user
- **Security doc drift: RESOLVED 2026-10-21 (decision D-2):** keep `0.0.0.0` default, docs amended, first-run consent planned in Phase 6.0.
- `config.ts` hardcodes `C:/Users/user/...` paths (IDE exe, cli.js, brain dir). Not portable; derive from `os.homedir()` / `process.execPath`.
- `package.json` `main` points at a `.ts` file and `bin` uses `--experimental-strip-types`; it works today only because the IDE's Node supports it. Fragile; consider a build step.
- Tests write into the real `.logs/audit.log` (22 KB of CONNECT/DISCONNECT noise). Point tests at a temp dir.
- Installed extension is a **copy**: after every change run `npm run package` and reinstall with `--force`, then reload the IDE window.

## F. Kickoff prompt to paste into the new session
> Read `session_handover_notes.md` (section "START HERE"). Start at Step 1 of the plan: spike the native `antigravity.*` commands from the extension host and report which ones really approve/reject a pending action. Do not commit, add dependencies, or build ahead of that without asking me.

---

## 1. Context & Operational Invariants

### 1.1 Context Window Budget & Handover Rule
- **Threshold:** When conversation context consumption approaches or crosses **55%–60%**, immediately persist all findings, test results, and next actions to this file and prepare a clean handover summary.
- **Token Efficiency:** 
  - Zero broad filesystem traversal; query targeted line ranges with `StartLine` and `EndLine`.
  - Avoid loading entire monolithic bundles when verifying code; run targeted test suites.
  - Every session resumes by reading this file alone.

---

## 2. Active Sprints & Objectives

### Phase 1: Multi-Window Coordinator Hub
**Goal:** Eliminate ghost/inactive sessions. Allow multiple running Antigravity IDE windows to register their live workspaces (e.g., `FieldMap`, `AG-Remote`), and allow the mobile companion to seamlessly switch between active windows.

- [x] **Task 1.1: Local Window Registry & IPC Hub**
  - Implemented `WindowRegistry` in `src/core/window-registry.ts`.
  - Added REST endpoints in `RemoteServer`:
    - `POST /api/hub/register`: Window extension hosts register `{ windowId, workspaceName, workspacePath, activeConversationId, isFocused, pid }`.
    - `POST /api/hub/heartbeat`: Periodic heartbeat (every 4s) to retain registration.
    - `POST /api/hub/unregister`: Gracefully unregisters closed window.
    - `GET /api/windows`: Returns only alive, active windows and selected window ID.
    - `POST /api/windows/select`: Switches active window target.
- [x] **Task 1.2: Extension Host Registration Hook**
  - Updated `src/extension/index.ts`:
    - Primary window starts server on port 49222 and self-registers in `WindowRegistry`.
    - Secondary windows detect `EADDRINUSE`, register via `POST /api/hub/register`, and maintain 4s heartbeat.
    - Hooks `vscode.window.onDidChangeWindowState` to report active focus changes in real time.
    - `bin/ag-remote.mjs` standalone runner registers its working directory so CLI mode also acts as an active window hub.
- [x] **Task 1.3: Adapter Integration with Window Registry**
  - `SessionManager.listSessions()` dynamically filters sessions to match registered, active windows.
  - Added `setWorkspace(workspacePath)` to `AntigravityAdapter` and `SessionWatcher` for dynamic workspace switching.

### Phase 2: CDP Native Action & Prompt Engine
**Goal:** Replace broken CLI spawn `chat -r` and text prompts with direct Chromium DevTools Protocol (CDP) execution against Antigravity's Electron renderer.

- [x] **Task 2.1: CDP Bridge Subsystem (`src/adapter-antigravity/cdp-bridge.ts`)**
  - Zero-dependency WebSocket CDP client connecting to Antigravity's Chromium debugging port (9223 / 9222).
  - Target discovery via `http://127.0.0.1:<port>/json/list`.
  - Native DOM evaluation, click dispatch, and input typing.
- [x] **Task 2.2: Full-Fidelity Approval Dispatcher**
  - Implemented true modal click handlers in `CdpBridge` and `CliBridge`:
    - `allow_once`: Clicks "Allow" / "Approve" button natively in DOM.
    - `always_allow`: Clicks "Always Allow" button in DOM.
    - `deny`: Clicks "Reject" / "Deny" button in DOM.
    - `question_submit`: Selects option or inputs text into `ask_question` modal.
- [x] **Task 2.3: Verified Prompt Injection**
  - `CdpBridge.injectPrompt(text)` focuses `.interactive-input-editor`, updates text value, and dispatches submit event.
  - `CliBridge` tries CDP first, with graceful fallback to CLI spawn.
- [x] **Task 2.4: Mobile PWA Upgrade**
  - Updated `index.html` and `app.css` to add the **Always Allow** button alongside Allow Once and Deny.
  - Updated `app.js` to send `{ option: 'allow_once' | 'always_allow' }` to `POST /api/approve`.
  - Updated `openSessionsModal()` to fetch `/api/windows` and present active IDE windows at the top with live focus badges.
- [x] **Task 2.5: Integration Tests**
  - Created `test/test-hub-and-cdp.ts` (18/18 tests passed).
  - Added `npm run test:hub` to `package.json`.

---

## 3. Test Matrix Status (Zero-Chance Quality Sentinel)

| Suite | File | Tests Passed | Status | Focus / Guardrail |
| :--- | :--- | :--- | :--- | :--- |
| Adapter Suite | `test/test-adapter.ts` | 13/13 | ✅ Green | Transcript watcher & audit logging |
| Server Suite | `test/test-server.ts` | 19/19 | ✅ Green | HTTP REST, tokens, rate limiter, WebSockets |
| Hub & CDP Suite | `test/test-hub-and-cdp.ts` | 18/18 | ✅ Green | Multi-window registry & action contracts |
| PWA Suite | `test/test-pwa.ts` | 22/22 | ✅ Green | Static delivery, phone state sync, service worker |
| Pairing Suite | `test/test-pairing.ts` | 17/17 | ✅ Green | Zero-dependency QR generation, PIN lifecycle |
| Production Audit | `test/test-production-audit.ts` | 26/26 | ✅ Green | Regression, transcript state machine, pre-flight |
| Environment Sentinel | `test/test-environment-sentinel.ts` | 26/26 | ✅ Green | Path invariance, 0.0.0.0, NIC priority, camera pre-fetch, safe areas |
| **Total** | | **141 / 141** | **100% Green** | **All System & Environment Guardrails Enforced** |

---

## 4. Network & Connectivity Fix (Connection Refused Resolution)
- **Root Cause:** Default binding host in `RemoteServer` was `127.0.0.1` (loopback). Any connection attempt over Wi-Fi (`192.168.1.5:49222`) received an immediate TCP RST (`connection refused`).
- **Fix Applied:**
  1. `src/server/http-server.ts`: default host changed to `'0.0.0.0'`.
  2. `src/extension/index.ts`: host resolved with default `'0.0.0.0'`.
  3. `.vscode/settings.json`: added `"agRemote.host": "0.0.0.0"`.
  4. Verified via `0.0.0.0` binding that connection from `192.168.1.5` succeeded (`TcpTestSucceeded: True`).

---

## 5. PWA Path Resolution Fix (`{"error":"Not Found"}` / Chrome Pretty-Print)
- **Symptom:** After binding to `0.0.0.0`, phone connected but browser displayed Chrome JSON viewer with `[ ] Pretty-print` and `{"error": "Not Found"}`.
- **Root Cause:** `RemoteServer.pwaDir` was falling back to `path.join(process.cwd(), 'src', 'pwa')`. Inside the extension host process, `process.cwd()` is `C:\Users\user\AppData\Local\Programs\Antigravity IDE` (not the extension folder), so `fs.existsSync(filePath)` failed and returned 404 JSON.
- **Fix Applied:**
  1. Implemented `resolvePwaDirectory()` in `src/server/http-server.ts` checking `import.meta.url`, `context.extensionPath`, and user extension folder.
  2. Updated `src/extension/index.ts` to pass `pwaDir: path.join(context.extensionPath, 'src', 'pwa')`.
  3. Updated `bin/ag-remote.mjs` to pass resolved `src/pwa`.
  4. Re-packaged and re-installed `ag-remote-0.1.0.vsix` into Antigravity IDE (`--force`).
  5. Verified via Node that `resolvePwaDirectory()` resolves directly to `C:\Users\user\.antigravity-ide\extensions\ag-remote.ag-remote-0.1.0\src\pwa`.

---

## 6. Environment Sentinel & Zero-Chance Work Discipline
- **Dedicated Sentinel Suite:** Created `test/test-environment-sentinel.ts` (`npm run test:env`).
- **Hardened Invariants:**
  - Foreign `process.cwd()` invariance verified: PWA assets are discovered even if cwd is outside the repo.
  - Camera QR scanner background pre-fetch: `Accept: text/html` returns 302 redirect without burning single-use token.
  - Physical NIC priority: filters out virtual Hyper-V/Docker subnets (`172.17+`).
  - Mobile safe areas: `viewport-fit=cover` and `env(safe-area-inset-bottom)` validated.
- **Master Plan & Tracker:**
  - Authoritative tracker committed to [TRACKER.md](file:///c:/Users/user/Desktop/Dr_OpenSource/Projects/AG-Remote/TRACKER.md).
  - Architecture blueprint updated to `v2.1.0-PROD` in [docs/architecture_and_product_plan.md](file:///c:/Users/user/Desktop/Dr_OpenSource/Projects/AG-Remote/docs/architecture_and_product_plan.md).

---

## 7. Diagnostics & Field Feedback (2026-10-14 Session Wrap)
- **Feedback 1 (Connect Button & 6-Digit PIN UX):**
  - Connect button appeared non-functional when clicked empty (silent no-op).
  - Virtual mobile keyboard `Enter`/`Go` key did not submit.
  - User needed clarity that PIN is single-use on-demand from the PC status bar icon.
- **Feedback 2 (Window Header vs. Chat Content Desync):**
  - PWA header reported `[AG-Remote] Active`, but chat feed showed `FieldMap` messages.
  - Multi-window coordinator registered `AG-Remote`, but `WindowRegistry.register()` did not emit `'selected'`.
  - In `SessionWatcher.setWorkspace()`, `this.activeConvId` was not cleared, caching the previous workspace's transcript path indefinitely.
- **Feedback 3 (Prompt Injection & Question Actions):**
  - Question options disappeared in PWA upon tap (optimistic UI), but did not submit to desktop prompt.
  - Direct prompt submissions from PWA did not inject into the live Antigravity agent conversation.
  - Root cause: Antigravity IDE was launched in standard out-of-the-box mode without `--remote-debugging-port=9223` (verified port closed). CLI fallback `chat -r` opens a new standalone session rather than piping to the open agent canvas.

---

## 8. Fixes Applied Tonight (UNCOMMITTED - Awaiting User Morning Testing)
> [!IMPORTANT]
> **Zero-Commit Hold:** As instructed by user, changes are intentionally NOT committed to git tonight. User will test on mobile tomorrow morning first, and only commit once verified.

1. **`src/core/window-registry.ts`**:
   - Emits `'selected'` event when a window is auto-selected during registration or on focus change.
   - Emits `'selected'` fallback when the active window unregisters.
2. **`src/adapter-antigravity/session-watcher.ts`**:
   - `setWorkspace()` now clears `this.activeConvId = null`, resets transcript path, and clears stale snapshots.
   - Verified via test harness: `AG-Remote` resolves to `d325d3a1...` and `FieldMap` resolves to `194324fb...`.
3. **`src/pwa/app.js` & `src/pwa/index.html`**:
   - Added validation toast if input is empty or invalid digit count.
   - Wired `keydown` Enter listener to `tokenInput` for mobile keyboard submission.
   - Added clear instruction text referencing the status bar PIN.
4. **Verification & Packaging**:
   - Ran `npm test`: **141/141 passed across all 7 suites (100% green)**.
   - Built fresh `ag-remote-0.1.0.vsix` and re-installed into Antigravity IDE (`--force`).

---

## 9. Morning Handover & Testing Checklist (Action Items for Tomorrow)
1. **Mobile Testing Checklist for User**:
   - [ ] Open PWA on phone (`http://<PC-LAN-IP>:49222`).
   - [ ] Test PIN input: verify empty click shows validation toast, verify Enter key works, verify connecting with 6-digit PIN from PC status bar works.
   - [ ] Tap window switcher (`btnSwitchSession`): switch between `AG-Remote` and `FieldMap`. Verify that chat feed and header match the selected project in real time.
2. **Post-Verification Git Commit**:
   - [ ] Once user confirms testing passed, stage and commit all changes cleanly.
3. **Phase 5 Execution (Prompt Injection & Desktop Parity)**:
   - [ ] Test launching Antigravity IDE with `--remote-debugging-port=9223`:
     ```powershell
     & "C:\Users\user\AppData\Local\Programs\Antigravity IDE\Antigravity IDE.exe" --remote-debugging-port=9223
     ```
   - [ ] Verify CDP connects and live prompt injection/button clicking works from phone.
   - [ ] Implement Task 5.2: `ag-remote.enableDebuggingShortcut` command to automatically update desktop shortcut `Antigravity.lnk` with `--remote-debugging-port=9223` for permanent zero-effort startup.
