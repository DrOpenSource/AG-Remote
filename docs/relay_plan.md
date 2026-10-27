# v0.2 Plan: Hosted Relay (use AG-Remote from any network)

**Status:** planned 2026-10-27, not started. Owner agreed it is worth building. Branch to use: `feat/relay`.
**Goal:** any AG-Remote user scans the QR in the extension and gets an HTTPS phone page that works on any connection (mobile data, other Wi-Fi), without being on the laptop's network. Hosted by the owner on Cloudflare under the owner's domain **taqnik.in** (Cloudflare manages DNS).

This is the "paid release" track, separate from the personal tool. Direct Wi-Fi mode (today's local server) stays as the private, free option and must keep working.

## Architecture

```
User's laptop (extension) ──outbound WSS──┐
                                          ├─ remote.taqnik.in (Cloudflare Worker + Durable Object, one room per laptop)
User's phone (any network) ──── HTTPS ────┘
```

- **Relay:** a Cloudflare Worker serves the phone page (static assets) and routes `/ws/<room>` to a Durable Object per paired laptop. The DO holds the laptop and phone sockets and forwards messages. Use WebSocket hibernation so idle rooms cost almost nothing. Deployed with `npx wrangler` (the owner logs in to Wrangler and approves DNS changes).
- **Extension transport:** a second transport beside `src/server/` that dials the relay outbound and speaks the same JSON messages the phone uses today, so `SessionManager`, multi-window tabs and approvals are reused unchanged. Setting: relay / Wi-Fi / both.
- **Pairing:** the QR opens `https://remote.taqnik.in/p/<room>#<key>`. The `#fragment` never reaches the server. This replaces the 6-digit PIN for relay mode. Paired phones can be revoked from the IDE.
- **End-to-end encryption (required):** phone and extension encrypt every message with the pairing key (WebCrypto, AES-GCM; consider an ECDH exchange so the QR secret is only used once). The relay sees ciphertext only and cannot read code or prompts or approve commands. Without this, a relay bug or breach = remote command execution on users' laptops.
- **Push notifications (later):** HTTPS allows Web Push ("Antigravity needs approval") while the phone is locked. The push carries no content.

## Risks and open questions

- **Served page is a trust point:** even with E2E, whoever controls the relay ships the page JS. Say so in the privacy note; later option: version pinning.
- **Unofficial IDE API:** everything uses Antigravity's undocumented language-server RPCs (D-4). Updates can break it, which means support load for other users. Check Google's terms for automating Antigravity before a public release.
- **Operating a service:** uptime, abuse limits (rate limits, unguessable room ids), privacy policy, cost. Check current Cloudflare Workers/Durable Objects free-tier limits vs the $5/month plan before choosing.
- Subdomain: `remote.taqnik.in` (confirmed by the owner 2026-10-27).

## Phases

1. **Relay skeleton:** Worker + Durable Object passing messages between two test clients, deployed to `remote.taqnik.in` via Wrangler (owner logs in and approves DNS). **Done 2026-10-27.**
2. **E2E encryption + QR pairing**, with tests proving the relay never sees plaintext. Design below. **Built 2026-10-27:** `src/e2e/e2e.js` (`HostE2E`, `PhoneE2E`, `MemoryPhoneRegistry`), relay addressing in `relay/src/room.ts`; `npm run test:e2e` 41/41, `cd relay; npm test` 37/37 locally. Relay redeploy pending the owner's OK.
3. **Extension relay transport** + transport setting; direct Wi-Fi unchanged. Includes serving the phone page at `/p/<room>` and the RPC tunnel below.
4. **Live test** from the owner's phone over mobile data (numbered steps + pass/fail table).
5. **Public-release prep:** privacy note, limits, push notifications. Scope depends on how public the owner wants to go.

## Phase 2 design: E2E encryption + pairing (drafted 2026-10-27)

**Constraints:** WebCrypto only (built into Node 24, browsers and Workers), so no new dependencies. One shared module `src/e2e/` runs unchanged in the extension (Node) and the phone page (browser). P-256 ECDH rather than X25519, because P-256 works in every phone browser's WebCrypto.

**Keys and state**
- *Laptop (host):* a long-term ECDH key pair, the room id, and a list of paired phones (public key, name, paired-at). Stored in `dataDir()` beside `session.token`, mode 0600, shared by all IDE windows.
- *Phone:* its own long-term ECDH key pair, generated in the browser as **non-extractable** (page JS can use it but can't read it out), stored in IndexedDB with the room id and the laptop's public key.

**Pairing (replaces the PIN in relay mode)**
1. The extension makes a one-time pairing secret (32 random bytes, valid 5 minutes, single use) and shows the QR `https://remote.taqnik.in/p/<room>#<secret>`. The `#secret` part never reaches the relay.
2. The phone sends its public key plus `HMAC(secret, "pair" ‖ phonePub)`.
3. The laptop checks the HMAC, saves the phone, burns the secret, and replies with its own public key plus `HMAC(secret, "paired" ‖ hostPub ‖ phonePub)`. The phone checks that.
4. Both sides now hold each other's public keys, proven by a secret the relay never saw, so the relay can't slip in its own keys (no man-in-the-middle).

**Each connection (handshake)**
- Both sides send a fresh throwaway (ephemeral) key. Session keys = HKDF(ECDH(long-term keys) ‖ ECDH(throwaway keys), salt = both throwaway public keys). The long-term part proves who is talking; the throwaway part means a later key leak can't decrypt recorded traffic (forward secrecy).
- One key per direction. AES-256-GCM with a counter as the nonce; the receiver rejects any counter that isn't higher than the last, which blocks replays and reordering. Room id and direction are bound in as associated data.
- An unknown or revoked phone key fails the handshake.

**Relay change (small):** the relay starts addressing messages. Phone → laptop messages get the sender's connection id stamped on them (`{"from":id,"d":…}`). The laptop can send to one phone (`{"to":id,"d":…}`), since each phone has its own keys. The relay still can't read `d`.

**Revoking:** the extension removes the phone from its list and closes that phone's session; the relay is not involved. "Revoke all" also rotates the room id.

**Phase 2 tests (headless, Node):** pairing and handshake through `wrangler dev`; a recording relay asserts that no plaintext ever appears in any forwarded frame; a wrong, expired or reused secret is rejected; tampered and replayed ciphertext is rejected; a revoked phone can't reconnect; two phones get separate keys.

**Built as designed, plus:** the module is plain JS (the phone page has no build step); the relay accepts text frames only (binary closes with 4005); the host gets a 4x higher rate limit (800 messages per 10 s, one copy per phone); the host may send to a phone as soon as its own half of the handshake is done (the phone confirms one round trip later; only the real phone can derive the keys). The pairing URL is 93 chars and fits a 41x41 QR from the existing `src/pairing/qr.ts`.

**Phase 3 (for context):** the phone page sends its REST calls (`/api/state`, `/api/approve`, …, 9 routes) as encrypted `req`/`res` messages, and WebSocket events as `evt`. The extension answers them with the same handlers the local server uses, so `SessionManager` is untouched.

**Honest caveat:** this is a small custom protocol on standard pieces (ECDH, HKDF, AES-GCM, HMAC), shaped like the Noise "KK" pattern. It should get an outside review before a public paid release (Phase 5).

Rejected for this goal: a per-user Cloudflare Tunnel or Tailscale (each user would have to set up their own; fine for personal use, see docs/TAILSCALE_SETUP.md).
