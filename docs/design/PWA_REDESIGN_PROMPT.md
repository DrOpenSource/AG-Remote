# Master prompt: phone app redesign (Gemini-style Material 3)

Paste everything below the line into the Antigravity agent, in a window with this repo open.

---

You are redesigning the phone app (PWA) of **Antigravity Remote**, an open-source extension that lets a phone control the Google Antigravity coding agent: see the chat live, approve or deny commands and file edits, answer the agent's questions, send prompts with screenshots, stop a run, and switch between IDE windows.

## Goal

Make the phone app look and feel like it belongs in Google's own app family, specifically the calm, modern feel of the Gemini app: Material 3 Expressive, Google Sans Flex, soft tonal surfaces, a floating pill composer, plain-text replies, generous spacing and springy motion. The bar is "a Google designer would assume their own team built this". It must still be clearly **Antigravity Remote**, an independent app, not a copy of Gemini.

This is a visual redesign. Behaviour, protocol, security and copy stay as they are unless this prompt says otherwise.

## Hard brand rules (never break these)

1. Do not use the name "Gemini" or "Google" in the UI, except "Antigravity" where the app already says it.
2. Do not use the Gemini sparkle/star icon, any star-shaped or four-pointed mark, the Google "G", or Google's four brand colours together.
3. Do not download, trace, screenshot or embed anything from the Gemini app or Google websites (icons, illustrations, CSS, images). Work from Material 3 public guidance and your general knowledge of the style.
4. Keep the app's own name, its own icon (the antenna mark in `index.html` and `manifest.json`) and its own wording. You may recolour the icon to the new palette; do not change its shape into anything resembling a Google product icon.
5. Add one quiet line at the bottom of the pairing dialog: "Unofficial app. Not affiliated with Google."
6. Allowed Google-made assets, because their licences allow it: **Google Sans Flex** (SIL OFL 1.1) and **Material Symbols Rounded** paths (Apache 2.0), both inlined/self-hosted.

Why it matters: this app can approve terminal commands on someone's PC. If it looks like an official Google app, a copycat page could trick people into pairing with it. It has to feel native, not counterfeit.

## Design direction

**Typography**
- Google Sans Flex, self-hosted (see constraints). Fallback stack: `"Google Sans Flex", "Google Sans", Roboto, system-ui, sans-serif`.
- Material 3 type scale. Agent replies in body-large (16px / 24px). Headline sizes for empty-state and dialog titles. Use tabular figures for PINs, pairing codes and the 4-digit check code.
- Code and command text: `ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace`. No extra code font.

**Colour**
- Generate a full Material 3 scheme (light and dark) with the HCT method, seeded from a clear, slightly deeper blue than the current `#415f91`. Use Material Theme Builder or a one-off script in a temporary folder outside the repo; hard-code the resulting hex tokens. Do not add a colour library to the project.
- Dark theme: near-black, very low-chroma neutral surfaces with small tonal steps between surface container levels, like the Gemini app at night. Light theme: white and near-white surfaces.
- Keep the `--md-*` token names already in `src/pwa/app.css` (add any missing M3 roles such as `--md-surface-bright`, `--md-tertiary`, `--md-on-tertiary-container`). Every component uses tokens, never raw hex.
- One signature gradient (your own blue to violet, with a hint of a third tone), used sparingly in two places only: the "agent is working" indicator and the empty-state headline text. Never on buttons, icons or the approval card.
- Error, warning and success roles stay clearly distinct. Deny and destructive actions use the error role.

**Shape and elevation**
- M3 Expressive corner scale: 4, 8, 12, 16, 28 and full. Cards and dialogs 28px. Composer and chips full.
- Avoid borders and shadows where a tonal surface change does the job. Flat header that merges with the page.

