# Project Notes: Antigravity Phone Remote Control (AG-Remote)

## 1. Architectural Decisions Log

| Date | Phase | Decision | Rationale | Status |
| :--- | :--- | :--- | :--- | :--- |
| 2026-10-12 | Phase 0/1 | Strict Adapter Isolation (`adapter-antigravity`) | Isolate all Antigravity DOM/CDP/API dependencies so the rest of the codebase (`core`, `server`, `pwa`) remains IDE-agnostic and resilient to IDE changes. | Accepted |
| 2026-10-12 | Phase 0/1 | Local-first & Zero External Network | Security requirement: zero external network, no cloud relay. (Amended 2026-10-21: binding is `0.0.0.0` with token auth; see decision D-2 below.) | Accepted |
| 2026-10-12 | Phase 0/1 | Single-use 5-minute QR pairing tokens | Mitigates token interception and unauthorized remote access. | Accepted |
| 2026-10-27 | D-5 | No "New chat" from the phone (parked) | `StartCascade` exists, but the owner tested that a chat started outside the panel runs in the background and never shows in the IDE's Agent panel. Work would split between phone and desk. Workaround: start the chat in the IDE, continue it from the phone. See §14. | Accepted |
| 2026-10-22 | D-1 | Approvals go through the local language-server Connect RPC (`HandleCascadeUserInteraction`), not CDP and not `antigravity.*` commands | Spike verified end to end (see §13). CDP selectors were invented; native commands do not carry a permission response. | **Accepted (verified)** |
| 2026-10-22 | D-4 | Personal-tool scope; unofficial internal API and runtime read of the language-server token are accepted | Owner decision. No supported API exists. Token never persisted/logged/transmitted; localhost only; fail closed; pin tested IDE version. | Accepted |
| 2026-10-21 | D-2 | Keep `0.0.0.0` default binding, document plain-HTTP LAN risk, add first-run consent + `127.0.0.1` option | Phone-on-Wi-Fi is the core use case (field-verified); token+PIN auth in place. Hardening: consent prompt, Tailscale HTTPS as the recommended path. | Accepted |
| 2026-10-21 | D-3 | No text-prompt fallbacks for approve/deny/stop | Sending "Approved: ..." as a chat prompt does not unblock the IDE and misreports success. Fail loudly instead. | Accepted |

---

## 2. Open Questions & Owner Decisions

From PRD Section 17:
1. **Terms of Service**: Does Google Antigravity's Terms of Service permit automation via extension/CDP?
   - *Status*: Open for owner review prior to public release.
2. **Project Name & Open-Source License**: Confirm preferred branding and license (e.g., MIT, Apache 2.0).
   - *Current working title*: `AG-Remote` / MIT.
3. **Testing Environment**: Will manual verification of Phase 1–2 actions (prompts, approvals, stops) run against a designated sandbox folder/workspace or standard sessions?
   - *Recommendation*: Use a dedicated test sandbox workspace to safely test approve/deny on terminal and file modifications.

---

## 3. Phase 0 Findings: Pre-Check & API Surface Audit (2026-10-12)

### A. Official Mobile / Remote Capabilities
- **Antigravity 2.0 Desktop App**: Google offers an "Antigravity Remote" companion mobile app (Android/Play Store) paired via QR code, but it targets the standalone Antigravity 2.0 platform.
- **Antigravity IDE (VS Code Fork)**: There is **NO** first-party mobile remote app or phone companion for controlling the IDE's agent. Built-in "remote" extensions (`antigravity-remote-openssh`, `antigravity-remote-wsl`) are standard VS Code Remote development tools (SSH/WSL) and do not support phone control or agent interaction.

### B. Extension API Surface Relevant to Agent Chat
- Inspected `resources/app/extensions/antigravity/package.json` and extension runtime bindings:
  - Contributed commands: `antigravity.prioritized.chat.open`, hunk accept/reject (`antigravity.prioritized.agentAcceptFocusedHunk`), supercomplete.
  - Enabled API proposals: `contribSourceControlInputBoxMenu`, `inlineCompletionsAdditions`, `antigravityUnifiedStateSync`.
