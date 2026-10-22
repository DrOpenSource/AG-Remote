# Antigravity Remote: Phase-Wise Engineering Tracker & Quality Sentinel

**Target:** Google Antigravity / Gemini Code Ecosystem  
**Repository:** `c:\Users\user\Desktop\Dr_OpenSource\Projects\AG-Remote`  
**Quality Policy:** Zero Chance Policy — 100% Reality-Verified, Zero-Mock Trap Discipline  
**Last Updated:** 2026-10-14  

---

## 1. Executive Status Dashboard

| Phase | Title | Scope & Focus | Tests | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Phase 1** | **Multi-Window Coordinator Hub** | IPC Hub, active window registration, multi-project routing | 18 / 18 | 🟢 **Complete** |
| **Phase 2** | **Full-Fidelity Action Engine** | 3-button actions (`Allow Once`, `Always Allow`, `Deny`), `ask_question` cards | 18 / 18 | 🟢 **Complete** |
| **Phase 3** | **Mobile PWA Client Experience** | Edge-to-edge UI, dark mode, window switcher modal, token exchange | 22 / 22 | 🟢 **Complete** |
| **Phase 4** | **System & Environment Sentinel** | Reality verification (`0.0.0.0`, path invariance, safe-area, camera pre-fetch) | 26 / 26 | 🟢 **Complete** |
| **Phase 5** | **Language-Server Bridge** | Connect RPC to the live agent server replaces CDP; spike PASSED 2026-10-22 | Spike verified | 🟡 **Next: build NativeBridge** |
| **Phase 5b** | **Real-World Verification** | Live smoke tests, real phone verification of Oct-14 fixes | Pending | ⚪ **Planned** |
| **Phase 6** | **Ship-Ready Release** | Single-click VSIX, zero telemetry, automated recovery & stress validation | Pending | ⚪ **Planned** |

**Current Test Metric:** 141 / 141 green, but mock-based. They do not prove the IDE actions work (audit 2026-10-21).

---

## 2. Detailed Phase Tracking Matrix

### Phase 1: Multi-Window Coordinator Hub
* **Objective:** Eliminate ghost sessions and allow seamless switching between concurrent Antigravity IDE workspace windows.
* **Tasks:**
  - [x] **Task 1.1:** Implement `WindowRegistry` in `src/core/window-registry.ts` with auto-pruning.
  - [x] **Task 1.2:** Implement Primary-Worker hub server protocol (`/api/hub/register`, `/api/hub/heartbeat`, `/api/hub/unregister`).
  - [x] **Task 1.3:** Wire `src/extension/index.ts` to detect `EADDRINUSE` and self-register as worker on primary hub.
  - [x] **Task 1.4:** Hook `vscode.window.onDidChangeWindowState` to report live focus changes.
* **Environmental Invariants:**
  - Dead window cleanup timer must have `.unref()` so it does not block Node process termination.
  - Hub must accept registrations over loopback without requiring bearer token.
* **Verification:** `npm run test:hub` (18/18 tests passed).

---

### Phase 2: Full-Fidelity Action & Approval Engine
* **Objective:** Provide exact desktop parity on mobile with full 3-option tool confirmations and interactive question modals.
* **Tasks:**
  - [x] **Task 2.1:** Implement `CdpBridge` with zero-dependency WebSocket client for Chromium DevTools Protocol.
  - [x] **Task 2.2:** Support `allow_once` (`button.approve-once`), `always_allow` (`button.always-allow`), and `deny` with reason.
  - [x] **Task 2.3:** Parse `ask_question` options and choices from transcript and render responsive option cards.
  - [x] **Task 2.4:** Enforce security rule: Reject approval if client ID does not match active pending gate.
* **Environmental Invariants:**
  - If approval queue is empty or ID differs, fail safely with explicit error rather than executing arbitrary actions.
* **Verification:** `npm run test:adapter` & `npm run test:hub` (31/31 tests passed).

---

