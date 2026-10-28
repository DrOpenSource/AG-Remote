# Changelog

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
