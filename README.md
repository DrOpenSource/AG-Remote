# AG-Remote: Phone Remote Control for Google Antigravity

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%2011%20(x64)-informational.svg)]()
[![Zero Runtime Dependencies](https://img.shields.io/badge/Dependencies-Zero-brightgreen.svg)]()

> Walk away from your desk without your Antigravity agent stalling on a permission prompt.

**AG-Remote** transforms your phone into an out-of-band asynchronous control plane for Google Antigravity. Send prompts, approve terminal commands and file edits with one tap, stop runaway generation, and switch between IDE workspace windows from anywhere.

Works out of the box on **any network** (cellular mobile data, remote Wi-Fi, or home LAN) with zero cloud accounts and strict **End-to-End Encryption** (WebCrypto P-256 ECDH + AES-256-GCM).

---

## ⚡ Quick Start (< 2 Minutes)

### 1. Install & Launch AG-Remote

Install the extension directly in Google Antigravity IDE:
1. Open the Extensions view (`Ctrl+Shift+X`).
2. Click the `...` menu at the top-right -> **Install from VSIX...**.
3. Select `ag-remote-0.2.0.vsix`. If you installed 0.1.0 before, uninstall it first (its publisher was `ag-remote`, now `dr-opensource`); your paired phones stay paired.
4. Click the `$(radio-tower) AG-Remote` icon in the bottom status bar (or press `Ctrl+Shift+P` -> `Antigravity Remote: Show Pairing QR Code`).

*(Alternative: Run standalone in your terminal with `npm start`)*.

---

### 2. Pair Your Phone

1. Open your phone's camera and scan the QR code displayed on your PC screen.
2. The web app (PWA) opens instantly in your browser:
   - **Relay Mode (Any Network / Cellular Data)**: Pairs automatically via the URL `#fragment` secret; session keys are derived on-device with zero plaintext exposed to the relay.
   - **Wi-Fi Mode (Local LAN)**: If on the same Wi-Fi, you can also enter the 6-digit PIN displayed on your PC screen.
3. **Install as App (PWA)**:
   - **iOS (Safari)**: Tap Share (`⬆️`) -> **Add to Home Screen**.
   - **Android (Chrome)**: Tap Menu (`⋮`) -> **Install app** or **Add to Home screen**.

---

## 🔒 Security Architecture (Non-Negotiable)

AG-Remote has permissions to approve terminal commands and file modifications. Security is designed into the core:

1. **End-to-End Encryption (Relay Mode)**: When using the hosted relay (`remote.taqnik.in`), all traffic is encrypted on-device with AES-256-GCM and P-256 ECDH keys. The relay only forwards scrambled ciphertext frames and cannot read prompts, inspect code, or approve commands.
2. **Single-Use Ephemeral Secrets**: Every pairing QR code contains a 256-bit cryptographically random secret in the URL fragment (`#secret`) that never reaches the server, valid for 5 minutes only.
3. **Loopback-Only Visual Pairing (`/pair/view`)**: The visual pairing screen is strictly locked to loopback callers (`127.0.0.1` / `::1`) with origin filtering, preventing anyone on the same Wi-Fi network from generating pairing PINs.
4. **Local Wi-Fi Security**: When direct Wi-Fi mode is active, the server binds to `0.0.0.0` with token authentication. Traffic on unencrypted LANs is plain HTTP; to restrict the local server to this PC, set `agRemote.host` to `127.0.0.1` (recommended when using Tailscale Serve for HTTPS).
5. **Never Port Forward**: Never open port 49222 on your home or office router. Use the built-in encrypted relay or [Tailscale HTTPS Setup](docs/TAILSCALE_SETUP.md) for remote access.
6. **Constant-Time Verification**: All internal tokens are validated using `crypto.timingSafeEqual` to eliminate timing side-channels.
7. **Rate Limiting & Lockout**: Failed authentication attempts trigger automatic IP rate-limiting and temporary client lockouts.
8. **Local Audit Logging**: Every prompt, approval (`Allow Once`, `Always Allow`), denial, and stop action is logged locally with timestamps. Zero telemetry or network tracking.
9. **Instant Token Revocation**: Run `Antigravity Remote: Revoke All Pairings` or `Manage Paired Phones` from the command palette to disconnect paired devices immediately.

---

## 📱 Mobile Features

| Feature | Description |
| :--- | :--- |
| **Live Chat Stream** | Real-time chat feed of agent thoughts, steps, and outputs with auto-scroll. |
| **Full-Fidelity Approvals** | 1-tap `Allow Once`, `Always Allow`, and `Deny with Feedback` for commands and file edits. |
| **Interactive Questions** | Responsive cards for `ask_question` options and write-in clarification replies. |
| **Multi-Window Switcher** | One tab per active IDE window with real-time focus badges and seamless host failover. |
| **Push Notifications** | Web Push alerts when the agent is waiting for approval or completes while your phone is locked. |
| **Send Prompts & Stop** | Mobile composer with Enter-to-send and an instant emergency `Stop` button. |
| **Screenshot Attachments** | Attach up to 4 photos or screenshots to a prompt; they are compressed on the phone and sent end-to-end encrypted. |
| **Instant Sleep/Wake Resync** | Resyncs live session state in < 1 second upon unlocking your phone. |
| **OLED Dark Mode** | Premium Material 3 dark aesthetic tailored for mobile displays. |

---

## ⚙️ Extension Settings

| Setting | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| `agRemote.transport` | `string` | `"both"` | Connection mode: `"both"` (Relay + Wi-Fi PIN), `"wifi"` (local Wi-Fi only), or `"relay"` (relay only, local server bound to 127.0.0.1). |
| `agRemote.relayUrl` | `string` | `"https://remote.taqnik.in"` | Hosted relay endpoint for any-network mobile access. |
| `agRemote.port` | `number` | `49222` | Port on which the local hub server listens. |
| `agRemote.host` | `string` | `"0.0.0.0"` | Host binding address (`0.0.0.0` for Wi-Fi/Tailscale, `127.0.0.1` for local-only). |

---

## ⌨️ Contributed Commands

- `Antigravity Remote: Show Pairing QR Code` (`ag-remote.showPairingQr`)
- `Antigravity Remote: Manage Paired Phones` (`ag-remote.managePhones`)
- `Antigravity Remote: Revoke All Pairings` (`ag-remote.revokePairings`)
- `Antigravity Remote: Restart Server` (`ag-remote.restartServer`)

---

## 🛠️ Testing & Verification

Run the comprehensive test suite across all subsystems:

```powershell
# Run full automated test suite (11 test suites)
npm test

# Build extension and CLI bundles
npm run build

# Package production VSIX
npm run package
```

---

## 📜 License

[MIT License](LICENSE) © Dr. OpenSource