**Layout and components**
- **Header:** flat. Project name with the dropdown chevron (existing `#btnSwitchSession`), a small status dot with text, round icon buttons. The thin progress bar becomes the gradient working indicator.
- **Chat feed:** agent messages as full-width plain text with no bubble, preceded by a small round avatar with the app icon. User messages right-aligned in a soft `surface-container-high` container with about 20px corners. Images in user messages as rounded thumbnails. File chips as M3 assist chips.
- **Composer:** a floating pill at the bottom on `surface-container`, attach button inside on the left, a round send button on the right that fills with the primary colour once there's text. The textarea grows to about 6 lines, then scrolls. While the agent works, show the stop control in the send button's place (keep both `#btnSend` and `#btnStop`; toggle visibility).
- **Approval card:** the most prominent thing on screen. `surface-container-highest`, 28px corners, slides up with a spring. Kind label as a small chip, description as title-medium, the command or file in an inset monospace block that scrolls horizontally, working directory in label-small. Buttons: filled "Allow this time", tonal "Allow in this conversation", outlined error-coloured "No". The deny note is an M3 filled text field. Question options as large selectable list items or chips.
- **Tabs (IDE windows):** M3 secondary tabs or a filter-chip row, scrollable.
- **Dialogs:** pairing and "Windows and conversations" as M3 dialogs (or bottom sheets on narrow screens). The PIN/code field looks like a large segmented code entry. The 4-digit check code is huge, tabular and easy to compare with the PC.
- **Snackbar:** M3 snackbar on `inverse-surface`.
- **Empty state:** large gradient headline ("Connected to Antigravity"), one line of body text below, lots of space.
- **Icons:** Material Symbols Rounded as inline SVG, weight 400, sized 20/24px. No icon font.

**Motion**
- M3 Expressive spring-style easing for the approval card, dialogs, snackbars and new messages. Fades of no more than about 300ms elsewhere.
- Under `prefers-reduced-motion: reduce`, no movement, only instant or short fades.

**Accessibility (required)**
- WCAG 2.1 AA: 4.5:1 for text, 3:1 for large text and UI parts, in both themes.
- Touch targets at least 48 x 48px. Visible focus rings. Keep every existing `aria-*` attribute and label.
- Works from 360px wide up to tablets, with safe-area insets on iPhone and Android gesture bars.

## Technical constraints

- **Files you may change:** `src/pwa/index.html`, `src/pwa/app.css`, `src/pwa/manifest.json` (colours only), and `src/pwa/app.js` **only** for markup/class changes in rendering functions. New: `src/pwa/fonts/` (font plus `OFL.txt`).
- **Do not touch:** `src/pwa/e2e.js`, `src/pwa/relay-link.js`, anything outside `src/pwa/` except the two lines named below, protocol messages, storage keys, API calls, the encryption, pairing logic, or notification logic.
- **Message text stays text.** Never insert agent or user text with `innerHTML`; use `textContent` as today. A test checks this.
- **No frameworks, no CDN, no web fonts from Google's servers, no new npm dependencies.** Plain HTML, CSS and JavaScript. If you think you need a dependency, stop and ask.
- **Font budget:** the VSIX must stay under the 150 KB CI budget (it is 120 KB from 0.2.6, so about 28 KB of room is left, and a woff2 barely shrinks inside the VSIX zip). Subset Google Sans Flex to Basic Latin plus common punctuation (curly quotes, dashes, ellipsis, ·, →), keep only the weight axis (about 400 to 700) and pin the other axes, aiming for a woff2 of 24 KB or less. If it can't get under 28 KB, stop and ask before raising the budget. Do this once with fonttools in a temporary folder outside the repo, and commit only the result and `OFL.txt`. Use `font-display: swap`.
- **Font plumbing (the two allowed edits outside `src/pwa/`):** the `build:pwa` script in `package.json` copies `index.html`, `manifest.json` and `src/pwa/icons/`, so extend it to copy `src/pwa/fonts/` into `dist/pwa/fonts/` the same way. The extension's static server (`src/server/http-server.ts`) has no `.woff2` entry today, so add `'.woff2': 'font/woff2'` to its MIME table (otherwise it is served as `application/octet-stream`). Check `.vscodeignore` doesn't exclude `dist/pwa/fonts`.
- **Cache busting:** bump `app.css?v=7` and, if you change it, `app.js?v=11` in `index.html`; bump `CACHE_NAME` in `src/pwa/sw.js` (`ag-remote-shell-v15` → `v16`) and add the font file to its `ASSETS` list.
- **Keep for tests:** every element `id` in `index.html`, the classes `.hidden`, `.chat-message.agent`, `.chat-message.user`, `.chat-images img`, `.chat-file`, `a.chat-link`, `.attach-item`, `.attach-remove`, the `data-status` attributes on `body` and `#statusBadge`, and the `--bg-primary` token in `app.css`. You can restyle them freely; don't rename or remove them.
- **Copy:** keep all user-facing text. If a string must change for the layout, list it in your report rather than changing it.
- Files use LF line endings; keep them.

