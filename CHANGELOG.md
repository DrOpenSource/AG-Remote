# Changelog

## 0.2.6: Notifications you can tell apart, and the phone is live as soon as you look

> **After installing this update, quit Antigravity completely** (File → Exit) and open it again, so every window runs the new version. The phone app updates itself the next time you open it.

- **Notifications say which project and what the agent wants.** The title is the project's name, and the text says what kind of request it is: "The agent wants to run a command", "wants to edit a file", "has a question for you", "finished its task". The command, file name and question are never shown, because a notification can appear on a locked screen. Open the app to see them.
- **One notification per project.** Two projects asking at once now give two notifications instead of one replacing the other, and "finished" replaces that project's approval notification once it no longer needs you. Each one shows when it happened and carries the app's icon.
- **No extra "finished" notifications.** The agent often pauses between steps; "finished" is now sent only once it has stayed idle for a few seconds.
- **Opening the app clears its notifications,** and tapping one shows what it was about while the app catches up.
- **Live as soon as you turn the screen on.** If the phone kept its connection while the screen was off, the app checks it with one quick ping and carries on, with no reconnect and no new handshake. Before, it threw away the connection after 10 seconds of quiet, and the several wake-up signals a phone sends at once could restart the connection two or three times in a row.
- **Faster catch-up when the phone did drop the connection.** The last screen stays visible with "Reconnecting...", and the window you're looking at loads first, at the same time as the window list.
- **Proper app icon** on the Home Screen (Android and iPhone) and in notifications.

## 0.2.5: Your PC decides which phones can pair, and every window shows its own chat

> **After installing this update, quit Antigravity completely** (File → Exit) and open it again, so every window runs the new version.

> If a phone gives up on pairing after about 20 seconds while your PC is still asking, it has the old app open. Close the app on the phone, open it again, and pair once more.

- **Allow this phone?** A phone that scans the QR code or types the pairing code is no longer paired straight away. Your PC asks first: in the pairing panel (in any Antigravity window), or as a notification. Both screens show the same 4-digit code, so you can tell your phone from someone else's. If nobody answers within 2 minutes, the phone is refused. Someone who saw or guessed your code still can't pair without your click.
- **Every window shows its own conversation.** With two or more Antigravity windows open, the phone could stay connected but empty, for one window or for all of them. Recent Antigravity builds start each window's agent without saying which folder it belongs to, so every window connected to whichever agent was found first, and that agent only knows its own window's chats. Each window now finds the agent its own window started; failing that, the one holding its conversations. A window whose agent is still starting, or that has no chat yet, keeps checking and switches within about a minute.
- **Copy Diagnostics shows what the phone sees.** The report now also asks every agent for its chats, checks that the shown chat's history is on disk, and shows the view of the window serving the phone: its version (with a warning if it differs from this window's), the relay status, and for each window which agent it uses, which conversation it shows and how many messages. Still no tokens, chat titles or message text.
- **Relay-only by default.** New installs, and anyone who never changed `agRemote.transport`, now connect only through the end-to-end encrypted relay, and the extension's local server accepts this PC only. Before, it also opened a plain-HTTP server on port 49222 to everyone on the same Wi-Fi, which is risky on café or office networks. To keep pairing with the Wi-Fi PIN, set `agRemote.transport` to `"both"`. Phones paired through the relay are not affected.
- **Pairing codes can't be guessed at speed.** The relay now allows 10 pairing-code lookups a minute per IP. The phone shows "Too many tries, wait a minute" if you hit it.
- **One address can't flood the relay.** Each IP can open up to 60 relay connections a minute, far above what a phone or PC needs, even several behind one mobile-carrier address.
- **Honest README.** The 6-character code stores the pairing secret on the relay for up to 5 minutes; the QR code keeps it on your devices.

## 0.2.4: Unified pairing code and direct PWA launch

- **Short pairing codes on any network.** A clean 6-character code (e.g. `K7A 9P2`) appears alongside the QR code. You can type it into your phone to pair over cellular data, remote Wi-Fi, or home Wi-Fi without scanning.
- **QR code opens the installed PWA directly.** Scanning the pairing QR with your camera now opens directly in the installed Antigravity Remote PWA instead of a browser tab.
- **PWA connect card improvements.** Fixed pairing input field filtering out non-digits when pasting links, and enabled seamless in-place pairing on the hosted relay.
- **Visual branding & marketing kit.** Added hero banner and launch copy for the VS Code Marketplace and community announcements.

