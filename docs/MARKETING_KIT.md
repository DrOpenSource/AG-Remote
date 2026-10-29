# Antigravity Remote — Go-to-Market & Launch Playbook (v0.2.3+)

> **Product:** Antigravity Remote (`ag-remote` by `dr-opensource`)  
> **Positioning:** The private, ultra-light (<98 KB), zero-config phone remote for Google Antigravity.  
> **Target Audience:** Developers using Google Antigravity / Gemini Code Assist who run long agentic tasks and hate returning to a stalled terminal prompt.

---

## 1. Core Narrative: Why Developers Install AG-Remote

### The Problem (The "Coffee Walk" Trap)

You prompt Antigravity to refactor a component, run a test suite, or perform a migration (a 10-30 minute job). You step away to make coffee or stretch your legs.
When you return, you discover the agent worked for exactly **12 seconds** before stalling on a permission gate:

```bash
run_command: npm test
[Allow Once] [Always Allow] [Deny]
```

The entire 30 minutes was wasted sitting idle.

### The Two Flawed Alternatives

1. **Dumb Auto-Accept Extensions:** Blindly approve all shell commands. Dangerous: an agent hallucinating `rm -rf` or overwriting critical files executes without oversight.
2. **Heavy Cloud SaaS Remotes:** Require separate logins, credit cards, proprietary cloud servers that see your source code, or launching the IDE with fragile `--remote-debugging-port` flags.

### The AG-Remote Angle (The Winning Pitch)

- **Zero Cloud Exposure:** End-to-end encrypted via WebCrypto (P-256 + AES-GCM). The relay cannot read your code or prompts.
- **Full-Fidelity Controls:** Tap "Allow Once", "Always Allow", or "Deny with a note" right from your phone.
- **Instant Background Alerts:** Your phone buzzes the second the agent needs an answer or finishes.
- **Ultra-Lightweight:** 98 KB VSIX, 0 runtime dependencies, zero launch flags. 100% Free & Open Source.

---

## 2. Multi-Channel Launch Posts

### Channel 1: Reddit (`r/vscode`, `r/GoogleGeminiAI`, `r/programming`, `r/webdev`)

#### Title Variants (Test 1 or 2):

- **Option A (Story-driven):** _I got tired of my AI agent stalling on permission prompts whenever I grabbed coffee, so I built an E2E-encrypted phone remote (<98 KB, zero deps, MIT)._
- **Option B (Feature-driven):** _Show Reddit: Antigravity Remote – Control and approve your Antigravity agent from your phone with zero setup and full E2E encryption._

#### Post Body:

```markdown
Hey everyone!

If you've been using Google Antigravity for longer tasks (multi-file refactors, test runs, migrations), you've probably hit this frustration: you give the agent a prompt, step away from your desk for 15 minutes, and come back to find it stopped 30 seconds in waiting for you to click "Allow" on a shell command.

I didn't want to use "auto-accept" extensions because running unchecked terminal commands while away from keyboard is a security nightmare. I also didn't want a heavy cloud service reading my workspace or requiring custom IDE debug flags.

So I built **Antigravity Remote** (`ag-remote`):

- **Approve or Deny on the Go:** Get full 3-button fidelity (`Allow Once`, `Always Allow`, `Deny with note`) and interactive question cards on your phone.
- **Background Push Alerts:** The phone buzzes with an OS notification when the agent needs an approval or finishes its run.
- **Photo & Screenshot Attachments:** Snap a picture of a whiteboard or whiteboard diagram or screenshot on mobile, and send it directly into the active prompt.
- **End-to-End Encrypted (E2EE):** Direct LAN or zero-knowledge Cloudflare relay over cellular. Payload keys are negotiated on-device via WebCrypto ECDH + AES-GCM-256. The relay never sees your code or messages.
- **Ultra-Lightweight:** Under 98 KB VSIX, zero runtime npm dependencies, zero configuration.

It's 100% free and open source (MIT):

- GitHub: https://github.com/DrOpenSource/AG-Remote
- Open VSX: https://open-vsx.org/extension/dr-opensource/ag-remote
- VS Code Marketplace: https://marketplace.visualstudio.com/items?itemName=dr-opensource.ag-remote

Would love to hear your feedback, ideas for v0.3 (voice prompting is next!), or edge cases!
```

