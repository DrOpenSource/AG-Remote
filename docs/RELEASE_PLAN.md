# Release Plan

How each item in the [roadmap](ROADMAP.md) gets built, tested and shipped, one small version at a time.

**Rules for every version**

1. **Tests first.** Write the tests for a feature before the feature. They fail at first; the feature is done when they pass.
2. **Test before building the release.** The full automated suite passes on Windows, macOS and Linux before a VSIX is built.
3. **Test the build before releasing it.** The exact VSIX that will be published is installed in Antigravity and checked by hand on real phones.
4. **Free stays free.** No new paid service, no running cost. New dev-only tools are fine if free; ask before adding any dependency.

**How to track:** each to-do has an ID like `0.3.0-T2`. Tick the box in the commit that completes it, and mention the ID in the commit message. `T` = test written first, `B` = build, `V` = verify, `R` = release. 👤 marks steps only the owner can do (publishing, deploying, store logins).

---

## The release gate (applies to every version)

A version may not be released until every box here is ticked for it. Copy this list into the version's section when starting it.

**Before building the VSIX**
- [ ] All new tests were committed before (or with) the code they test, and failed without it.
- [ ] `npm test` passes locally.
- [ ] CI passes on Windows, macOS and Linux (from 0.2.3 on).
- [ ] `relay` tests pass if anything under `relay/` or `src/pwa/` changed.
- [ ] No new runtime dependency; any new dev dependency was approved.

**Build**
- [ ] Version bumped in `package.json`; `CHANGELOG.md` entry written for users (what changed, not how).
- [ ] `npm run package` builds the VSIX with no warnings; size noted (budget: stays under 150 KB download unless agreed).
- [ ] VSIX contents checked: icon, `dist/extension.cjs`, `dist/pwa/*`, no source maps, notes or tests.

**Verify the built VSIX (manual, real devices)**
- [ ] Install the VSIX in Antigravity on Windows (owner) and macOS (friend), reload windows.
- [ ] Core regression checklist below passes on Android and iPhone, over the relay **and** over Wi-Fi.
- [ ] The version's own manual checks (listed in its section) pass.
- [ ] `Antigravity Remote: Copy Diagnostics` output looks right on both PCs.

**Release**
- [ ] Release branch and pull request (version bump + changelog); CI green; 👤 owner merges. `main` is protected: every change goes through a PR with all 9 checks passing, for everyone including admins.
- [ ] Tag `vX.Y.Z` on the merge commit; GitHub release with the VSIX built from it attached.
- [ ] 👤 Publish the same VSIX to Open VSX and the VS Code Marketplace.
- [ ] 👤 If `src/pwa/` changed: `cd relay && npx wrangler deploy`, then confirm the live site serves the new app version.
- [ ] Check both listings show the new version, and the GitHub release asset matches the published file (SHA-256).
- [ ] Update `TRACKER.md` and this plan.

**Rollback (if a release breaks something)**
- 👤 Republish the previous VSIX to both marketplaces (it is attached to the previous GitHub release).
- 👤 If the phone app is the problem: check out the previous tag and run `npx wrangler deploy` in `relay/`.

### Core regression checklist (run for every release)

| # | Check | Relay | Wi-Fi |
|---|---|:-:|:-:|
| C1 | Pair a phone by QR | ☐ | ☐ |
| C2 | Pair by PIN | n/a | ☐ |
| C3 | Agent asks to run a command → approve once from the phone | ☐ | ☐ |
| C4 | Deny with a note; the agent receives the note | ☐ | ☐ |
| C5 | Allow for the whole conversation | ☐ | ☐ |
| C6 | Send a prompt; the reply streams to the phone | ☐ | ☐ |
| C7 | Stop a running agent | ☐ | ☐ |
| C8 | Two project windows open: tabs switch and act on the right window | ☐ | ☐ |
| C9 | Close the window that hosts the server: phone keeps working | ☐ | ☐ |
| C10 | Push notification arrives with the phone locked (approval, finished) | ☐ | n/a |
| C11 | Lock the phone 5 min, unlock: reconnects within 2 s | ☐ | ☐ |
| C12 | Unpair a phone: it is refused and drops off the pairing panel | ☐ | ☐ |
| C13 | Attach a screenshot; the agent describes it | ☐ | ☐ |

