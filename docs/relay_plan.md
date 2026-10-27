# v0.2 Plan: Hosted Relay (use AG-Remote from any network)

**Status:** planned 2026-10-27, not started. Owner agreed it is worth building. Branch to use: `feat/relay`.
**Goal:** any AG-Remote user scans the QR in the extension and gets an HTTPS phone page that works on any connection (mobile data, other Wi-Fi), without being on the laptop's network. Hosted by the owner on Cloudflare under the owner's domain **taqnik.in** (Cloudflare manages DNS).

This is the "paid release" track, separate from the personal tool. Direct Wi-Fi mode (today's local server) stays as the private, free option and must keep working.

## Architecture

```
User's laptop (extension) ──outbound WSS──┐
                                          ├─ relay.taqnik.in (Cloudflare Worker + Durable Object, one room per laptop)
User's phone (any network) ──── HTTPS ────┘
```

- **Relay:** a Cloudflare Worker serves the phone page (static assets) and routes `/ws/<room>` to a Durable Object per paired laptop. The DO holds the laptop and phone sockets and forwards messages. Use WebSocket hibernation so idle rooms cost almost nothing. Deployed with `npx wrangler` (the owner logs in to Wrangler and approves DNS changes).
- **Extension transport:** a second transport beside `src/server/` that dials the relay outbound and speaks the same JSON messages the phone uses today, so `SessionManager`, multi-window tabs and approvals are reused unchanged. Setting: relay / Wi-Fi / both.
- **Pairing:** the QR opens `https://relay.taqnik.in/p/<room>#<key>`. The `#fragment` never reaches the server. This replaces the 6-digit PIN for relay mode. Paired phones can be revoked from the IDE.
- **End-to-end encryption (required):** phone and extension encrypt every message with the pairing key (WebCrypto, AES-GCM; consider an ECDH exchange so the QR secret is only used once). The relay sees ciphertext only and cannot read code or prompts or approve commands. Without this, a relay bug or breach = remote command execution on users' laptops.
- **Push notifications (later):** HTTPS allows Web Push ("Antigravity needs approval") while the phone is locked. The push carries no content.

## Risks and open questions

- **Served page is a trust point:** even with E2E, whoever controls the relay ships the page JS. Say so in the privacy note; later option: version pinning.
- **Unofficial IDE API:** everything uses Antigravity's undocumented language-server RPCs (D-4). Updates can break it, which means support load for other users. Check Google's terms for automating Antigravity before a public release.
- **Operating a service:** uptime, abuse limits (rate limits, unguessable room ids), privacy policy, cost. Check current Cloudflare Workers/Durable Objects free-tier limits vs the $5/month plan before choosing.
- Subdomain name (`relay.` assumed) to confirm with the owner.

## Phases

1. **Relay skeleton:** Worker + Durable Object passing messages between two test clients, deployed to `relay.taqnik.in` via Wrangler (owner logs in and approves DNS).
2. **E2E encryption + QR pairing**, with tests proving the relay never sees plaintext.
3. **Extension relay transport** + transport setting; direct Wi-Fi unchanged.
4. **Live test** from the owner's phone over mobile data (numbered steps + pass/fail table).
5. **Public-release prep:** privacy note, limits, push notifications. Scope depends on how public the owner wants to go.

Rejected for this goal: a per-user Cloudflare Tunnel or Tailscale (each user would have to set up their own; fine for personal use, see docs/TAILSCALE_SETUP.md).
