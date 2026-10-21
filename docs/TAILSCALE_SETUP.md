# Remote Pairing via Tailscale (Zero-Port Exposure)

AG-Remote is designed with a **local-first, security-hardened architecture**. The extension binds to `0.0.0.0` by default (set `agRemote.host` to `127.0.0.1` when fronting it with Tailscale Serve) and **never** requires router port forwarding or public cloud relays.

To access your Antigravity agent from your phone over mobile data (LTE/5G) or outside your home Wi-Fi, use **Tailscale**.

---

## Why Tailscale?
- **End-to-End Encryption**: Direct peer-to-peer WireGuard tunnel between your phone and your PC.
- **Zero Exposed Ports**: Your computer is never reachable by bots or the public internet.
- **Trusted HTTPS Certificates**: Tailscale automatically generates real HTTPS certificates for your machine (required for mobile PWA install and push notifications).
- **Free for Personal Use**: No recurring costs.

---

## 3-Minute Setup Guide

### Step 1: Install Tailscale on your PC & Phone
1. **On your Windows PC**: Download and install Tailscale from [tailscale.com](https://tailscale.com). Log in with your preferred account.
2. **On your Phone**: Install the Tailscale app from the Apple App Store or Google Play Store. Sign in with the same account.

---

### Step 2: Enable Tailscale Serve (HTTPS) on your PC

Open PowerShell on your PC and run:
```powershell
tailscale serve --bg 49222
```

This commands Tailscale to route encrypted traffic from your phone directly to AG-Remote with a valid HTTPS certificate (e.g., `https://my-pc.tailnet-name.ts.net`).

> [!TIP]
> You can check your Tailscale domain anytime by running:
> ```powershell
> tailscale status
> ```

---

### Step 3: Pair from your Phone

1. In Antigravity IDE, click the **AG-Remote** icon in the status bar or run the command:
   ```
   Antigravity Remote: Show Pairing QR Code
   ```
2. On your phone, open your camera and scan the QR code displayed on your monitor.
3. The browser will open the pairing link (`https://<your-machine>.ts.net/pair?t=<one-time-code>`), exchange the single-use code for a persistent session token, and immediately load your live agent chat.
4. **Install as PWA**:
   - **iOS (Safari)**: Tap the Share button -> **Add to Home Screen**.
   - **Android (Chrome)**: Tap the menu (three dots) -> **Install app** or **Add to Home screen**.

---

## Security Invariants

- **Single-Use Pairing**: Each QR code contains a one-time cryptographic code that expires in **5 minutes** and is permanently invalidated upon exchange.
- **Token Storage**: The session token is stored exclusively in your phone's browser `localStorage` and sent over HTTPS.
- **Revoking Pairing**: If you ever misplace your phone or wish to disconnect, run `Antigravity Remote: Revoke All Pairings` in the IDE to immediately invalidate all tokens and drop active connections.
- **⚠️ Port Forwarding Warning**: **NEVER** forward port 49222 on your home Wi-Fi router. Exposing agent control to the public internet without an authenticated WireGuard tunnel is unsafe.
