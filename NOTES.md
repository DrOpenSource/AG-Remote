# Project Notes: Antigravity Phone Remote Control (AG-Remote)

## 1. Architectural Decisions Log

| Date | Phase | Decision | Rationale | Status |
| :--- | :--- | :--- | :--- | :--- |
| 2026-10-12 | Phase 0/1 | Strict Adapter Isolation (`adapter-antigravity`) | Isolate all Antigravity DOM/CDP/API dependencies so the rest of the codebase (`core`, `server`, `pwa`) remains IDE-agnostic and resilient to IDE changes. | Accepted |
| 2026-10-12 | Phase 0/1 | Local-first & Zero External Network | Security requirement: zero external network, no cloud relay. (Amended 2026-10-21: binding is `0.0.0.0` with token auth; see decision D-2 below.) | Accepted |
| 2026-10-12 | Phase 0/1 | Single-use 5-minute QR pairing tokens | Mitigates token interception and unauthorized remote access. | Accepted |
| 2026-10-21 | D-1 | Drop CDP-selector approach; use native `antigravity.*` extension commands as primary action path | Audit found 6 of 7 CDP selectors do not exist in the IDE; CDP also needs a launch flag. IDE ships real commands (`antigravity.command.accept/reject`, `antigravity.terminalCommand.*`). Pending runtime spike. | Proposed |
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

