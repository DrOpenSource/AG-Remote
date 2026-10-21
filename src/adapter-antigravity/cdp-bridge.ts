import http from 'http';
import net from 'net';
import crypto from 'crypto';
import EventEmitter from 'events';
import { defaultConfig, type AdapterConfig } from './config.ts';

export interface CdpTarget {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpEvaluationResult {
  success: boolean;
  value?: any;
  error?: string;
}

export class CdpBridge extends EventEmitter {
  private config: AdapterConfig;
  private activeWs: net.Socket | null = null;
  private msgId: number = 1;
  private pendingCallbacks: Map<number, { resolve: (res: any) => void; reject: (err: any) => void }> = new Map();
  private connectedTarget: CdpTarget | null = null;
  private targetWorkspace: string = '';

  constructor(config: AdapterConfig = defaultConfig, workspacePath?: string) {
    super();
    this.config = config;
    if (workspacePath) {
      this.targetWorkspace = workspacePath.replace(/\\/g, '/');
    }
  }

  public setTargetWorkspace(workspacePath: string): void {
    if (workspacePath) {
      this.targetWorkspace = workspacePath.replace(/\\/g, '/');
    }
  }

  /** Discover available CDP targets across configured ports */
  public async discoverTargets(): Promise<{ port: number; targets: CdpTarget[] } | null> {
    const ports = this.config.cdpPorts || [9223, 9222];
    for (const port of ports) {
      try {
        const targets = await this.fetchJsonTargets(port);
        if (Array.isArray(targets) && targets.length > 0) {
          // Filter to 'page' or 'webview' targets
          const valid = targets.filter(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview'));
          if (valid.length > 0) {
            return { port, targets: valid };
          }
        }
      } catch (_) {
        // Port not listening, try next
      }
    }
    return null;
  }

  private async fetchJsonTargets(port: number): Promise<CdpTarget[]> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        {
          host: this.config.cdpHost || '127.0.0.1',
          port,
          path: '/json/list',
          timeout: 1000
        },
        (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('CDP target discovery timeout'));
      });
    });
  }

  /** Connect to the Chromium renderer debugging WebSocket */
  public async connect(): Promise<boolean> {
    const discovery = await this.discoverTargets();
    if (!discovery || discovery.targets.length === 0) {
      return false;
    }

    // Pick best matching target
    let target = discovery.targets[0];
    if (this.targetWorkspace) {
      const wsFolder = this.targetWorkspace.split('/').pop()?.toLowerCase();
      if (wsFolder) {
        const match = discovery.targets.find(t => t.title.toLowerCase().includes(wsFolder));
        if (match) target = match;
      }
    }

    if (!target.webSocketDebuggerUrl) return false;

    try {
      await this.connectWs(target.webSocketDebuggerUrl);
      this.connectedTarget = target;
      return true;
    } catch (_) {
      return false;
    }
  }

  public isConnected(): boolean {
    return this.activeWs !== null && !this.activeWs.destroyed;
  }

  public disconnect(): void {
    if (this.activeWs) {
      this.activeWs.destroy();
      this.activeWs = null;
    }
    this.connectedTarget = null;
    this.pendingCallbacks.clear();
  }

  /** Execute arbitrary JS inside Antigravity's renderer */
  public async evaluate(expression: string): Promise<CdpEvaluationResult> {
    if (!this.isConnected()) {
      const connected = await this.connect();
      if (!connected) {
        return { success: false, error: 'CDP connection unavailable' };
      }
    }

    try {
      const response = await this.sendCdpCommand('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true
      });

      if (response.exceptionDetails) {
        return {
          success: false,
          error: response.exceptionDetails.text || response.exceptionDetails.exception?.description
        };
      }

      return {
        success: true,
        value: response.result?.value
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** Click Allow Once on the active tool confirmation modal */
  public async approveAllowOnce(): Promise<CdpEvaluationResult> {
    const script = `(() => {
      // 1. Look for explicit Allow Once or standard Approve button
      const selectors = [
        'button.approve-action',
        'button[data-action="allow-once"]',
        'button[aria-label*="Allow Once"]',
        'button[aria-label*="Approve"]',
        '.tool-confirmation-approve',
        'button[aria-label="Allow"]'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && !el.disabled) {
          el.click();
          return { clicked: true, selector: sel };
        }
      }
      // 2. Generic primary action button inside confirmation container
      const container = document.querySelector('.tool-confirmation, .tool-barrier, [aria-label*="permission"]');
      if (container) {
        const btns = Array.from(container.querySelectorAll('button'));
        const allowBtn = btns.find(b => b.textContent && /allow|approve|yes|run/i.test(b.textContent));
        if (allowBtn) {
          allowBtn.click();
          return { clicked: true, text: allowBtn.textContent.trim() };
        }
      }
      return { clicked: false, error: 'No matching approval button found in DOM' };
    })()`;
    return this.evaluate(script);
  }

  /** Click Always Allow (Session / Workspace) on the tool confirmation modal */
  public async approveAlwaysAllow(): Promise<CdpEvaluationResult> {
    const script = `(() => {
      const selectors = [
        'button[data-action="always-allow"]',
        'button[aria-label*="Always Allow"]',
        'button[aria-label*="Always allow"]',
        'button.always-allow',
        '.tool-confirmation-always-allow'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && !el.disabled) {
          el.click();
          return { clicked: true, selector: sel };
        }
      }
      const container = document.querySelector('.tool-confirmation, .tool-barrier, [aria-label*="permission"]');
      if (container) {
        const btns = Array.from(container.querySelectorAll('button'));
        const alwaysBtn = btns.find(b => b.textContent && /always/i.test(b.textContent));
        if (alwaysBtn) {
          alwaysBtn.click();
          return { clicked: true, text: alwaysBtn.textContent.trim() };
        }
      }
      return { clicked: false, error: 'Always Allow button not found in DOM' };
    })()`;
    return this.evaluate(script);
  }

  /** Click Reject / Deny on the tool confirmation modal */
  public async denyAction(reason?: string): Promise<CdpEvaluationResult> {
    const script = `(() => {
      const selectors = [
        'button.deny-action',
        'button[data-action="deny"]',
        'button[aria-label*="Deny"]',
        'button[aria-label*="Reject"]',
        '.tool-confirmation-deny',
        'button[aria-label="Cancel"]'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && !el.disabled) {
          el.click();
          return { clicked: true, selector: sel };
        }
      }
      const container = document.querySelector('.tool-confirmation, .tool-barrier');
      if (container) {
        const btns = Array.from(container.querySelectorAll('button'));
        const denyBtn = btns.find(b => b.textContent && /deny|reject|cancel|no/i.test(b.textContent));
        if (denyBtn) {
          denyBtn.click();
          return { clicked: true, text: denyBtn.textContent.trim() };
        }
      }
      return { clicked: false, error: 'Deny button not found in DOM' };
    })()`;
    return this.evaluate(script);
  }

  /** Inject prompt text into active conversation input and dispatch submit */
  public async injectPrompt(text: string): Promise<CdpEvaluationResult> {
    const safeText = JSON.stringify(text);
    const script = `(() => {
      const selectors = [
        'textarea.interactive-input-editor',
        '.chat-input textarea',
        '[aria-label*="Type a prompt"]',
        '[aria-label*="Ask a question"]',
        'div.monaco-editor[aria-label*="Chat"] textarea'
      ];
      let inputEl = null;
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) { inputEl = el; break; }
      }
      if (!inputEl) {
        return { success: false, error: 'Chat input textarea not found in DOM' };
      }

      inputEl.focus();
      inputEl.value = ${safeText};
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));

      // Look for send button
      const sendBtns = [
        '.chat-input-send-button',
        'button[aria-label="Send"]',
        '.codicon-send',
        'button[title*="Send"]'
      ];
      for (const bSel of sendBtns) {
        const btn = document.querySelector(bSel);
        if (btn && !btn.disabled) {
          btn.click();
          return { success: true, method: 'send_button', selector: bSel };
        }
      }

      // Enter key dispatch fallback
      inputEl.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true
      }));

      return { success: true, method: 'enter_key' };
    })()`;
    return this.evaluate(script);
  }

  /** Answer an ask_question modal by selecting option or typing write-in */
  public async answerQuestion(choice: string): Promise<CdpEvaluationResult> {
    const safeChoice = JSON.stringify(choice);
    const script = `(() => {
      // Find modal or container
      const container = document.querySelector('.quick-input-widget, .interactive-modal, .ask-question-modal');
      const targetText = ${safeChoice}.toLowerCase();

      // Look for selectable options
      const options = Array.from(document.querySelectorAll('.quick-input-list-entry, .option-item, label, button'));
      for (const opt of options) {
        if (opt.textContent && opt.textContent.toLowerCase().includes(targetText)) {
          opt.click();
          // Look for submit or OK button
          const submitBtn = document.querySelector('button[aria-label*="Submit"], button[aria-label*="OK"], button.btn-primary');
          if (submitBtn && !submitBtn.disabled) {
            submitBtn.click();
          }
          return { success: true, clicked: opt.textContent.trim() };
        }
      }

      // Fallback: write-in text input
      const writeIn = document.querySelector('input.quick-input-box, input[type="text"], textarea');
      if (writeIn) {
        writeIn.focus();
        writeIn.value = ${safeChoice};
        writeIn.dispatchEvent(new Event('input', { bubbles: true }));
        writeIn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        return { success: true, method: 'write_in' };
      }

      return { success: false, error: 'Could not find matching option or input' };
    })()`;
    return this.evaluate(script);
  }

  // --- Lightweight Zero-Dependency WebSocket Client for CDP ---
  private async connectWs(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(wsUrl);
      const port = parseInt(parsed.port || '80', 10);
      const host = parsed.hostname;
      const key = crypto.randomBytes(16).toString('base64');

      const socket = net.createConnection({ host, port }, () => {
        const req = [
          `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
          `Host: ${host}:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '\r\n'
        ].join('\r\n');
        socket.write(req);
      });

      let handshook = false;
      let buffer = Buffer.alloc(0);

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!handshook) {
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd !== -1) {
            const headerStr = buffer.slice(0, headerEnd).toString();
            if (headerStr.includes('101 Switching Protocols')) {
              handshook = true;
              buffer = buffer.slice(headerEnd + 4);
              this.activeWs = socket;
              resolve();
            } else {
              socket.destroy();
              reject(new Error('WebSocket handshake rejected by CDP'));
            }
          }
          return;
        }

        // Process incoming WebSocket frames
        while (buffer.length >= 2) {
          const secondByte = buffer[1];
          let payloadLen = secondByte & 0x7f;
          let headerLen = 2;

          if (payloadLen === 126) {
            if (buffer.length < 4) return;
            payloadLen = buffer.readUInt16BE(2);
            headerLen = 4;
          } else if (payloadLen === 127) {
            if (buffer.length < 10) return;
            payloadLen = Number(buffer.readBigUInt64BE(2));
            headerLen = 10;
          }

          if (buffer.length < headerLen + payloadLen) return;
          const payload = buffer.slice(headerLen, headerLen + payloadLen);
          buffer = buffer.slice(headerLen + payloadLen);

          try {
            const json = JSON.parse(payload.toString());
            if (json.id && this.pendingCallbacks.has(json.id)) {
              const { resolve: pResolve, reject: pReject } = this.pendingCallbacks.get(json.id)!;
              this.pendingCallbacks.delete(json.id);
              if (json.error) {
                pReject(new Error(json.error.message || 'CDP Error'));
              } else {
                pResolve(json.result);
              }
            }
          } catch (_) {}
        }
      });

      socket.on('error', (err) => {
        if (!handshook) reject(err);
      });

      socket.on('close', () => {
        this.activeWs = null;
        this.connectedTarget = null;
      });
    });
  }

  private sendCdpCommand(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.activeWs) {
        return reject(new Error('CDP socket disconnected'));
      }

      const id = this.msgId++;
      const message = JSON.stringify({ id, method, params });
      const payload = Buffer.from(message);

      // Construct masked client frame
      const mask = crypto.randomBytes(4);
      let header: Buffer;

      if (payload.length <= 125) {
        header = Buffer.alloc(6);
        header[0] = 0x81; // Text frame
        header[1] = 0x80 | payload.length;
        mask.copy(header, 2);
      } else if (payload.length <= 65535) {
        header = Buffer.alloc(8);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
        mask.copy(header, 4);
      } else {
        header = Buffer.alloc(14);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
        mask.copy(header, 10);
      }

      const maskedPayload = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) {
        maskedPayload[i] = payload[i] ^ mask[i % 4];
      }

      this.pendingCallbacks.set(id, { resolve, reject });
      this.activeWs.write(Buffer.concat([header, maskedPayload]));

      // 4 second command timeout
      setTimeout(() => {
        if (this.pendingCallbacks.has(id)) {
          this.pendingCallbacks.delete(id);
          reject(new Error(`CDP command ${method} timed out`));
        }
      }, 4000);
    });
  }
}
