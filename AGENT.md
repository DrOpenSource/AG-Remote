# AGENT.md: Phone Remote Control for Google Antigravity (MVP)

> **Specification & Operational Guide for Agent Execution**  
> Target Platform: Windows 11 (x64) | IDE: Google Antigravity (VS Code fork)  
> Repository: `AG-Remote`

---

## 1. Project Overview & Mission

The goal of this project is to build an MVP phone remote control for Google Antigravity. When developers step away from their desk, the Antigravity agent frequently stalls waiting for permission confirmation or further prompt instruction. This tool lets developers:
1. View live agent conversation state.
2. Approve or Deny pending tool/command permission requests with one tap.
3. Send new text prompts to the active session.
4. Stop active generation immediately.

Everything runs strictly locally on the user's computer via an embedded extension server and a lightweight phone PWA. No hosted relays, no user accounts, and zero external telemetry.

---

## 2. Hard Non-Goals (MVP Boundary)

Do **NOT** implement or plan code for the following in MVP:
- **No** Cursor, VS Code, or other IDE support (keep architecture cleanly isolated, but implement only Antigravity).
- **No** native iOS/Android mobile apps or app-store builds.
- **No** hosted cloud relays, external backend servers, user accounts, or telemetry.
- **No** mobile code editing, file tree browsing, terminal emulation, or diff viewer.
- **No** paid features, licensing checks, or monetization hooks.
- **No** macOS/Linux support (keep code portable, but test and optimize solely on Windows 11 x64).

---

## 3. Strict Execution Protocol

Every agent working in this repository **MUST** adhere to the following execution rules:

1. **Phase-by-Phase Execution**:
   - Work strictly on one phase at a time.
   - **DO NOT build ahead** or anticipate future phase implementations.
2. **Stop and Wait Gate**:
   - At the completion of each phase, output a concise status summary in **under 10 lines**.
   - Explicitly request and wait for user approval before beginning any work on the next phase.
3. **Architectural & Dependency Approvals**:
   - Always ask the user before adding new npm/runtime dependencies.
   - Always ask before making structural or architectural modifications.