## 0.2.3: Works with the new Antigravity agent (agy)

Antigravity updates from late October 2026 replaced the agent's background program and moved where chats are saved, so the phone connected but showed no conversation. Both the old and the new setup now work, the same way on Windows, macOS and Linux.

> **After installing this update, reload every open Antigravity window** (Ctrl+Shift+P, or Cmd+Shift+P on a Mac → **Developer: Reload Window**), or close and reopen Antigravity. Your phone talks to one window's copy of the extension; a window that isn't reloaded keeps running the old version, and the phone keeps showing no conversation. Your paired phones stay paired.

- **Finds the new agent.** Recognises the new `agy` program as well as the older `language_server`.
- **Each window talks to its own agent.** The new Antigravity runs one agent per window; approvals, prompts and stop now go to the right window's agent.
- **Reads chats from the new and the old folder** (`~/.gemini/antigravity` and `~/.gemini/antigravity-ide`).
- **Copy Diagnostics** shows which kind of agent was found, its project folder and its chat folder.
- **Screenshots from the phone reach the agent.** The new Antigravity agent quietly ignored attached images. Each image is now saved in your project under `.ag-remote/uploads/` (ignored by git, removed after 7 days) and the message tells the agent where it is, so it opens and reads it.
- **No more stuck "Working" and Stop button.** A conversation that ended without a reply (an error, a cancel, a closed window) could show as working forever on the phone. Working/Ready now comes from the agent itself, so it clears as soon as the agent is idle.
- **Reminds you to reload.** After an update, the first window that starts the new version tells you to reload the others. The pairing panel now has a short "For best results" section with the same advice.

## 0.2.2: Macs with a leftover agent process

- **Picks the right agent on a Mac.** Some Macs keep an old Antigravity background process running after an update or restart. The extension could connect to that one instead of the live one and show the wrong conversations. It now prefers the process that belongs to the running IDE.
- **Copy Diagnostics.** Run **Antigravity Remote: Copy Diagnostics** if the phone connects but shows no conversation. It copies a short report (no tokens or chat titles) showing what the extension found, so the problem can be fixed quickly.
- **Pairing panel stays current.** The list of paired phones updates as soon as a phone is paired or unpaired, including from another window. Revoking all pairings shows a fresh QR code.
- **Less than half the size.** The extension is now 94 KB to download and 221 KB installed (was 150 KB and 474 KB).

## 0.2.1: Mac and Linux support

- **Works on macOS and Linux.** The extension could only find Antigravity's agent on Windows, so on a Mac the phone connected but could not see or control the agent. It now finds it on macOS and Linux too.

## 0.2.0: Any network, notifications and screenshots

Your phone now reaches your PC from anywhere, not only on the same Wi-Fi. If you installed 0.1.0, uninstall it first: the publisher changed from `ag-remote` to `dr-opensource`, so VS Code sees this as a new extension. Your paired phones stay paired.

- **Works on any network.** Scan the QR code and the phone connects through the hosted relay at `remote.taqnik.in`, over mobile data or someone else's Wi-Fi. Everything is end-to-end encrypted on your devices: the relay forwards messages it cannot read. Direct Wi-Fi with a PIN still works; choose with `agRemote.transport`.
- **Notifications.** Tap the bell on the phone to get a notification when the agent needs your approval or finishes, even with the phone locked.
- **Screenshot and photo attachments.** Tap 📎 next to the message box to attach up to 4 images to a prompt. They are compressed on the phone before sending.
- **Cleaner phone header.** The header shows the project you are controlling instead of the app name, with a new icon.
- **Readable file links.** When the agent mentions a file, the reply shows just the file name instead of a long `file:///` link.
- **Manage paired phones from any window.** **Antigravity Remote: Manage Paired Phones** lists and revokes phones from any IDE window.
- **Faster wake-up.** Reopening the phone app reconnects at once instead of showing "Offline" for several seconds.

## 0.1.0: First release

- Approve, deny (with a note), prompt and stop the Antigravity agent from your phone over Wi-Fi.
- One tab per open IDE window, QR code or PIN pairing, and a local audit log of every action.