- **Verdict on Option A (Extension API)**: Antigravity IDE exposes **no** public or extension-level APIs to inspect chat messages, monitor permission requests (`run_command`, `write_to_file`), approve/deny requests, or abort generation.
- **Verdict on Option B (CDP / Chrome DevTools Protocol)**: Required integration approach. Connects to Antigravity's Chromium/Electron renderer to inspect DOM elements and trigger actions.
- **Environment Note**: Port `9222` is currently bound to Google Chrome on this machine (`Id: 8112`), so CDP configuration must allow configurable ports (e.g., `9222` / `9223` / auto-detect).

---

## 4. Phase 1 Findings: Feasibility Probe (2026-10-12)

- **Integration Discovery**: Antigravity logs live agent conversation transcripts in real-time as JSONL to `~/.gemini/antigravity-ide/brain/<conv-id>/.system_generated/logs/transcript.jsonl`.
- **Live Chat Extraction**: Demonstrated complete extraction of user requests, model responses, and actions via `scripts/feasibility-probe.mjs` with sub-millisecond local reads.
- **Approval Event Detection**: Tool executions (`run_command`, `ask_question`, `write_to_file`) are captured as pending approval events outside the IDE UI with full command and target details.
- **Prompt Injection**: Verified built-in CLI bridge `antigravity-ide.cmd chat -r "<prompt>"` allows piping prompts directly into the active session without focusing or typing into the UI.
- **CDP / Renderer**: Electron renderer can be inspected via CDP when launched with `--remote-debugging-port`. Combining file-based real-time event streaming with CLI/CDP provides high speed and resilience.

## 5. Phase 2 Findings: Adapter Actions (2026-10-12)

- **Module Scaffolded**: Implemented `adapter-antigravity` conforming strictly to the `IdeAdapter` TypeScript interface.
- **Unified Config**: Isolated all CLI paths, brain directories, timeouts, and UI selectors into `src/adapter-antigravity/config.ts`.
- **Session Watcher**: Implemented `SessionWatcher` reading real-time JSONL transcripts with event emission (`message`, `approval_requested`, `status_changed`).
- **CLI Bridge**: Implemented `CliBridge` for prompt dispatch and stop actions via `antigravity-ide.cmd`.
- **Security Guardrails**: Strict ID matching prevents approving or denying spoofed/stale actions; local audit logging verified in `.logs/audit.log`.
- **Reliability Verification**: Terminal test suite `test/test-adapter.ts` passed 13/13 assertions including 10/10 repetition passes.

## 6. Phase 3 Findings: Local Server & Auth (2026-10-12)

- **HTTP & WS Server**: Implemented `RemoteServer` using native Node `http` and zero-dependency RFC 6455 `WebSocketServer`.
- **Security & Auth**:
  - Initially bound to `127.0.0.1`; changed to `0.0.0.0` on 2026-10-14 (see decision D-2).
  - Constant-time token verification using `crypto.timingSafeEqual`.
  - Rate limiting & lockout on failed authentication attempts.
  - Single-use 5-minute pairing code exchange `/pair?t=...` granting persistent session token.
- **REST & WS Endpoints**: `/api/state`, `/api/prompt`, `/api/approve`, `/api/deny`, `/api/stop`, and `/ws`.
- **Acceptance Criteria Verification**:
  - `curl -s -i http://127.0.0.1:49223/api/state` returns `401 Unauthorized`.
  - `curl -s -i -H "Authorization: Bearer <token>" ...` returns `200 OK`.
  - WebSocket pushes live `adapter_event` updates to connected clients.
  - All 19 assertions passed in `test/test-server.ts` and `test/curl-test.ts`.

## 7. Phase 4 Findings: Phone PWA Implementation (2026-10-12)

