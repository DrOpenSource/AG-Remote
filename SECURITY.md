# Security Policy & Cryptographic Architecture

Antigravity Remote (`ag-remote`) enables developers to monitor, steer, and approve actions executed by Google Antigravity coding agents directly from a mobile device. Because this includes approving terminal commands and file edits, **security and cryptographic integrity are core non-negotiable architectural requirements**.

---

## 1. Reporting a Vulnerability

We take the security of Antigravity Remote seriously. If you discover a security vulnerability, we appreciate your help in disclosing it to us responsibly.

### How to Report

- **Primary (Recommended)**: Use [GitHub Private Vulnerability Reporting](https://github.com/DrOpenSource/AG-Remote/security/advisories/new) to submit an advisory draft directly within the repository.
- **Direct Contact**: If you cannot use GitHub Security Advisories, email the author directly at [imkashyaps@gmail.com](mailto:imkashyaps@gmail.com) with the subject `[SECURITY VULNERABILITY] ag-remote`.

Please **do not** report security vulnerabilities through public GitHub issues, public discussions, or social channels.

### What to Include

To help us triage and resolve the issue quickly, please provide:
1. A clear description of the vulnerability and its potential impact.
2. Step-by-step instructions to reproduce the issue (proof-of-concept script, packet capture, or payload sample).
3. The component affected (`relay`, `pwa`, `adapter-antigravity`, `server`, or `extension`).
4. Any proposed remediations or mitigations if you have them.

### Response Timeline (SLA)

- **Initial Response**: Within 48 hours of receipt.
- **Triage & Assessment**: Within 5 business days.
- **Patch & Advisory Release**: Coordinated with the reporter before public disclosure.

---

## 2. Supported Versions

Security updates and patches are actively applied to the latest minor version line:

| Version | Supported |
| :--- | :---: |
| `0.3.x` | :white_check_mark: |
| `< 0.3.0` | :x: |

---

## 3. Cryptographic Architecture & Threat Model

Antigravity Remote is designed so that **no sensitive workspace data, prompts, or code ever transit an untrusted third party in plaintext**.

```
+-------------------------------------------------------------------------------+
|                                 DESKTOP HOST                                  |
|                                                                               |
|  [Antigravity IDE] <--(Loopback / IPC)--> [ag-remote Extension / Hub]         |
|                                                 |                             |
|                                         AES-256-GCM Encrypted                 |
+-------------------------------------------------|-----------------------------+
                                                  |
                                                  v
                               +-------------------------------------+
                               | Cloudflare Workers / Durable Object |
                               |       Relay (Blind Router)          |
                               |    * Zero Knowledge of Keys         |
                               |    * Sees only Ephemeral Room ID    |
                               +-------------------------------------+
                                                  |
                                         AES-256-GCM Encrypted
                                                  |
+-------------------------------------------------v-----------------------------+
|                                  MOBILE CLIENT                                |
|                                                                               |
|  [Mobile Web App / PWA] <--(Local WebCrypto Decryption)--> [Mobile Screen]   |
+-------------------------------------------------------------------------------+
```

### A. End-to-End Encryption (E2EE)
- **Key Agreement**: Session keys are derived via standard WebCrypto `ECDH` using the NIST P-256 curve (`secp256r1`).
- **Authenticated Cipher**: All application payloads, chat messages, approval requests, and image attachments are encrypted with `AES-256-GCM` using unique 96-bit initialization vectors (IVs) per frame.
- **Zero-Knowledge Blind Relay**: The public relay hosted at `remote.taqnik.in` (backed by Cloudflare Workers and Durable Objects) functions purely as a message router. The relay never receives private keys, pre-shared secrets, or plaintext payloads.

### B. Single-Use Ephemeral Secrets & QR Code Pairing
- **URL Fragment (`#secret`)**: When scanning a pairing QR code, the 256-bit pairing secret is passed in the URL fragment (`#secret=<hex>`). Per RFC 3986, URL fragments are processed strictly by the client-side browser and are **never transmitted to the relay or HTTP server in request headers**.
- **Ephemeral Expiration**: Pairing secrets expire automatically after 5 minutes if unused.
- **Rate-Limited Short Codes**: For manual entry, 6-character pairing codes expire after 5 minutes and are strictly rate-limited to 10 lookups per minute per IP.

### C. Manual Out-of-Band Verification Gate
- Scanning a QR code or entering a pairing PIN **does not grant immediate access**.
- The desktop IDE displays a distinct **4-digit verification check code**.
- The pairing is only finalized when the user actively reviews and confirms the matching 4-digit code on their PC by clicking **Allow**.

### D. Loopback Isolation
- The visual pairing interface (`/pair/view`) is strictly restricted to loopback connections (`127.0.0.1` and `::1`).
- Callers from non-loopback origins receive an immediate `403 Forbidden` response.

### E. Timing Attack Resistance
- All security-sensitive tokens, pairing secrets, and authentication digests are compared using `crypto.timingSafeEqual` in Node.js to eliminate timing side-channel leaks.

### F. Transport Options & LAN Wi-Fi Advisory
- **Relay Mode (Default & Recommended)**: Local server binds to `127.0.0.1`. All remote traffic routes through E2EE relay tunnels. Safe for public Wi-Fi and mobile cellular networks.
- **Wi-Fi Mode (Direct LAN, Opt-In)**: Binds to `0.0.0.0:49222` with token authentication over plain HTTP.
  > [!WARNING]
  > Direct Wi-Fi mode transmits data over unencrypted local HTTP. Do **not** use direct Wi-Fi mode on untrusted or public networks. For private self-hosted connections without the public relay, we recommend routing through [Tailscale Serve with HTTPS](docs/TAILSCALE_SETUP.md).

### G. Local Audit Trail & Instant Revocation
- **Zero Remote Telemetry**: Antigravity Remote collects zero remote analytics, tracking pixels, or diagnostic telemetry.
- **Local Audit Log**: All approvals, denials, prompts, and session activations are recorded locally in a human-readable audit log.
- **Instant Revocation**: Running `Antigravity Remote: Revoke All Pairings` instantly invalidates all paired device tokens and drops active WebSocket connections.

---

## 4. Security Audit Status

> [!NOTE]
> The cryptographic implementation is built entirely on native WebCrypto APIs and standard Node.js `crypto` primitives, following modern best practices (P-256 ECDH, AES-256-GCM, timing-safe equality, loopback isolation).
> 
> **It has not yet undergone formal external third-party security audit.** Independent security reviews, penetration testing reports, and feedback from the security community are welcomed.

