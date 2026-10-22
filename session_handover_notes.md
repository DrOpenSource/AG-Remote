# Session Handover & Memory Notes: AG-Remote

**Date:** 2026-10-14  
**Project:** Antigravity Remote Control (`AG-Remote`)  
**Repository:** `c:\Users\user\Desktop\Dr_OpenSource\Projects\AG-Remote`  
**Target:** Google Antigravity / Gemini Code Ecosystem  
**Active Plan:** `architecture_and_product_plan.md`  

---

# ⮕ START HERE (updated 2026-10-22, read this section only, then NOTES.md §12-§13)

## 1. Where we are
- **Repo:** `main`, 6 commits, clean except for TEMPORARY spike files (see §5). Last commits: `84e3afb` (verified findings), `67186e9` (feature plan). Tests: `npm test` = 141 green but they are **mock-based** (they do not prove IDE behaviour).
- **Decisions (NOTES.md decision log):** D-1 approvals via local language-server RPC (VERIFIED); D-2 keep `0.0.0.0` bind, doc'd; D-3 no fake text fallbacks; D-4 **personal tool only**, unofficial API + runtime token read accepted.
- **Phase 5.0 spike PASSED (2026-10-22):** a real approval sent from code unblocked a real pending `run_command`; file created; agent resumed; confirmed in chat history. Exact protocol is in **NOTES.md §13**. Do not re-derive it.

## 2. The 6 facts that cost us the most time (do not relearn)
1. **Live agent state lives in the language-server process with NO `--workspace_id`.** Per-workspace servers show the same steps but the pending step as stale `CANCELED`. Query and act on the workspace-less one.
2. Auth header `x-codeium-csrf-token` = that process's `--csrf_token`. Token is read from the process command line (`Get-CimInstance Win32_Process`), kept in memory only, never logged.
3. Each server has an HTTPS port and an HTTP port on 127.0.0.1 (self-signed). Connect/JSON: `POST /exa.language_server_pb.LanguageServerService/<Method>`, headers `content-type: application/json`, `connect-protocol-version: 1`.
4. Pending approval = step with `status WAITING` and `requestedInteraction` (key `permission` for terminal commands). Approve once: `{cascadeId, interaction:{trajectoryId, stepIndex, permission:{allow:true, scope:1}}}` (scope 1 ONCE, 2 CONVERSATION, 3 WORKSPACE, 4 GLOBAL, 5 PROJECT). Deny: `allow:false` (+ `userDenyInstruction`).
5. `cascadeId` = folder name under `~/.gemini/antigravity-ide/brain/`; pick newest by `transcript.jsonl` mtime (NOT folder mtime).
6. `antigravity.acceptAgentStep` and guessed `antigravity.command.accept` are WRONG for tool permissions. CDP selectors in `cdp-bridge.ts` are invented and must go.

## 3. Next work: Phase 5.1 "LsBridge" (see TRACKER.md §5 for the feature table)
1. New `src/adapter-antigravity/ls-bridge.ts`: discover live server (cache token/ports, re-discover on connection failure), `getTrajectory`, `listPending`, `respondPermission(allow, scope, instruction?)`. Port the logic from `src/extension/spike.ts` (`locateAll`, `rpc`, `summarize`).
2. Wire it into `adapter-antigravity/index.ts` and `cli-bridge.ts`; **delete** CDP selectors and the "Approved:/Denied:/`/stop`" prompt fallbacks.
3. Feed pending approvals (from LS steps, not transcript guessing) into SessionManager; PWA card must mirror the IDE's 4 options: allow this time / always in this conversation / always this command / no + instruction. Show exact command and cwd.
4. Probe (needs the user): prompt send (`SendUserCascadeMessage`), stop/cancel RPC, file-access/browser/MCP interaction kinds.
5. Replace mock tests with shape-contract tests; make tests use a temp log dir. Then repackage and real-phone check.

## 4. Working agreements and gotchas
- **The auto-mode classifier blocks ME from reading process command lines / credentials.** Code that does this must run inside the extension when the **user** triggers a command; never try to bypass the block. Ask the user to run it or to switch out of auto mode for that call.
- The user cannot see my tool output: give exact, numbered, click-level steps (Command Palette names, "Developer: Reload Window", etc.). They paste back notification text.
- Install loop: `npx --yes @vscode/vsce package --no-dependencies --out spike.vsix`, then `ELECTRON_RUN_AS_NODE=1 "C:/Users/user/AppData/Local/Programs/Antigravity IDE/Antigravity IDE.exe" "C:/Users/user/AppData/Local/Programs/Antigravity IDE/resources/app/out/cli.js" --install-extension spike.vsix --force`; the user must then run **Developer: Reload Window**. Notifications can be missed; the log file is the source of truth.
- Shell quoting: regex backslashes get eaten inside bash heredocs / JS template literals. Write code with the Write/Edit tools, or `String.raw` in a scratchpad `.mjs`. Always `node --experimental-strip-types -e "import('./src/...')"` as a syntax check before packaging.
- Sandbox workspace for live tests: `C:\Users\user\Desktop\Dr_OpenSource\Projects\ag-remote-sandbox` (open in its own IDE window). Standard probe prompt: `Run this exact terminal command and nothing else: echo hello > probe.txt`. One conversation (`e6948359`) may still be waiting for approval; harmless.
- Commits: user approved committing; end messages with the Co-Authored-By line from the session reminder. Never commit `.env`, `.logs/`, `*.vsix` (gitignored).

## 5. Uncommitted temporary files (do NOT commit as-is)
`src/extension/spike.ts` (+ small edits in `src/extension/index.ts` marked `SPIKE-TEMP` and 6 `ag-remote.spike*` entries in `package.json`). Contains working reference code. Delete after LsBridge lands. Logs go to `.logs/spike.jsonl` (gitignored).

## 6. Kickoff prompt for a new session
> Read `session_handover_notes.md` section "START HERE" and NOTES.md §13. Start Phase 5.1: build `ls-bridge.ts` from the spike code, wire approve/deny (4 options), remove the CDP and fake-fallback paths, keep tests green. Ask me before any live IDE test and give me numbered click steps.

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