---

## 0.2.3: Test foundation and attachment confirmation

**Goal:** make "test first, test everywhere" possible before adding features, and close the one open question from 0.2.0.

**Tests first**
- [x] `0.2.3-T1` CI workflow runs `npm test` on Windows, macOS and Linux for every push and pull request (GitHub Actions is free for public repos). (#1, PR #18; it immediately caught two tests that only passed on the owner's PC because they read the real `~/.gemini` history.)
- [x] `0.2.3-T2` Browser tests for the phone app with Playwright (dev-only, approved). 10 tests: pairing screen, project title, file-name chips, no HTML execution, approve, deny with note, prompt, attach tray, image compression, stop. (#2, PR #18)
- [x] `0.2.3-T3` (changed after B3) Tests: every phone image is saved into the project and named by full path in the prompt; the `images` field is still sent; if the IDE refuses it the prompt is resent without it and each image is saved once; uploads older than 7 days are removed.
- [x] `0.2.3-T4` Dropped: no `imagesAsFiles` setting is needed, because files are now always used.

**Build**
- [x] `0.2.3-B1` `.github/workflows/test.yml`: 3 operating systems × Node 22 and 24, relay suite, browser tests, VSIX build with a 150 KB budget.
- [x] `0.2.3-B2` Browser test harness (`test/browser/`, fake agent with a control API) and `npm run test:browser`.
- [x] `0.2.3-B3` Live check (owner, 2026-10-28, Windows, agy agent): the screenshot was sent with the `images` field, Antigravity accepted it without error, and the agent replied that no screenshot was attached. It did open image files from disk on its own. Result: the field is ignored.
- [x] `0.2.3-B4` Images are always saved to `<project>/.ag-remote/uploads/` (git-ignored, cleaned after 7 days) and named in the prompt; the field is kept for builds that support it. Not a `media`-field experiment: files already work and need no guess about the protocol.

**Manual checks for this version**
- [ ] `0.2.3-V1` C13 on Windows and Mac, relay and Wi-Fi, text + image and image only.

**Release** - [ ] `0.2.3-R1` Release gate complete.

---

## 0.2.5: Safer pairing (patch)

**Goal:** close the pairing-code risk before adding features. Someone who sees or guesses the 6-character code, or photographs the QR code, must not be able to pair a phone on their own.

**Already merged (PR #22):** relay-only by default (`agRemote.transport` = `"relay"`, the local server listens on this PC only), 10 pairing-code lookups a minute per IP, 60 relay connections a minute per IP. The relay part is live.

**Tests first**
- [x] `0.2.5-T1` Pairing tests (`test/test-e2e.ts` [9]): a phone with the right secret waits and is not saved; the secret is used up while it waits; allow pairs it; deny, a 2-minute timeout, or the phone leaving refuses it and saves nothing; a request can be answered once; both sides compute the same 4-digit check code; a "wait" message forged by the relay pairs nothing.
- [x] `0.2.5-T2` Extension relay tests (`test/test-relay-host.ts`): the IDE is asked with name and check code, sees no keys, and a denied phone is not written to `relay.json`.
- [x] `0.2.5-T3` Loopback route tests (`test/test-hub-and-cdp.ts`): any window can list waiting phones and answer them; web pages can't.

**Build**
- [x] `0.2.5-B1` `HostE2E` asks before saving a new phone (`pair-wait` message, `pendingApprovals`, `answerApproval`, `checkCode`); the extension always turns it on.
- [x] `0.2.5-B2` Pairing panel shows waiting phones with Allow / Deny (any window, over loopback); the hosting window shows a notification when its panel isn't on screen; after a deny the panel shows a fresh QR code.
- [x] `0.2.5-B3` Phone shows "On your PC, click Allow" with its check code and waits up to 2 min 15 s; clear messages for denied and timed out. Cache version bumped (app.js v10, shell v14).

**Manual checks for this version**
- [x] `0.2.5-V1` Pair by QR: phone shows the code, PC shows the same code, Allow pairs it.
- [x] `0.2.5-V2` Pair by the 6-character code, from the panel in a second window (not the hosting one).
- [x] `0.2.5-V3` Deny: the phone says it was not allowed and the panel shows a new QR code.
- [x] `0.2.5-V4` Wait 2 minutes without answering: the phone says nobody answered; nothing is added to the paired list.
- [x] `0.2.5-V5` A phone that was already paired reconnects without being asked.
- [x] `0.2.5-V6` Wi-Fi rows of the core checklist with `agRemote.transport` set to `"both"`.

**Release gate**

Before building the VSIX
- [x] All new tests were committed before (or with) the code they test, and failed without it.
- [x] `npm test` passes locally.
- [x] CI passes on Windows, macOS and Linux.
- [x] `relay` tests pass (`src/pwa/` changed).
- [x] No new runtime dependency; any new dev dependency was approved.

Build
- [x] Version bumped in `package.json`; `CHANGELOG.md` entry written for users.
- [x] `npm run package` builds the VSIX with no warnings; size noted (budget 150 KB).
- [x] VSIX contents checked: icon, `dist/extension.cjs`, `dist/pwa/*`, no source maps, notes or tests.

Verify the built VSIX (manual, real devices)
- [x] 👤 Install the VSIX in Antigravity, reload every window.
- [x] 👤 `cd relay && npx wrangler deploy` first (the phone app changed), and confirm the live site serves app.js v10.
- [x] 👤 Core regression checklist on Android (and iPhone if available), relay and Wi-Fi.
- [x] 👤 The manual checks above pass.

Release
- [x] Pull request with CI green; 👤 owner merges.
- [x] Tag `v0.2.5` on the merge commit; GitHub release with the tested VSIX attached.
- [x] 👤 Publish the same VSIX to Open VSX and the VS Code Marketplace.
- [x] Both listings show 0.2.5 and the GitHub asset matches the published file (SHA-256).
- [x] Update `TRACKER.md` and this plan.

**Release** - [x] `0.2.5-R1` Release gate complete. Released 2026-10-30 (Open VSX, Marketplace, GitHub release v0.2.5 on 76ef060; all three files identical).

---

## 0.2.6: Notifications you can tell apart, and an instant wake-up (patch)

**Goal:** every notification says which project it is about and what kind of request it is, without showing the command; and turning the phone screen back on shows the live session at once instead of reconnecting from scratch.

**Tests first**
- [x] `0.2.6-T1` Push content (`test/test-relay-host.ts` [4b]): the push names the kind of request (command, new file, file edit, question) but carries no command, description, folder, question text or approval id; it has the project name, a short per-window key and the time; each window gets its own key; "finished" waits until the agent stays idle, is sent once, and a question right after a run cancels it; the push topic is per project, and payloads from older PCs keep the old topic.
- [x] `0.2.6-T2` What the phone shows (`test/test-pwa.ts`, sw.js push handler in a sandbox): title is the project, body says what the agent wants; one notification per project; "finished" replaces that project's approval; app icon and badge; payloads from a PC before 0.2.6 and unknown kinds still read clearly; every pre-cached file is served; PNG icons in the manifest.
- [x] `0.2.6-T3` Wake-up (`test/test-relay-link.ts`, new): several wake events while connecting keep the one socket; an open socket is checked with one ping and kept if the relay answers; no answer in 2 s replaces it once; a closed socket is replaced at once; a socket stuck opening for 8 s is restarted; an unpaired phone stays put.

**Build**
- [x] `0.2.6-B1` PC: `requestCategory()` (kind of request only), project name from the event's window (or the only window), per-window key and time in the encrypted payload, "finished" after 3 s of idle, push `Topic` per project.
- [x] `0.2.6-B2` Phone service worker: "<project>" / "The agent wants to run a command" (create a file, edit a file, has a question, use the browser, open a web page, use a tool, needs your permission; finished its task), one tag per project, timestamp, PNG icon and badge (`src/pwa/icons/`, 16 KB, copied by `build:pwa`). Tapping a notification shows what it said while the app reconnects. Opening the app clears its notifications.
- [x] `0.2.6-B3` Phone wake-up: `RelayLink.wake()` keeps a socket that is still opening, pings an open one and keeps it if it answers, and replaces only a dead one (`restart()`). Wi-Fi mode no longer restarts a socket that is still opening. One resync at a time; the shown window's chat is asked for together with the window list and drawn first. "Reconnecting..." instead of "Connecting..." after the first connection. Cache version bumped (app.js v11, shell v15).

**Manual checks for this version**
- [ ] `0.2.6-V1` Lock the phone, start a run in project A that needs a command approval: the notification is titled with A's name and says "The agent wants to run a command", with no command text on the lock screen.
- [ ] `0.2.6-V2` Two windows (A and B) both ask while the phone is locked: two separate notifications, one per project.
- [ ] `0.2.6-V3` A run in A finishes: one "finished its task" notification that replaces A's approval notification; no extra "finished" while the agent is still working between steps.
- [ ] `0.2.6-V4` Screen off for about 30 seconds, then on: the app shows "Ready"/"Working" straight away with no "Reconnecting..." (socket kept).
- [ ] `0.2.6-V5` Screen off for 10 minutes or more, then on: the last screen stays visible, "Reconnecting..." shows briefly, and the live session is back within about 2 seconds.
- [ ] `0.2.6-V6` Tap a notification: the app opens, shows what the notification said, and clears the other notifications.
- [ ] `0.2.6-V7` The installed app (Android) shows the new icon on the Home Screen and in notifications.

**Release gate**

Before building the VSIX
- [x] All new tests were committed before (or with) the code they test, and failed without it.
- [x] `npm test` passes locally (all 12 suites), and `npm run test:browser` 15 / 15.
- [ ] CI passes on Windows, macOS and Linux.
- [x] `relay` tests pass (`src/pwa/` changed): 58 / 58.
- [x] No new runtime dependency; any new dev dependency was approved.

Build
- [x] Version bumped in `package.json`; `CHANGELOG.md` entry written for users.
- [x] `npm run package` builds the VSIX with no warnings; size noted (budget 150 KB): 120 KB (was 103 KB; icons 16 KB).
- [x] VSIX contents checked: icon, `dist/extension.cjs`, `dist/pwa/*` including `dist/pwa/icons/*`, no source maps, notes or tests (18 files).

Verify the built VSIX (manual, real devices)
- [ ] 👤 Install the VSIX in Antigravity, quit Antigravity completely and open it again.
- [ ] 👤 `cd relay && npx wrangler deploy` first (the phone app changed), and confirm the live site serves app.js v11 and shell v15.
- [ ] 👤 Core regression checklist on Android (and iPhone if available), relay and Wi-Fi.
- [ ] 👤 The manual checks above pass.

Release
- [ ] Pull request with CI green; 👤 owner merges.
- [ ] Tag `v0.2.6` on the merge commit; GitHub release with the tested VSIX attached.
- [ ] 👤 Publish the same VSIX to Open VSX and the VS Code Marketplace.
- [ ] Both listings show 0.2.6 and the GitHub asset matches the published file (SHA-256).
- [ ] Update `TRACKER.md` and this plan.

**Release** - [ ] `0.2.6-R1` Release gate complete.

---

## 0.3.0: Voice input and any file

**Goal:** the two biggest input gaps against competitors.

**Tests first**
- [ ] `0.3.0-T1` Browser test with a stubbed `SpeechRecognition`: the mic button appears only when supported and on HTTPS; speaking fills the message box; it never sends on its own.
- [ ] `0.3.0-T2` Browser test: on plain HTTP (Wi-Fi mode) the mic button is hidden.
- [ ] `0.3.0-T3` API test: `/api/prompt` accepts `files` (PDF, text, code, logs) up to the size limit; rejects executables and oversized files.
- [ ] `0.3.0-T4` Adapter test: files are saved under `.ag-remote/uploads/` with safe names (no path traversal), and the prompt names them.
- [ ] `0.3.0-T5` Browser test: the attach tray shows file chips with name and size; remove works.

**Build**
- [ ] `0.3.0-B1` Mic button using the browser's built-in speech recognition (free, on-device or by the browser vendor; no service of ours).
- [ ] `0.3.0-B2` File picker and file chips in the phone app.
- [ ] `0.3.0-B3` File handling on the PC (reuse the image fallback path).

**Manual checks**
- [ ] `0.3.0-V1` Dictate a prompt on Android Chrome and iPhone Safari (relay).
- [ ] `0.3.0-V2` Send a PDF and a log file; the agent opens and summarises them.

**Release** - [ ] `0.3.0-R1` Release gate complete (relay redeploy needed).

---

## 0.3.1: Readable replies and a better listing

**Goal:** replies that read like the IDE, and a listing that converts.

**Tests first**
- [ ] `0.3.1-T1` Unit tests for the Markdown renderer: code blocks, inline code, lists, headings, links, bold; HTML in messages is shown as text, never run.
- [ ] `0.3.1-T2` Browser test: a long code block scrolls sideways without widening the page.

**Build**
- [ ] `0.3.1-B1` Small built-in Markdown renderer (no CDN, no dependency), building DOM nodes only.
- [ ] `0.3.1-B2` README: 3 to 5 phone screenshots and a short demo GIF.
- [ ] `0.3.1-B3` Listing description rewritten around "end-to-end encrypted, any network, no debug flag, full approval controls".
- [ ] `0.3.1-B4` `CONTRIBUTING.md`, `SECURITY.md` (how to report privately), issue templates (bug with diagnostics, feature request).

**Manual checks**
- [ ] `0.3.1-V1` Real agent replies with code and lists look right on a small phone in light and dark mode.

**Release** - [ ] `0.3.1-R1` Release gate complete (relay redeploy needed).

---

## 0.4.0: See what the agent changed, and safe auto-approve

**Goal:** approve with confidence, and approve less often without giving up control.

**Tests first**
- [ ] `0.4.0-T1` Bridge test (fake server): diffs are read from the agent's edit steps, for new, changed and deleted files.
- [ ] `0.4.0-T2` Browser test: the approval card shows the diff, collapsed for long changes.
- [ ] `0.4.0-T3` Rule tests: an allow-rule only matches what it says (exact command or prefix), never on substrings; rules can't approve file deletes outside the project; an empty rule list approves nothing.
- [ ] `0.4.0-T4` Adapter test: every auto-approval is written to the audit log and shown on the phone; turning rules off stops it at once.

**Build**
- [ ] `0.4.0-B1` Diff view in the approval card and a "Changes" list per conversation.
- [ ] `0.4.0-B2` Opt-in auto-approve rules (setting, off by default), editable from the phone, applied on the PC.

**Manual checks**
- [ ] `0.4.0-V1` A file edit shows the right diff on the phone before approving.
- [ ] `0.4.0-V2` With a rule for `npm test`, that command runs without asking; `npm install` still asks.

**Release** - [ ] `0.4.0-R1` Release gate complete (relay redeploy needed).

---

## 0.4.1: History, search, model and mode

**Tests first**
- [ ] `0.4.1-T1` Test: conversation list paging and search by title, newest first, scoped to the window's folder.
- [ ] `0.4.1-T2` Test: changing model or mode for a conversation sends the right config and only affects that conversation.

**Build**
- [ ] `0.4.1-B1` Searchable history in the conversations dialog.
- [ ] `0.4.1-B2` Model and mode picker per conversation.

**Manual checks**
- [ ] `0.4.1-V1` Resume a week-old conversation from the phone; switch its model; the IDE shows the same.

**Release** - [ ] `0.4.1-R1` Release gate complete.

---

## 0.4.2: Git basics

**Tests first**
- [ ] `0.4.2-T1` Test with a temporary repo: status lists changed files; commit needs a message and a confirmation from the phone; push is refused without an upstream.
- [ ] `0.4.2-T2` Test: Git actions are refused for a window whose folder is not a repo.

**Build**
- [ ] `0.4.2-B1` Status, diff and commit through VS Code's built-in Git extension; push behind a second confirmation.

**Manual checks**
- [ ] `0.4.2-V1` Commit and push the agent's work from the phone; the IDE's Source Control view matches.

**Release** - [ ] `0.4.2-R1` Release gate complete (relay redeploy needed).

---

## 0.5.0: Languages, tablets, quiet hours

**Tests first**
- [ ] `0.5.0-T1` Test: every string in the phone app comes from the language file; a missing key falls back to English.
- [ ] `0.5.0-T2` Browser test at tablet and desktop widths: two-pane layout, no horizontal scroll.
- [ ] `0.5.0-T3` Test: no push during quiet hours except approvals (setting), per phone.

**Build**
- [ ] `0.5.0-B1` Language files (English first; others by pull request).
- [ ] `0.5.0-B2` Tablet and desktop layout.
- [ ] `0.5.0-B3` Quiet hours and per-phone notification settings.

**Manual checks**
- [ ] `0.5.0-V1` iPad or Android tablet in landscape; quiet hours on a real phone overnight.

**Release** - [ ] `0.5.0-R1` Release gate complete (relay redeploy needed).

---

## 0.5.1: Run your own relay, local API

**Tests first**
- [ ] `0.5.1-T1` Relay test: a fresh deploy from the guide's command passes the relay suite.
- [ ] `0.5.1-T2` API tests: loopback only, token required, same validation as the phone API; refused from another machine.

**Build**
- [ ] `0.5.1-B1` One-command guide to deploy the relay to the user's own free Cloudflare account; `agRemote.relayUrl` documented.
- [ ] `0.5.1-B2` Local API and MCP server (opt-in setting, off by default).

**Manual checks**
- [ ] `0.5.1-V1` Follow the guide on a clean Cloudflare account and pair through it.
- [ ] `0.5.1-V2` Drive a prompt and an approval from an MCP client.

**Release** - [ ] `0.5.1-R1` Release gate complete.

---

## 0.6.0 (investigate first): Windsurf

- [ ] `0.6.0-T1` Feasibility probe: does Windsurf's agent run the same language server and accept the same calls? Write the findings to NOTES.md before any code.
- [ ] `0.6.0-T2` If yes: contract tests against a fake server with Windsurf's shapes, before building support.
- Decision point (👤): go or no-go based on T1.

---

## Status

| Version | Theme | Status |
|---|---|---|
| 0.2.2 | Mac fix, diagnostics, live pairing panel, smaller VSIX | ✅ Released 2026-10-28 |
| 0.2.3 | CI on 3 OSes, browser tests, attachments confirmed | ✅ Released 2026-10-29 |
| 0.2.4 | Short pairing codes, QR opens the installed app | ✅ Released 2026-10-29 |
| 0.2.5 | Safer pairing: "Allow this phone?", relay-only default, relay limits; every window its own chat | ✅ Released 2026-10-30 |
| 0.2.6 | Notifications that say which project and what it wants; instant wake-up | 🟡 Ready for testing |
| 0.3.0 | Voice input, any file | ⬜ Next |
| 0.3.1 | Readable replies, listing polish | ⬜ |
| 0.4.0 | Diffs, safe auto-approve | ⬜ |
| 0.4.1 | History and search, model and mode | ⬜ |
| 0.4.2 | Git basics | ⬜ |
| 0.5.0 | Languages, tablets, quiet hours | ⬜ |
| 0.5.1 | Own relay, local API / MCP | ⬜ |
| 0.6.0 | Windsurf (investigate) | ⬜ |