## Previewing every state without a real PC

The browser tests run the real app against a fake agent:

```
node --experimental-strip-types test/browser/serve.ts
```

- App: `http://127.0.0.1:49390/?token=browser-test-token`
- Control API on port 49391: `POST /reset`, `POST /message {text}`, `POST /approval {...}`, `POST /last-active {minutesAgo}`, `GET /calls`. Read `test/browser/serve.ts` for the exact payloads, and `test/browser/phone-app.spec.ts` for examples.

Some states can't be reached with the fake agent (relay "approving" wait with the 4-digit code, notifications button, multiple window tabs, offline). For those, build a **component gallery** at `docs/design/preview.html` that loads `../../src/pwa/app.css` and shows every component and state with sample data. It is not shipped.

## States that must look right (both themes, 360 x 780, 390 x 844, 412 x 915)

1. Pairing dialog: empty, typing, error.
2. Waiting for the PC to allow the phone, with the 4-digit check code.
3. Connected, empty conversation.
4. A long chat: agent replies with long paragraphs, lists written in plain text, file chips, links; user prompts with and without images.
5. Agent working: gradient indicator, stop control.
6. Approval card for a command (with working directory), a file edit, a question with options, an IDE-only request, and with the deny note filled in.
7. Attach tray with 1 and 4 images.
8. Window tabs (3 windows) and the "Windows and conversations" dialog.
9. "Last active 3 h ago" line.
10. Offline and reconnecting status ("Reconnecting..." over the last screen, which stays visible); snackbar with and without an action.
11. Notifications button off and on.
12. Opened from a notification: the snackbar says what the notification was about (for example "my-project: The agent wants to run a command") while the app catches up.

## How to work (stop where it says stop)

**Phase 1: Read and propose.**
Read `src/pwa/index.html`, `app.css`, the rendering parts of `app.js`, `sw.js`, `manifest.json`, `test/browser/*` and `test/test-pwa.ts`. Then write `docs/design/PWA_REDESIGN_SPEC.md`: the colour tokens for both themes with contrast ratios for each text/background pair, the type scale, the shape and motion tokens, and one short paragraph per component. Build `docs/design/preview.html` and take screenshots of it in both themes into `docs/design/screens/`.
**Stop. Show me the spec and screenshots and wait for my approval.** Do not edit `src/pwa/` yet.

**Phase 2: Build.**
On a new local branch `design/pwa-refresh` (never on `main`), implement the approved design in `src/pwa/`, add the font, and do the plumbing and cache bumps above.

**Phase 3: Verify.**
- `npm test` passes.
- `npm run test:browser` passes (locally: `PW_CHANNEL=msedge npm run test:browser`).
- `npm run package` succeeds; report the VSIX size before and after.
- Screenshots of every state in the list above, both themes, at 390 x 844, into `docs/design/screens/after/`.
- A contrast check of the final tokens.

**Phase 4: Report and stop.**
Do not commit, push, open a pull request, change the version, or deploy the relay. Report:
1. What changed, file by file.
2. VSIX size before and after, and the font file size.
3. Test results (paste the summary lines).
4. Paths of the screenshots.
5. Any copy you think should change, and why.
6. Anything you were unsure about or couldn't preview.

The owner reviews, commits and opens the PR. The phone app is also served by the hosted relay, so the owner redeploys it after merging.