4. **Maintain `NOTES.md` Continuously**:
   - Record all architectural decisions, integration discoveries, selector mapping strategies, and open questions in [NOTES.md](file:///c:/Users/user/Desktop/Dr_OpenSource/Projects/AG-Remote/NOTES.md).
5. **Failure & Resilience Mandate**:
   - If Antigravity UI updates or changes, the extension must fail gracefully with an explicit message (`Antigravity UI changed, update the extension`). Never silently misbehave or approve the wrong item.

---

## 4. Architectural Boundaries

The project is structured into 5 isolated components:

```
Phone (PWA) <---HTTPS/WSS---> Local Server (Extension) <---Adapter---> Antigravity IDE
```

| Component | Responsibility | Boundary Rules |
| :--- | :--- | :--- |
| `adapter-antigravity` | Implements `IdeAdapter`. Interfaces with Antigravity UI / CDP / APIs. | **ONLY** module permitted to contain Antigravity-specific selectors, DOM hooks, or CDP calls. All selectors configured in one file. |
| `core` | Session state store, approval queue, event bus, command routing. | Completely IDE-agnostic. No UI or network code. |
| `server` | Node HTTP + WebSocket server, token authentication, PWA static serving. | Binds to `0.0.0.0` by default (LAN/Tailscale reachable; configurable via `agRemote.host`). Validates all auth tokens. |
| `pwa` | Mobile web application (HTML/CSS/TS or minimal bundle, dark mode default). | Runs on mobile Safari & Chrome. Auto-reconnects and resyncs snapshot. |
| `extension` | VS Code extension entry point, lifecycle management, pairing QR generation. | Starts local server, coordinates adapter lifecycle, handles UI commands. |

### Adapter Contract (`IdeAdapter`)

```typescript
export interface IdeAdapter {
  readonly name: string; // "antigravity"
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getSnapshot(): Promise<SessionSnapshot>;
  sendPrompt(text: string): Promise<void>;
  getPendingApproval(): Promise<Approval | null>;
  approve(id: string): Promise<void>;
  deny(id: string): Promise<void>;
  stop(): Promise<void>;
  onEvent(cb: (e: AdapterEvent) => void): void;
}

export type SessionStatus = "idle" | "generating" | "awaiting_approval" | "disconnected";

export interface SessionSnapshot {
  status: SessionStatus;
  messages: Array<{ id: string; role: "user" | "agent"; text: string; ts: number }>;
  pendingApproval: Approval | null;
}

export interface Approval {
  id: string;
  kind: string; // e.g., "command", "file_edit", "tool"
  description: string;
  detail?: string;
}

export type AdapterEvent =
  | { type: "message"; message: { id: string; role: "user" | "agent"; text: string; ts: number } }
  | { type: "approval_requested"; approval: Approval }
  | { type: "status_changed"; status: SessionStatus }
  | { type: "adapter_error"; error: string };
```

---

## 5. Security Guardrails (Non-Negotiable)

1. **Network Binding (amended 2026-10-21)**: Server binds to `0.0.0.0` by default so a phone on home Wi-Fi can connect; it is token-gated but plain HTTP on the LAN. `agRemote.host=127.0.0.1` restricts it to this PC (use with Tailscale Serve for HTTPS). Never port-forward. See NOTES.md decision log.
2. **Cryptographic Tokens**: Generate >= 128-bit cryptographically secure random session tokens (`crypto.randomBytes(16)`).
3. **Single-Use Pairing**: QR code contains a single-use one-time code (`/pair?t=<code\>`) that expires after 5 minutes and immediately invalidates upon exchange.
4. **Timing-Safe Comparison**: All token verifications must use `crypto.timingSafeEqual`.
5. **Rate Limiting & Lockout**: Failed authentication attempts must be rate-limited and locked after repeated violations.
6. **Explicit Approval by ID**: Approval requests must match the exact pending approval `id`. Never approve blind or out-of-order requests.
7. **Local Audit Logging**: Log all approve, deny, prompt, and stop actions with timestamps to a local log file. Zero telemetry or network reporting.
8. **Origin & CORS Protection**: Restrict CORS and reject unrecognized WebSocket connection origins.

---

## 6. Phased Trackable Checklist

### [x] Phase 0: Pre-check & Capability Audit
- [x] Audit whether Antigravity ships any first-party mobile/remote functionality.
- [x] Inspect Antigravity IDE surfaces, extension API availability, and agent exposure.
- [x] Document findings, API surface analysis, and integration options in [NOTES.md](file:///c:/Users/user/Desktop/Dr_OpenSource/Projects/AG-Remote/NOTES.md).
- [x] Deliver under 10-line summary and wait for user approval.

### [x] Phase 1: Feasibility Probe
- [x] Evaluate Option A (Extension API) vs Option B (CDP `--remote-debugging-port=9222`).
- [x] Build proof-of-concept script reading live chat messages from outside IDE UI.
- [x] Build proof-of-concept detecting a pending approval/permission prompt outside IDE UI.
- [x] Record chosen integration path and rationale in [NOTES.md](file:///c:/Users/user/Desktop/Dr_OpenSource/Projects/AG-Remote/NOTES.md).
- [x] Deliver under 10-line summary and wait for user approval.

### [x] Phase 2: Adapter Actions (`adapter-antigravity`)
- [x] Scaffold `adapter-antigravity` module implementing `IdeAdapter`.
- [x] Implement `sendPrompt(text)`.
- [x] Implement `approve(id)` and `deny(id)`.
- [x] Implement `stop()`.
- [x] Consolidate all DOM/CDP selectors into a single configuration/mapping file.
- [x] Create terminal test script verifying all actions (10/10 success rate).
- [x] Deliver under 10-line summary and wait for user approval.

### [x] Phase 3: Core & Local Server
- [x] Implement `core` module: state manager, approval queue, event bus.
- [x] Implement `server` module: Node `http` + `ws` server with token authentication.
- [x] Implement endpoints: `GET /pair`, `GET /api/state`, `POST /api/prompt`, `POST /api/approve`, `POST /api/deny`, `POST /api/stop`, `WS /ws`.
- [x] Implement constant-time token validation, rate-limiting, and local audit logging.
- [x] Verify via test script: authenticated requests succeed; unauthenticated return 401; WS pushes events.
- [x] Deliver under 10-line summary and wait for user approval.

### [x] Phase 4: Phone PWA
- [x] Build lightweight mobile PWA UI (clean, dark mode default, responsive for Safari & Chrome).
- [x] Implement live chat feed, prompt input, and Stop button.
- [x] Implement dedicated approval card displaying full action details, target, and 1-tap Approve/Deny buttons.
- [x] Implement WebSocket reconnection & state resynchronization (< 3 seconds on wake).
- [x] Verify PWA installability (manifest, icons, service worker).
- [x] Test end-to-end control from mobile phone browser over local network.
- [x] Deliver under 10-line summary and wait for user approval.

### [x] Phase 5: Pairing & Remote Access
- [x] Implement in-IDE QR code display showing pairing URL with short-lived token.
- [x] Implement token exchange flow (`/pair?t=...` granting persistent session token).
- [x] Verify expired or reused pairing codes are rejected.
- [x] Document Tailscale HTTPS remote pairing guide.
- [x] Test remote control over Tailscale / mobile network.
- [x] Deliver under 10-line summary and wait for user approval.

### [x] Phase 6: Packaging & Delivery
- [x] Package extension into `.vsix` bundle via `vsce` / `ovsx`.
- [x] Write user-facing [README.md](file:///c:/Users/user/Desktop/Dr_OpenSource/Projects/AG-Remote/README.md) with 5-minute setup instructions and security documentation.
- [x] Implement clear failure messages for edge cases (IDE closed, UI changed, network dropped).
- [x] Conduct fresh-install verification test on Windows 11.
- [x] Deliver final summary and project demo script.

---

## 7. Definition of Done (DoD)

- [x] All functional requirements F1–F8 and F10 operational on Windows 11.
- [x] All security requirements 1–10 strictly satisfied and tested.
- [x] New user onboarding completes in < 5 minutes using only the README.
- [x] Clean architectural boundaries: zero Antigravity-specific logic outside `adapter-antigravity`.
- [x] Resilient failure modes: UI changes or disconnects produce explicit, safe error states.
- [x] Absolutely no external telemetry or outbound tracking calls.
