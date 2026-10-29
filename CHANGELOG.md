# Changelog

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
