# Phone app redesign: spec

Material 3 Expressive look for the phone app, built from [PWA_REDESIGN_PROMPT.md](PWA_REDESIGN_PROMPT.md). Behaviour, protocol and copy are unchanged except where listed under "Changes beyond the visual refresh".

Screenshots of every state, light and dark, 390 x 844: [screens/after/](screens/after/).

## Colour

HCT scheme seeded with `#2c5fcc`. Primary and tertiary are built from tonal palettes of the seed hue (chroma 60) and a violet (hue 305, chroma 40), so the blue stays clear instead of the default scheme's muted `#495d92`. Secondary and error come from the standard tonal-spot scheme. Surfaces use a near-neutral cool palette (hue 240, chroma 4): white in light mode, near-black (`#111416`) in dark mode, with small tonal steps between container levels. Generated once with `@material/material-color-utilities` 0.4.0 in a temporary folder; the hex values are hard-coded in `src/pwa/app.css`.

| Role | Light | Dark |
|---|---|---|
| primary / on-primary | `#2258c4` / `#ffffff` | `#b2c5ff` / `#002b74` |
| primary-container / on- | `#dae2ff` / `#0040a2` | `#0040a2` / `#dae2ff` |
| secondary-container / on- | `#dce2f9` / `#404659` | `#404659` / `#dce2f9` |
| tertiary-container / on- | `#ecdcff` / `#533a79` | `#533a79` / `#ecdcff` |
| surface | `#ffffff` | `#111416` |
| surface-container-low / - / high / highest | `#f6f6f9` `#f0f0f3` `#eaebee` `#e5e5e8` | `#191c1e` `#1d2022` `#282a2c` `#333537` |
| surface-container-lowest | `#ffffff` | `#0c0e11` |
| on-surface / on-surface-variant | `#191c1e` / `#41484d` | `#e2e2e5` / `#c1c7ce` |
| outline / outline-variant | `#71787e` / `#c1c7ce` | `#8b9198` / `#41484d` |
| error / error-container / on- | `#ba1a1a` / `#ffdad6` / `#93000a` | `#ffb4ab` / `#93000a` / `#ffdad6` |
| warning-container / on- | `#ffddb8` / `#2b1700` | `#653e00` / `#ffddb8` |
| success | `#376934` | `#9cd593` |
| inverse-surface / inverse-on-surface / inverse-primary | `#2e3133` / `#f0f0f3` / `#b2c5ff` | `#e2e2e5` / `#2e3133` / `#2258c4` |
| gradient 1 → 2 → 3 | `#007491` → `#2358c3` → `#7148af` | `#5ed4fd` → `#aabfff` → `#cdacff` |

**Signature gradient** (cyan hint → blue → violet) is used in two places only: the sweep under the header while the agent works, and the empty-state headline. Never on buttons, icons or the approval card.

### Contrast (WCAG 2.1 AA)

All 26 pairs pass in both themes.

| Text / part | On | Needs | Light | Dark |
|---|---|---|---|---|
| `on-surface` | `surface` | 4.5:1 | 17.13:1 | 14.31:1 |
| `on-surface` | `surface-container` | 4.5:1 | 15.06:1 | 12.67:1 |
| `on-surface` | `surface-container-high` | 4.5:1 | 14.37:1 | 11.14:1 |
| `on-surface` | `surface-container-highest` | 4.5:1 | 13.62:1 | 9.53:1 |
| `on-surface-variant` | `surface` | 4.5:1 | 9.30:1 | 10.86:1 |
| `on-surface-variant` | `surface-container` | 4.5:1 | 8.17:1 | 9.62:1 |
| `on-surface-variant` | `surface-container-high` | 4.5:1 | 7.80:1 | 8.46:1 |
| `on-surface-variant` | `surface-container-highest` | 4.5:1 | 7.40:1 | 7.23:1 |
| `primary` | `surface` | 4.5:1 | 6.44:1 | 10.85:1 |
| `primary` | `surface-container-highest` | 4.5:1 | 5.12:1 | 7.23:1 |
| `on-primary` | `primary` | 4.5:1 | 6.44:1 | 7.71:1 |
| `on-primary-container` | `primary-container` | 4.5:1 | 7.23:1 | 7.23:1 |
| `on-secondary-container` | `secondary-container` | 4.5:1 | 7.28:1 | 7.28:1 |
| `on-tertiary-container` | `tertiary-container` | 4.5:1 | 7.22:1 | 7.22:1 |
| `error` | `surface` | 4.5:1 | 6.46:1 | 10.89:1 |
| `error` | `surface-container-highest` | 4.5:1 | 5.14:1 | 7.25:1 |
| `on-error-container` | `error-container` | 4.5:1 | 7.24:1 | 7.24:1 |
| `on-warning-container` | `warning-container` | 4.5:1 | 13.29:1 | 7.26:1 |
| `success` | `surface` | 3:1 | 6.50:1 | 10.88:1 |
| `inverse-on-surface` | `inverse-surface` | 4.5:1 | 11.52:1 | 10.13:1 |
| `inverse-primary` | `inverse-surface` | 4.5:1 | 7.69:1 | 4.98:1 |
| `outline` | `surface` | 3:1 | 4.48:1 | 5.81:1 |
| `outline` | `surface-container-highest` | 3:1 | 3.56:1 | 3.87:1 |
| `gradient-1` | `surface` | 3:1 | 5.37:1 | 10.84:1 |
| `gradient-2` | `surface` | 3:1 | 6.45:1 | 10.22:1 |
| `gradient-3` | `surface` | 3:1 | 6.47:1 | 9.64:1 |