---

### Channel 2: X / Twitter Launch Thread

#### Tweet 1 (Hook + Media):

> Ever prompt your AI agent for a 20-min task, walk away to grab coffee, and come back to see it stalled on `npm test` after 15 seconds? ☕
>
> I built **Antigravity Remote**: an E2E-encrypted mobile companion to approve commands, inject prompts, and get notified on your phone.
>
> 📦 98 KB | 0 Dependencies | 100% Free & Open Source 👇
> _(Attach 5-second demo GIF or assets/banner.png)_

#### Tweet 2 (Core Features):

> Why not just use auto-accept bots?
> Blindly auto-running terminal commands while AFK is risky.
>
> With AG-Remote:
> 🔘 1-tap `Allow Once`, `Always Allow`, or `Deny with feedback`
> 🔔 Web Push alerts when attention is needed
> 📷 Attach photos/screenshots from phone
> 🪟 Switch between multiple open project windows seamlessly

#### Tweet 3 (Security & Links):

> Security first:
> 🔒 E2EE via WebCrypto (P-256 + AES-GCM-256)
> 🚫 Zero debug flags (`--remote-debugging-port` NOT required)
> 🌐 Works over LAN or mobile data via free relay
>
> Try it in 2 minutes:
> 🔗 Open VSX: https://open-vsx.org/extension/dr-opensource/ag-remote
> ⭐ GitHub: https://github.com/DrOpenSource/AG-Remote

---

### Channel 3: Hacker News ("Show HN")

#### Title:

`Show HN: Antigravity Remote – Phone remote for Google Antigravity with E2EE and Web Push`

#### Post Body:

```markdown
Hi HN!

Modern developer agents are increasingly autonomous, but they regularly pause on human-in-the-loop gates (command execution, file modifications, questions). If you step away from your workstation, the agent sits idle.

Antigravity Remote turns any smartphone into an out-of-band control plane for Google Antigravity:

1. Zero Launch Flags: Unlike typical remote IDE tools that require relaunching with Chrome DevTools Protocol flags (--remote-debugging-port), AG-Remote discovers the running language server process and CSRF token from the OS process table and communicates via native RPC.
2. Security & E2EE: Connections over public networks route through a stateless Cloudflare Durable Object relay. Key exchange happens in-browser via WebCrypto ECDH (P-256) and all frames are AES-GCM-256 encrypted. The relay operates zero-knowledge.
3. Push & Wake: Background push notifications are signed via VAPID and delivered directly to the phone's native browser push service (APNs/FCM).
4. Zero-Dependency VSIX: Bundled via esbuild to under 98 KB.

Code is MIT: https://github.com/DrOpenSource/AG-Remote
```

---

## 3. Visual Assets Checklist

- [ ] **Hero Banner (`assets/banner.png`):** 1280x640 banner embedded at top of `README.md` and uploaded to GitHub repo Settings -> General -> Social Preview.
- [ ] **5-Second Demo GIF:**
  - Tool: [ScreenToGif](https://www.screentogif.com/) (Free)
  - Scenario: Show phone screen next to IDE. Terminal prompts `npm test`. Phone buzzes, you tap "Allow Once", IDE instantly starts tests.
- [ ] **Phone Mockup Image:**
  - Tool: [Shots.so](https://shots.so) (Free)
  - Input: Take the phone screenshot from `.ag-remote/uploads/` and place it in a modern mobile frame.
- [ ] **GitHub Badges:** Add version, Open VSX, Marketplace, license, and bundle size badges.
