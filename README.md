# AG-Remote: Phone Remote Control for Google Antigravity

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%2011%20(x64)-informational.svg)]()
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-brightgreen.svg)]()

> Walk away from your desk without your Antigravity agent stalling on a permission prompt.

**AG-Remote** lets you monitor and control your Google Antigravity coding agent directly from your phone. Send prompts, approve or deny terminal and file edits with one tap, and stop runaway generation from anywhere.

Everything runs locally on your PC. No cloud relay, no user accounts, and zero external telemetry.

---

## ⚡ Quick Start (< 5 Minutes)

### 1. Launch AG-Remote

You can run AG-Remote as a standalone background runner or as an Antigravity/VS Code extension:

#### Option A: Standalone Runner (Quickest)
```powershell
npm start
```
A QR code will immediately appear in your terminal.

#### Option B: Install Extension (`.vsix`)
1. In Antigravity IDE, open the Extensions view (`Ctrl+Shift+X`).
2. Click the `...` menu at the top-right -> **Install from VSIX...**.
3. Select `ag-remote-0.1.0.vsix`.
4. Click the `$(radio-tower) AG-Remote` icon in the bottom status bar to view the pairing QR code.

---

### 2. Pair Your Phone
1. Open your phone's camera and scan the QR code displayed on your PC screen.
2. The web app (PWA) will open in your browser, exchange the single-use pairing code for a secure session token, and immediately stream your live conversation.
3. **Install as App (PWA)**:
   - **iOS (Safari)**: Tap Share (`⬆️`) -> **Add to Home Screen**.
   - **Android (Chrome)**: Tap Menu (`⋮`) -> **Install app** or **Add to Home screen**.

---

## 🔒 Security Architecture (Non-Negotiable)

AG-Remote has permissions to approve terminal commands and actions on your computer. Security is built into the core:

1. **LAN-Reachable by Default (Plain HTTP)**: The server binds to `0.0.0.0` so your phone can reach it over home Wi-Fi. Every request needs a bearer token obtained via a single-use pairing PIN, but traffic on the LAN is **not encrypted**. Only use it on networks you trust. To restrict it to this PC (for example with Tailscale Serve providing HTTPS), set `agRemote.host` to `127.0.0.1`.
2. **Never Port Forward**: Never open port 49222 on your Wi-Fi router. Router port forwarding exposes your workstation to internet scanning bots.
3. **Remote Access via Tailscale (HTTPS)**: For mobile access over 4G/5G away from home, follow our [Tailscale Remote Setup Guide](docs/TAILSCALE_SETUP.md). Tailscale creates a private peer-to-peer WireGuard tunnel with automated trusted HTTPS certificates.
4. **Single-Use Cryptographic Pairing**: Every QR code contains a 128-bit single-use code that expires after **5 minutes** and is invalidated immediately upon exchange.
5. **Constant-Time Verification**: All token verifications use `crypto.timingSafeEqual` to prevent timing attacks.
6. **Failed Attempt Rate-Limiting**: Repeated failed authorization attempts result in automatic client lockout.
7. **Local Audit Logging**: Every prompt, approval, denial, and stop action is logged locally to `.logs/audit.log` with timestamps. Zero telemetry or network reporting.
8. **Instant Token Revocation**: If you misplace your phone, run `Antigravity Remote: Revoke All Pairings` in the IDE to invalidate all active session tokens immediately.

---

## 📱 Mobile Features

| Feature | Description |
| :--- | :--- |
| **Live Chat Stream** | Real-time chat feed of agent thinking and outputs with auto-scroll. |
| **1-Tap Approval** | Prominent approval cards displaying the exact command or affected files, with large `Approve` and `Deny` buttons. |
| **Send Prompts** | Clean mobile input box with multiline support and Enter-to-send. |
| **Emergency Stop** | Instant `Stop` button to halt agent generation immediately. |
| **Instant Sleep/Wake Resync** | Resyncs session state in < 1 second when unlocking your phone. |
| **Dark Mode Default** | Premium dark aesthetic tailored for OLED mobile displays. |

---

## 🛠️ Testing & Verification

Run the automated test suite across all subsystems:

```powershell
# Run complete test suite (Adapter, Server, PWA, Pairing)
npm test

# Run individual subsystems
npm run test:adapter    # 10/10 reliability & security invariant tests
npm run test:server     # HTTP REST & WebSocket push event tests
npm run test:pwa        # PWA delivery & mobile lifecycle tests
npm run test:pairing    # QR encoding & token revocation tests
```

---

## ❓ Troubleshooting & Edge Cases

- **"Antigravity IDE process or session not found"**: Ensure Antigravity IDE is open with an active workspace.
- **"Antigravity UI changed, update the extension"**: If Google updates Antigravity's internal selectors, update [src/adapter-antigravity/config.ts](src/adapter-antigravity/config.ts).
- **Phone shows "Disconnected / Offline"**: Check if your phone is on the same local Wi-Fi or if your Tailscale app is active.

---

## 📜 License

[MIT License](LICENSE) © AG-Remote Authors