### Phase 3: Mobile PWA Client Experience
* **Objective:** Deliver a consumer-grade mobile web companion for phone browser and PWA standalone mode.
* **Tasks:**
  - [x] **Task 3.1:** Implement responsive AMOLED dark theme with Google Gemini color tokens.
  - [x] **Task 3.2:** Build single-use pairing exchange (`/pair?t=<code>`) with instant PWA redirect.
  - [x] **Task 3.3:** Add tactile vibration feedback (`navigator.vibrate`) on action triggers.
  - [x] **Task 3.4:** Add active window switcher modal with real-time focus indicators.
  - [x] **Task 3.5:** Configure Service Worker (`sw.js`) with Network-First strategy to prevent stale code lock.
* **Environmental Invariants:**
  - Mobile safe areas (`env(safe-area-inset-bottom)`) must protect input bar from iOS/Android home indicators.
  - Viewport must have `viewport-fit=cover` and `user-scalable=no`.
* **Verification:** `npm run test:pwa` (22/22 tests passed).

---

### Phase 4: System & Environment Sentinel (The "Zero-Chance" Test Guard)
* **Objective:** Eliminate mock traps by validating assumptions against the real runtime environment.
* **Tasks:**
  - [x] **Task 4.1:** Bind `RemoteServer` to `0.0.0.0` (INADDR_ANY) by default to prevent Wi-Fi `ECONNREFUSED`.
  - [x] **Task 4.2:** Implement `resolvePwaDirectory()` using `import.meta.url` and `context.extensionPath` to eliminate `process.cwd()` traps.
  - [x] **Task 4.3:** Build `test/test-environment-sentinel.ts` to test path invariance, IP priority, and scanner pre-fetches.
  - [x] **Task 4.4:** Protect single-use tokens from camera QR scanner background previews via `Accept: text/html` 302 redirects.
  - [x] **Task 4.5:** Wire `test:env` into `package.json` and enforce in root `npm test`.
