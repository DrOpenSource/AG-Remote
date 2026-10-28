# Roadmap

Antigravity Remote is free and open source (MIT), and it stays that way. Every item below fits two rules:

1. **No cost to users.** No account, no subscription, no paid tier for anything listed here.
2. **No running cost for the project.** Everything runs on the user's own PC and phone, or on the relay inside Cloudflare's free tier. Nothing here needs a paid server, a paid API or a store fee.

Items marked 💡 at the end are ideas that *would* cost money to run. They are not planned; they are only noted as possible future work.

Last updated: 2026-10-28 (after 0.2.2). Each item is split into its own version, with tests written first and a release gate, in the [release plan](RELEASE_PLAN.md).

---

## Where we stand

Compared with the other Antigravity phone remotes on Open VSX, Antigravity Remote is the only one that is end-to-end encrypted through a relay that can't read your messages, works on any network, **and** doesn't need Antigravity relaunched with a debug flag. It also has the fullest approval controls (approve, deny with a note, allow for the whole conversation, answer the agent's questions).

What others have that we don't yet: voice input, file types beyond images, a view of the code the agent changed, Git from the phone, a local API, and other languages. The plan below closes those gaps, in order of value for effort.

---

## 0.3: Finish and polish what's there

| Item | Why | How (free) |
|---|---|---|
| **Confirm image attachments with the agent** | Built in 0.2.0 but not yet confirmed that the agent sees the image. | Live test. If inline images are ignored, try the `media` field, then add a setting to always send them as saved files. |
| **Voice input** | Fastest way to prompt from a phone; one competitor has it. | The phone browser's own speech recognition (Web Speech API). Needs HTTPS, so it works in relay mode and over Tailscale; the mic button is hidden on plain-HTTP Wi-Fi mode. |
| **Any file, not just images** | PDFs, logs, text and code files. | Same save-to-workspace path the image fallback uses (`.ag-remote/uploads/`), with the path added to the prompt. |
| **Readable replies** | Code blocks, lists and headings currently show as raw text. | A small built-in Markdown renderer (no CDN, no new dependency). |
| **Listing and repo polish** | We have 104 downloads next to a 67k competitor. | Screenshots and a short demo GIF in the README, a clear listing description, `CONTRIBUTING.md`, `SECURITY.md`, issue templates. |

## 0.4: See and steer the work

| Item | Why | How (free) |
|---|---|---|
| **What the agent changed** | You approve edits without seeing them. | Show the diff from the agent's own steps in the approval card and in a "Changes" list (read-only). |
| **Safe auto-approve** | Auto-accept is the most-installed category around Antigravity, but blind auto-accept is risky. | Opt-in rules on the PC: e.g. always allow read-only commands or `npm test`, always ask for anything else. Every auto-approval goes to the audit log and shows on the phone. |
| **Conversation history and search** | Find and resume an older chat from the phone. | Uses the IDE's own conversation list we already read. |
| **Git basics** | Check status and commit when the agent is done. | VS Code's built-in Git extension API; commit and push always ask for confirmation on the phone. |
| **Model and mode per conversation** | Switch model or planning mode without the PC. | Reuse the conversation's own config the bridge already reads. |

## 0.5: Reach

| Item | Why | How (free) |
|---|---|---|
| **Other languages** | Several competitors ship 4 to 16 languages. | Plain JSON string files in the phone app; community translations through pull requests. |
| **Local API / MCP server** | Lets scripts and other agents drive Antigravity, as two competitors offer. | Loopback-only, using the same token the phone uses. |
| **Run your own relay** | Users who don't want any shared relay, and a safety valve for the free tier. | The `agRemote.relayUrl` setting already exists; add a one-command deploy guide for the user's own free Cloudflare account. |
| **Tablet and desktop-browser layout** | Use a tablet or a second computer as the remote. | Responsive layout in the existing phone app. |
| **Quiet hours and per-phone alerts** | Fewer notifications at night or on a second device. | Settings stored on the PC; Web Push stays free. |
| **Windsurf support (investigate)** | Windsurf's agent appears to use the same language server, which could reach a second, larger audience. | Same bridge; needs a feasibility check first. |

## Not planned

- **"New chat" from the phone:** chats started this way don't appear in Antigravity's Agent panel (decision D-5 in NOTES.md). Revisit only if Antigravity offers a supported way.
- **Clicking IDE buttons through the debug protocol:** fragile, needs a relaunch flag, and the language-server route is more reliable.
- **A full remote terminal:** needs native binaries per platform and widens what a lost phone could do. The agent's own command output is already visible.

---

## Keeping running costs at zero

The only shared infrastructure is the relay at `remote.taqnik.in` (a Cloudflare Worker with Durable Objects on the free plan). To stay inside the free tier as usage grows:

- Keep message size and rate limits per room (already in place) and use WebSocket hibernation so idle phones cost nothing.
- Check the Cloudflare usage dashboard monthly. If usage nears the free limits, point heavy users to Wi-Fi mode or their own relay rather than paying for capacity.
- Never add a database, file storage or server-side processing that the free tier doesn't cover. Images and files go phone → PC end-to-end and are never stored on the relay.

---

## 💡 Paid opportunities (future work, not planned)

These would need money to run or publish, so they are outside the free core. They are listed only so the option is on record.

- **Native iPhone and Android apps.** More reliable background notifications and a store presence (ZeroG ships an iPhone app). Costs the Apple Developer fee ($99/year) and Google Play's one-time $25. The free web app would stay.
- **Team sessions.** Share a live agent session with teammates (CodeAgent offers this). Needs accounts and server-side state, so it needs paid hosting.
- **Higher-capacity relay.** If the free tier ever becomes the bottleneck, a paid relay plan could serve heavy users while everyone else stays on the free tier or Wi-Fi mode.
- **Sponsorship.** GitHub Sponsors costs nothing to set up and could cover the items above without charging users.