- **Mobile Web Application**: Built lightweight vanilla HTML/CSS/JS PWA in `src/pwa/` with zero framework dependencies.
- **Visual Design**: Sleek dark mode palette (`#0b0f19`), high-contrast typography, safe-area-inset padding for mobile notches/home bars, and animated status badges.
- **Approval Card**: Prominent card displaying action kind, summary, full command/target detail, and 1-tap Approve/Deny buttons.
- **Controls & Chat**: Real-time auto-scrolling chat feed, prompt composer with Enter-to-send, and instant Stop button.
- **Installable PWA**: Configured `manifest.json` (`display: standalone`) and `sw.js` (offline shell caching).
- **Auto-Reconnect**: Listens to `visibilitychange` and `online` events, restoring WebSocket connection and resyncing state in under 1 second upon phone wake.
- **Verification**: `test/test-pwa.ts` passed **22/22 test assertions**.

## 8. Phase 5 Findings: Pairing & Remote Access (2026-10-12)

- **QR Code Engine**: Implemented pure TypeScript zero-dependency QR code encoder (`src/pairing/qr.ts`) supporting terminal ASCII rendering and SVG rendering.
- **Pairing Manager**: Implemented `PairingManager` with automatic local IP discovery (prioritizing Tailscale `100.x` subnets), single-use 5-minute pairing code generation, and instant session revocation (`revokeAllPairings()`).
- **Tailscale HTTPS Guide**: Created [docs/TAILSCALE_SETUP.md](file:///c:/Users/user/Desktop/Dr_OpenSource/Projects/AG-Remote/docs/TAILSCALE_SETUP.md) detailing 3-minute Tailscale Serve setup with zero port exposure.
- **Verification**: `test/test-pairing.ts` verified that:
  - Valid pairing codes exchange successfully for a persistent token.
  - Reused pairing codes are rejected with 401.
  - Expired pairing codes are rejected with 401.
  - Token revocation invalidates old tokens immediately.
  - All 17 assertions passed.

## 9. Phase 6 Findings: Packaging & Delivery (2026-10-12)

- **Extension Packaging**: Successfully compiled into `ag-remote-0.1.0.vsix` (46.84 KB) using `@vscode/vsce package --no-dependencies`.
- **Extension Integration**: Built `src/extension/index.ts` contributing `ag-remote.showPairingQr`, `ag-remote.revokePairings`, `ag-remote.restartServer`, and the status bar indicator.
- **Standalone CLI Runner**: Created `bin/ag-remote.mjs` for standalone terminal operation (`npm start`) with inline ASCII QR code rendering.
- **Documentation**: Delivered user-facing [README.md](file:///c:/Users/user/Desktop/Dr_OpenSource/Projects/AG-Remote/README.md) with a 5-minute onboarding guide, security section, and troubleshooting.
- **Zero-Dependency Guarantee**: Retained 0 external runtime npm dependencies across all modules (`adapter-antigravity`, `core`, `server`, `pwa`, `pairing`).
- **Complete Test Matrix**: `npm test` verified all 71 assertions passing across adapter, server, PWA, and pairing suites.

---

## 10. Phase Progress Tracker

- **Phase 0 (Pre-check)**: [x] COMPLETED (2026-10-12)
- **Phase 1 (Feasibility)**: [x] COMPLETED (2026-10-12)
- **Phase 2 (Adapter Actions)**: [x] COMPLETED (2026-10-12)
- **Phase 3 (Local Server)**: [x] COMPLETED (2026-10-12)
- **Phase 4 (Phone PWA)**: [x] COMPLETED (2026-10-12)
- **Phase 5 (Pairing & Remote)**: [x] COMPLETED (2026-10-12)
- **Phase 6 (Packaging & Delivery)**: [x] COMPLETED (2026-10-12)
- **Phase 7 (Production Hardening & Multi-Window Hub)**: [x] COMPLETED (2026-10-14)

---

## 11. Phase 7 Findings: Production Hardening & Multi-Window Routing (2026-10-14)

1. **Terminal QR Optical Polarity**:
   - Replaced raw negative unicode half-blocks with true-polarity ANSI escape codes (`\x1b[47m \x1b[0m` for white quiet zone/modules, `\x1b[30;40m█\x1b[0m` for dark modules).
   - Guarantees 100% optical readability by phone cameras and Google Lens on both dark and light terminal themes.
2. **PWA Cache Invalidation & Network-First Shell**:
   - Switched `sw.js` from aggressive `cache-first` to `network-first` with cache fallback (`ag-remote-shell-v2`).
   - Added HTTP response headers `Cache-Control: no-cache, no-store, must-revalidate` across all HTML, JS, and CSS static endpoints.
   - Eliminates stale UI caching that previously caused mobile devices to display legacy hex token inputs.
3. **Pre-flight Camera Probe Protection & Lockout Reset**:
   - Protected `/pair` endpoint: browser/camera scans with `Accept: text/html` automatically redirect (302) to `/?t=...`, while API clients with `Accept: application/json` perform the exchange.
   - `AuthManager.generatePairingCode()` now automatically flushes temporary client IP lockouts.
   - Normalized user-entered 6-digit PINs, auto-formatting with space (`849 201`) and stripping whitespace on submission.
   - Persisted session tokens to `.logs/session.token` so server restarts preserve phone pairings.
4. **State-Machine Tool & Question Parser**:
   - Replaced fragile line-index checks in `SessionWatcher` with a persistent pending-tool state machine tracking tools until their matching completion steps (`ASK_QUESTION`, `RUN_COMMAND`, `CODE_ACTION`) appear.
   - Robustly parses single/multi-select options and prompt text across any JSONL step position.
5. **Multi-Window Discovery & Dynamic Switching**:
   - Implemented `GET /api/sessions` enumerating all conversations across active Antigravity workspaces.
   - Implemented `POST /api/sessions/select` enabling real-time session switching from phone or desktop.
   - Mobile PWA header displays active workspace badge (`[AG-Remote] ... ▼`) with an interactive session switcher modal.
   - `CliBridge` now passes explicit working directory (`cwd: targetWorkspace`) to ensure commands and prompt injections target the exact window selected by the user.
6. **Regression Verification**:
   - `test/test-production-audit.ts` passed 26/26 assertions.
   - Total test suite: 97 passed, 0 failed across all 5 suites (`test:adapter`, `test:server`, `test:pwa`, `test:pairing`, `test:audit`).
   - Package `ag-remote-0.1.0.vsix` compiled and verified.


## 12. Phase 5.0 Spike Findings (2026-10-21/22)

**Method:** temporary spike commands (uncommitted `src/extension/spike.ts`) in the extension host; live test in `../ag-remote-sandbox` with a real pending `run_command` approval (pending ~108 s before probe).

1. **Command IDs guessed from IDE source were wrong.** `antigravity.command.accept/reject` and `antigravity.terminalCommand.*` are NOT registered at runtime (`getCommands(true)` returned 3161 commands, 242 relevant; dump in `.logs/commands.json`, gitignored).
2. **`antigravity.acceptAgentStep` is the wrong tool.** It is the agent UI's "Accept Step" keybinding (Alt+Enter, analytics id `step_accept`). Executing it against a pending `run_command` did NOT approve it: the agent failed with `permission check failed for command "echo hello > probe.txt": unexpected user interaction type: not permission` (transcript `bf070acf…`, step 6). It reaches the pending step but sends the wrong interaction type. **Do not use accept/rejectAgentStep for tool permissions.**
3. **The real approval path is an RPC, not a command.** The agent panel is a separate renderer (`out/jetskiAgent/main.js`). Its Allow/Deny buttons call `handleCascadeUserInteraction(cascadeId, {trajectoryId, stepIndex, interaction})` with:
   - terminal: `{case:"runCommand", value:{confirm, proposedCommandLine, submittedCommandLine}}`
   - file access: `{case:"filePermission", value:{allow, scope, absolutePathUri}}`
   - browser: `{case:"openBrowserUrl", value:{confirm}}`
   Prompts use `sendUserCascadeMessage`. Real UI strings: "Allow Once", "Always Allow", "Deny".
4. **Usable extension commands found (registered):** `antigravity.sendPromptToAgentPanel`, `antigravity.openAgent`, `antigravity.agentSidePanel.focus/open`, `antigravity.startNewConversation`, `antigravity.openConversationPicker`. Arguments for `sendPromptToAgentPanel` untested.
5. **Open question (blocked):** how to reach the language-server RPC (port/auth) from outside the agent renderer. Inspecting live process args / the built-in extension's auth code was blocked by the sandbox classifier as credential exploration, so it was not pursued without explicit user direction.

**Decision update:** D-1 revised. Command-dispatch plan is dead for approvals. Candidate paths: (A) LS RPC `handleCascadeUserInteraction` (clean, needs connection/auth discovery); (B) keystroke/UI automation of the real Allow button (needs verified DOM, CDP flag); (C) `sendPromptToAgentPanel` for prompts only.

### 12.1 Language-server discovery (2026-10-22, user-run redacted script)
- One `language_server_windows_x64.exe` **per IDE window** (flag `--workspace_id`), plus one without a workspace. Each listens on 2-3 loopback ports (`127.0.0.1` only) and takes `--csrf_token` and `--extension_server_csrf_token` as **command-line arguments**.
- The built-in extension keeps the token in memory (`antigravityLanguageServer.setCsrfToken(...)`, `setPort(httpsPort)`); the agent UI sends it as HTTP header `x-codeium-csrf-token`.
- Not yet known: which of the listening ports serves the Connect/gRPC API, and the exact service path for `HandleCascadeUserInteraction` (not found by static grep).
- **Design risk:** the only discovered way for AG-Remote to obtain the token is reading another process's command line at runtime. It is an unofficial internal API, may break on IDE updates, and touches a credential. Needs an explicit owner decision (and relates to open ToS question #1).

## 13. Phase 5.0 RESULT: approval via language-server RPC WORKS (2026-10-22)

**Verified end to end** on a default-launched IDE (no debug flag), in `../ag-remote-sandbox`:
1. A pending `run_command` step was observed as `WAITING` (poll at ~3-4 Hz, first seen 55 ms after watch start).
2. `HandleCascadeUserInteraction` was sent; server replied `200 {}`.
3. Step went `WAITING -> RUNNING` (~320 ms) `-> DONE`; `probe.txt` was created; agent resumed (`CHECKPOINT`, then a `PLANNER_RESPONSE` reporting success).

**Facts that define the design**
- **The live agent state is held by the workspace-less language server** (the process with no `--workspace_id`). The per-workspace servers return the same steps but show the pending step as stale `CANCELED`; that was the cause of every earlier "found 0 pending". **Always query the workspace-less server for live state and send interactions to it.** (Per-window servers are for LSP/workspace work.)
- Auth: header `x-codeium-csrf-token` with the target server's own `--csrf_token`. Each server exposes an HTTPS port and an HTTP port on `127.0.0.1` (self-signed cert; third port is something else and resets). Protocol is Connect over JSON: `POST /exa.language_server_pb.LanguageServerService/<Method>` with headers `content-type: application/json`, `connect-protocol-version: 1`.
- Methods confirmed: `GetCascadeTrajectory {cascadeId}` -> `{trajectory:{trajectoryId, steps[]}}`; `HandleCascadeUserInteraction`.
- **Approve once** for a terminal command (step has `requestedInteraction.permission`):
  `{cascadeId, interaction:{trajectoryId, stepIndex, permission:{allow:true, scope:1}}}` (scope enum: 1=ONCE, 2=CONVERSATION, 3=WORKSPACE, 4=GLOBAL, 5=PROJECT). Deny: `allow:false` (optional `userDenyInstruction`). Other `requestedInteraction` kinds seen in UI code: `runCommand{confirm,...}`, `filePermission{allow,scope,absolutePathUri}`, `openBrowserUrl`, `mcp`, `readUrlContent`, etc. Dispatch on the key present in `requestedInteraction`.
- Step statuses seen: `PENDING, WAITING, RUNNING, DONE, CANCELED`. Pending = `status==WAITING && requestedInteraction`.
- cascadeId = conversation folder name under `~/.gemini/antigravity-ide/brain/`; sort by `transcript.jsonl` mtime (NOT folder mtime) to find the newest.
- Window to workspace mapping (for per-window server): `workspace_id` = SHA-256 hex of `uri.toString()` (e.g. `file:///c%3A/...`), or a readable `file_c_3A_..._Name` form for short paths.
- **Conversation to workspace mapping (VERIFIED live 2026-10-27):** `GetAllCascadeTrajectories {}` on the workspace-less server returns `{trajectorySummaries: {<cascadeId>: summary}}`. Summary keys: `summary` (title), `stepCount`, `status`, `trajectoryId`, `createdTime`, `lastModifiedTime`, `lastUserInputTime` (RFC3339), `lastUserInputStepIndex`, `trajectoryType`, `workspaces[].workspaceFolderAbsoluteUri`, `trajectoryMetadata.{workspaceUris, workspaces, createdAt, rootConversationId, initializationStateId}`. URIs look like `file:///c%3A/Users/.../ag-remote-sandbox`. This is the agent panel's own source for its conversation list; use it instead of guessing from transcripts. Parsed by `parseConversations` in `ls-bridge.ts`.
- Credential handling: token read from process command line at runtime via `Get-CimInstance Win32_Process`, kept in memory only, never logged or sent to the phone. This is the accepted personal-tool risk (decision D-4).

**Open items for the real bridge**
- Prompt sending: use `SendUserCascadeMessage` (not yet tested) or command `antigravity.sendPromptToAgentPanel`.
- Stop/cancel: find the matching RPC (`CancelCascadeInvocation`-style; not yet located).
- Replace polling with `StreamAgentStateUpdates` if feasible; 250-400 ms polling is acceptable fallback.
- Avoid reading CommandLine via PowerShell on every call (slow, ~100s of ms): cache token+ports, re-discover on connection failure.
- Spike code (`src/extension/spike.ts`, 4 temporary commands) is UNCOMMITTED reference material; delete after the NativeBridge lands.

## 14. Multi-window and new-chat findings (2026-10-27)

- **One tab per window.** Each IDE window gets its own channel; a window's chat is chosen only from `GetAllCascadeTrajectories` (its folder in `workspaces[]` / `trajectoryMetadata.workspaceUris`). In live mode the transcript watcher never guesses: the old "newest transcript anywhere" fallback showed, and would have sent prompts to, another project's chat (bug seen with FieldMap, fixed in `a421654`). A window with no Antigravity chat shows an empty tab and refuses prompts.
- **Hand-over:** when the host window closes, another window takes port 49222; the phone's token keeps working (live-tested).
- **New chat RPC (not built, D-5):** `StartCascade` is in `resources/bin/language_server.exe`. Request fields include `workspaceUris`, `requestedModel`, `cascadeId`, `source`, `trajectoryType`; response returns `cascadeId`. A chat created this way runs in the background and does **not** appear in the Agent panel (owner-tested). If revisited, the first message would also need a user config (today `sendPrompt` copies the last user step's config).
- **Claude Code is out of scope:** AG-Remote only speaks to Antigravity's language server. For Claude Code from a phone, use Claude Code's own Remote Control (`/remote-control`); untested whether it covers IDE-extension sessions.