* **Environmental Invariants:**
  - Server must never default to `127.0.0.1`.
  - PWA path resolution must succeed even if `process.cwd()` is set to `C:\` or temporary folders.
* **Verification:** `npm run test:env` (26/26 tests passed).

---

### Phase 5: Native Command Dispatcher (Next)
* **Objective:** Approve/deny/stop/prompt in the real IDE with no launch flag and no guessed DOM selectors.
* **Why the old plan was dropped:** see NOTES.md D-1/D-3 and session_handover_notes.md §B.
* **Tasks (stop and report after each):**
  - [x] **5.0 Spike (PASSED):** real approval sent via `HandleCascadeUserInteraction`, agent resumed. See NOTES.md §13.
  - [ ] **5.1 LsBridge:** discover live (workspace-less) server, cache token/ports, `permission` approve/deny + other interaction kinds, stop, prompt; remove prompt-text fallbacks (D-3); explicit errors to PWA.
  - [ ] **5.2 Multi-window routing:** hub routes commands by `windowId`; worker windows execute in their own extension host.
  - [ ] **5.3 Prompt injection:** verified delivery into the *existing* conversation.
  - [ ] **5.4 Bridge indicator in PWA** (native / unavailable) and CDP kept optional with verified selectors only.
* **Acceptance:** with a default-launched IDE, a phone tap unblocks a real pending approval in the selected window.

### Phase 5b: Real-World Verification
- [ ] Contract test: required command IDs exist in the installed IDE. Opt-in live smoke test.
- [ ] Tests use a temp log dir (stop polluting `.logs/audit.log`).
- [ ] Real-phone run of Oct-14 fixes (PIN UX, header/feed sync, question submit).

### Phase 6: Google/Gemini Production Release & Hardening
* **Objective:** Production-grade distribution, documentation, and stress resilience.
* **Tasks:**
  - [ ] **Task 6.0 (hardening):** first-run LAN-exposure consent, portable paths (no hardcoded `C:/Users/user`), build step instead of raw `.ts` entry, doc/code parity.
  - [ ] **Task 6.1:** Run multi-device concurrent stress test (Phone + Tablet + PC).
  - [ ] **Task 6.2:** Validate zero telemetry and strict data localization across all logging.
  - [ ] **Task 6.3:** Complete final packaged release `ag-remote-0.1.0.vsix` with automated installation instructions.

---

## 3. Environment Sentinel Guardrails

| Guardrail Domain | Risk Prevented | Automated Test Suite |
| :--- | :--- | :--- |
| **Path Invariance** | `process.cwd()` pointing to IDE binary folder instead of extension bundle | `test/test-environment-sentinel.ts` (Suite 1) |
| **Network Binding** | Binding to loopback rejecting phone Wi-Fi connections with `ECONNREFUSED` | `test/test-environment-sentinel.ts` (Suite 2) |
| **NIC Prioritization** | Exposing Hyper-V/Docker virtual adapter IPs instead of Wi-Fi LAN / Tailscale | `test/test-environment-sentinel.ts` (Suite 2) |
| **Scanner Pre-fetch** | Phone camera background pre-render consuming single-use PIN before user clicks | `test/test-environment-sentinel.ts` (Suite 3) |
| **Safe-Area Display** | Mobile gesture bar covering prompt input and Send button | `test/test-environment-sentinel.ts` (Suite 4) |
| **Safety Invariants** | Blind execution or spoofed approval IDs bypassing user confirmation | `test/test-environment-sentinel.ts` (Suite 5) |
| **Offline Resilience** | Mobile sleep/wake severing WebSocket connections | `test/test-pwa.ts` & `test/test-server.ts` |

---

## 4. Test Suite Execution Summary

```bash
npm test
```
* `test:adapter` (13/13) — Antigravity transcript watcher & audit logs
* `test:server` (19/19) — HTTP REST, auth tokens, rate limiting, and WebSockets
* `test:hub` (18/18) — Multi-window coordinator, heartbeats, and focus tracking
* `test:pwa` (22/22) — PWA asset delivery, mobile state machine, and service worker
* `test:pairing` (17/17) — Zero-dependency QR generation, LAN discovery, PIN exchange
* `test:audit` (26/26) — Production regression suite, transcript state machines
* `test:env` (26/26) — Environment & system assumptions sentinel
* **Total: 141 passed, 0 failed (100% green)**

---

## 5. Session Plan 2026-10-22: Language-Server Bridge (personal-tool v1)

Legend: ✅ do today (verified path) · 🟡 do today after a short live probe · ⬜ later

| # | Feature | Source of truth / how | Status today |
| :-- | :-- | :-- | :-- |
| 1 | Discover live agent server, cache token + ports, re-discover on failure | workspace-less `language_server_windows_x64`; token in memory only | ✅ |
| 2 | Accurate pending-approval detection (replaces transcript guessing) | `GetCascadeTrajectory`, step `WAITING` + `requestedInteraction` | ✅ |
| 3 | Approve: "Yes, allow this time" | `permission{allow:true,scope:1}` (verified) | ✅ |
| 4 | Approve: "Always allow in this conversation" | `permission{allow:true,scope:2}` | ✅ (same shape, scope enum known) |
| 5 | Deny with instruction ("No, tell the agent…") | `permission{allow:false,userDenyInstruction}` | ✅ |
| 6 | Approval card shows exact command, folder, options (mirrors IDE) | step `runCommand` + `permission.resource` | ✅ |
| 7 | Other request kinds: file access, browser URL, MCP, read URL | `filePermission`, `openBrowserUrl`, `mcp`, `readUrlContent` (shapes in UI code) | 🟡 (verify each with a live prompt) |
| 8 | Multiple pending approvals across conversations/windows | one live server sees all conversations; select by `cascadeId` | ✅ |
| 9 | Remove fake fallbacks; explicit errors to phone | delete "Approved:/Denied:/`/stop`" prompts and CDP selectors | ✅ |
| 10 | Live conversation view | existing transcript watcher (works) | ✅ keep |
| 11 | Send prompt into the existing conversation | `SendUserCascadeMessage` (shape in bundle, untested) | 🟡 |
| 12 | Stop generation | cancel RPC (name not yet located) | 🟡 |
| 13 | "Always allow this command" (persist grant, wider scope) | `permission{scope:3/4,persistGrants}` | 🟡 |
| 14 | Contract + real tests, isolated log dir, replace mock-trap suites | assert message shapes; opt-in live smoke test | ✅ |
| 15 | Real-phone verification of PIN UX, header/feed sync | needs the user's phone | 🟡 (needs you, ~10 min) |
| 16 | LAN-exposure first-run consent, portable paths, build step | Phase 6.0 hardening | ⬜ |
| 17 | Push notification when agent is waiting | needs a service worker push channel | ⬜ |
| 18 | Streaming instead of polling (`StreamAgentStateUpdates`) | optional optimization | ⬜ |
