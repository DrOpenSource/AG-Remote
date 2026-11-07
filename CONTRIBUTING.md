# Contributing to Antigravity Remote

Thank you for your interest in contributing to **Antigravity Remote** (`ag-remote`)!

Antigravity Remote is an open-source companion extension and Progressive Web App (PWA) that allows developers to monitor, steer, and approve actions executed by Google Antigravity coding agents directly from mobile devices.

---

## 1. Architectural Guardrails (Non-Negotiable)

Before writing code or opening a pull request, please review these four non-negotiable architectural principles:

1. **Zero Runtime Dependencies**:
   - `dependencies` in `package.json` **must remain empty `{}`**.
   - The desktop extension and CLI rely strictly on Node.js built-in modules (`node:crypto`, `node:http`, `node:net`, etc.) and the VS Code / Antigravity extension API.
   - The mobile PWA uses standard vanilla JavaScript and native Web APIs (WebCrypto, WebSockets, Service Workers, DOM APIs). No frontend frameworks, bundlers, or CDN scripts.
2. **Strict VSIX Download Budget**:
   - The compiled VSIX package must stay under **150 KB**.
   - Keep assets lightweight and avoid shipping unminified or unneeded files.
3. **Test-First Discipline**:
   - Every bug fix, refactor, or new feature requires automated tests that run and pass in CI.
   - Code changes without accompanying test coverage will not be merged.
4. **End-to-End Encryption & Privacy First**:
   - Never log or transmit user source code, prompt titles, or cryptographic secrets to external servers or telemetry collectors.
   - The Cloudflare Workers relay must remain a zero-knowledge blind router.

---

## 2. Getting Started

### Prerequisites
- **Node.js**: Version 20.x or newer (supports `--experimental-strip-types` for running TypeScript tests directly).
- **npm**: Version 9.x or newer.
- **Git**: For version control.
- **Browser**: Microsoft Edge, Google Chrome, or Chromium (for Playwright browser tests).

### Setup

1. **Fork and clone the repository**:
   ```bash
   git clone https://github.com/DrOpenSource/AG-Remote.git
   cd AG-Remote
   ```

2. **Install development dependencies**:
   ```bash
   npm install
   ```

3. **Build the extension, CLI, and PWA**:
   ```bash
   npm run build
   ```

---

## 3. Running Tests

Antigravity Remote has comprehensive automated test coverage spanning unit, integration, relay, and end-to-end browser suites.

### Core Test Suites (12 Suites)
Runs all unit and integration tests across language server bridges, multi-window orchestration, server endpoints, pairing logic, and audit trails:
```bash
npm test
```

### Relay Server Tests
Runs the Cloudflare Workers / Durable Object test suite (rate limiting, WebSocket routing, room lifecycle):
```bash
npm --prefix relay test
```

### Browser E2E Tests (Playwright)
Executes end-to-end browser tests for the mobile PWA interface.

On Windows or environments using the installed system browser, set `PW_CHANNEL`:
```bash
# Windows / PowerShell
$env:PW_CHANNEL="msedge"
npm run test:browser

# macOS / Linux (using Chrome or Edge)
PW_CHANNEL=chrome npm run test:browser
```

### Packaging & Size Check
Verifies that the extension packages into a compliant VSIX without bundle errors or dependencies:
```bash
npm run package
```

---

## 4. Submitting Changes

### Branching Strategy
- Branch off the latest `main`:
  ```bash
  git checkout main
  git pull origin main
  git checkout -b feat/your-feature-name
  # or
  git checkout -b fix/your-bugfix-name
  ```

### Commit Messages
We follow Conventional Commits formatting:
- `feat(scope): add new capability`
- `fix(scope): resolve bug description`
- `test(scope): add test coverage for scenario`
- `docs(scope): update documentation`
- `refactor(scope): internal cleanup without behavior change`

If you are pairing or assisted by AI agents, please include the co-author trailer:
```
Co-Authored-By: Antigravity <antigravity@google.com>
```

### Pull Requests
1. Ensure `npm test`, `npm --prefix relay test`, and `npm run test:browser` pass locally.
2. Ensure `npm run package` succeeds and the VSIX size remains under 150 KB.
3. Open a Pull Request targeting `main`.
4. All CI checks must pass before a pull request can be merged.

---

## 5. Security & Bug Reports

- To report a security vulnerability, please see [SECURITY.md](SECURITY.md).
- To report a bug or request a feature, please use our [GitHub Issue Templates](https://github.com/DrOpenSource/AG-Remote/issues/new/choose).
  - When reporting connection or session issues, please include the report from `Antigravity Remote: Copy Diagnostics` (which is sanitized and contains zero tokens or chat titles).