The gradient tones only colour large text (32 px headline) or a decorative bar, so 3:1 applies.

## Type

**AG Remote Sans**: a Latin subset of Google Sans Flex (SIL OFL 1.1, licence in `src/pwa/fonts/OFL.txt`), weight axis 400–700, other axes pinned (opsz 16, wdth 100, slnt 0, ROND 0). 20.2 KB woff2, `font-display: swap`, preloaded. It is renamed because the font's trademark terms reserve "Google Sans Flex" for unmodified copies. Fallback: Roboto, system-ui. Code: `ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace`.

| Use | Size / line | Weight |
|---|---|---|
| Empty-state headline | 32 / 40 | 500 |
| Dialog title | 24 / 32 (sheet list title 22 / 28) | 500 |
| Header title, approval title | 18 / 24, 18 / 26 | 500 |
| Agent reply, prompt box, buttons | 16 / 24 | 400 (buttons 500) |
| Body, snackbar | 14 / 20 | 400 |
| Labels, chips, status | 12 / 16, +0.4 px tracking | 500 |
| Check code | 56 / 64, tabular figures | 500 |

## Shape and motion

Corners: 4, 8, 12, 16, 20, 28 and full. Cards, dialogs and the composer: 28. User prompts: 20 with an 8 px corner toward the edge. Buttons: full, squaring to 16 while pressed.

Spring (`linear()` approximation, about 3.5 % overshoot, 500 ms) for the approval card, dialogs and sheets, snackbars, new messages, the stop button and attached images. Browsers without `linear()` use `cubic-bezier(0.34, 1.3, 0.64, 1)`. Fades and colour changes: 150–300 ms on `cubic-bezier(0.2, 0, 0, 1)`. Under `prefers-reduced-motion: reduce`, everything is instant and the working sweep stands still.

## Components

- **Header**: flat on the page surface. Project name (18 px) with the chevron opens "Windows and conversations". Status is a dot plus label in a tonal pill; "Needs you" turns the pill warning-coloured. Icon buttons are 48 px. The brand mark moved out of the bar into the agent avatar and the dialogs.
- **Working indicator**: a 3 px gradient sweep under the header, only while the agent works.
- **Window tabs**: a scrollable row of filter chips (40 px, 48 px touch target). The selected window is filled with secondary-container; a dot shows "working" and a red "!" shows "needs you".
- **Last active**: a small tonal pill, centred.
- **Chat**: agent replies are full-width plain text (16 / 24) under a 28 px avatar with the app's mark and "Antigravity". User prompts sit right-aligned in surface-container-high. "You" stays for screen readers only. File links are assist chips with a file icon; web links are underlined primary.
- **Composer**: a floating pill on surface-container (high while focused), image button on the left, send on the right as an icon that becomes a filled primary circle once there's something to send. It grows to 6 lines (144 px). While the agent works, a round Stop button takes the send button's place; if you type, send appears beside it.
- **Approval card**: surface-container-highest, 28 px corners. It sits directly above the composer (CSS `order`; DOM order unchanged) and springs up. Warning icon in a tonal circle, "Permission needed", and the kind as a chip. Title-size description. The command or file sits in an inset monospace block. Then the folder, a filled deny-note field, and full-width buttons: filled "Allow this time", tonal "Allow in this conversation", outlined error "No". Question options are large list items that round off when selected.
- **Dialogs**: bottom sheets under 600 px wide (handle bar, safe-area padding), centred 28 px dialogs above that. The pairing code field is one large field (a pasted QR link must fit, so no per-digit boxes). The 4-digit check code is 56 px with tabular figures. The pairing dialog ends with "Unofficial app. Not affiliated with Google."
- **Snackbar**: inverse surface, 8 px corners, above the composer. While an approval card is open it moves to the top, so it never covers the buttons.
- **Empty state**: left-aligned gradient headline "Connected to Antigravity" and one line of body text. Hidden while the phone isn't connected, because it says "Connected".
- **Icons**: Material Symbols Rounded (Apache 2.0) as inline SVG, 20–24 px.

## Changes beyond the visual refresh

- **Fix:** after you answered any request, a question that came next showed a dimmed card whose options could not be tapped (the busy state was only cleared for command cards). It also showed the previous card's deny-note field and folder. Fixed in `showApproval`; new browser test "a question right after an answered request can be answered" (fails on the old code).
- The feed stays scrolled to the newest message when the approval card opens, since the card now takes space at the bottom.
- The approval wait shows the 4-digit code on its own large line. The hint now ends "...should show the same code:" with the code below it, instead of inside the sentence.
- Commands in the approval card wrap at spaces (long words still break), instead of breaking anywhere. The brief asked for horizontal scrolling; wrapping was kept so that no part of a command being approved can sit off screen.

## Not done, on purpose

- No separate `preview.html` gallery: every state is screenshotted from the real app. States the fake agent can't reach (window tabs, the approval wait, offline, snackbars, the bell) are set up in the page by the screenshot script.
- App icons (`icons/*.png`) and the favicon keep their 0.2.6 colours.
