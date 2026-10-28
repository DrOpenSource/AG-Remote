# Antigravity Remote: Phone Remote Control for Google Antigravity

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Open VSX](https://img.shields.io/open-vsx/v/dr-opensource/ag-remote?label=Open%20VSX)](https://open-vsx.org/extension/dr-opensource/ag-remote)
[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/dr-opensource.ag-remote?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=dr-opensource.ag-remote)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-informational.svg)]()

> Walk away from your desk without your Antigravity agent stalling on a permission prompt.

**Antigravity Remote** turns your phone into a remote for the Google Antigravity agent. Approve or deny commands and file edits, send prompts and screenshots, stop a run, get notified when the agent needs you, and switch between project windows, from anywhere.

- **Any network** (mobile data, someone else's Wi-Fi, or your home LAN), with no account and nothing to set up.
- **End-to-end encrypted** (WebCrypto P-256 ECDH + AES-256-GCM). The relay forwards messages it cannot read.
- **No debug flag.** You don't relaunch Antigravity with `--remote-debugging-port`; it talks to the agent the same way Antigravity's own panel does.
- **Free and open source** (MIT). Windows, macOS and Linux. See the [roadmap](docs/ROADMAP.md).

---

## ⚡ Quick Start (< 2 Minutes)

### 1. Install

In Antigravity, open Extensions (`Ctrl+Shift+X` / `Cmd+Shift+X`), search **Antigravity Remote** (publisher **dr-opensource**) and install. It is on [Open VSX](https://open-vsx.org/extension/dr-opensource/ag-remote) and the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=dr-opensource.ag-remote); a `.vsix` is attached to each [GitHub release](https://github.com/DrOpenSource/AG-Remote/releases).

Then click **AG-Remote** in the status bar, or run `Antigravity Remote: Show Pairing QR Code` from the Command Palette.

If you installed 0.1.0 (publisher `ag-remote`), uninstall it first; your paired phones stay paired.

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
- `Antigravity Remote: Copy Diagnostics` (`ag-remote.diagnostics`): copies a report (no tokens) when the phone shows no conversation

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

## 🤝 Contributing

Bug reports and ideas are welcome in [Issues](https://github.com/DrOpenSource/AG-Remote/issues). If the phone connects but shows no conversation, run `Antigravity Remote: Copy Diagnostics` and paste the report (it contains no tokens or chat titles). See the [roadmap](docs/ROADMAP.md) for what's planned.

---

## 📜 License

[MIT License](LICENSE) © Dr. OpenSource
