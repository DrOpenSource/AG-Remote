import fs from 'fs';
import { spawn } from 'child_process';
import { type AdapterConfig, defaultConfig } from './config.ts';
import type { Approval } from '../core/types.ts';
import { CdpBridge } from './cdp-bridge.ts';

export class CliBridge {
  private config: AdapterConfig;
  private resolvedCliPath: string | null = null;
  private targetWorkspace: string = process.cwd();
  public cdp: CdpBridge;

  constructor(config: AdapterConfig = defaultConfig, workspacePath?: string) {
    this.config = config;
    if (workspacePath) {
      this.targetWorkspace = workspacePath;
    }
    this.cdp = new CdpBridge(this.config, this.targetWorkspace);
  }

  public setTargetWorkspace(workspacePath: string): void {
    if (workspacePath && fs.existsSync(workspacePath)) {
      this.targetWorkspace = workspacePath;
      this.cdp.setTargetWorkspace(workspacePath);
    }
  }

  public resolveCli(): string {
    if (this.resolvedCliPath && fs.existsSync(this.resolvedCliPath)) {
      return this.resolvedCliPath;
    }

    for (const candidate of this.config.cliPaths) {
      if (fs.existsSync(candidate)) {
        this.resolvedCliPath = candidate;
        return candidate;
      }
    }

    // Default to the first configured path
    this.resolvedCliPath = this.config.cliPaths[0];
    return this.resolvedCliPath;
  }

  public async sendPrompt(text: string): Promise<void> {
    // 1. Primary: Try native CDP injection into active conversation input
    try {
      const cdpRes = await this.cdp.injectPrompt(text);
      if (cdpRes.success) {
        return;
      }
    } catch (_) {}

    // 2. Fallback: CLI spawn
    const exe = this.config.exePath;
    const cliJs = this.config.cliJsPath;
    const cwd = this.targetWorkspace || process.cwd();

    return new Promise((resolve, reject) => {
      let child;
      if (exe && cliJs && fs.existsSync(exe) && fs.existsSync(cliJs)) {
        // Direct PE executable invocation on Windows: avoids Node 24 cmd EINVAL issues
        child = spawn(exe, [cliJs, 'chat', '-r', text], {
          cwd,
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } else {
        const cli = this.resolveCli();
        if (!cli) {
          throw new Error(this.config.messages.ideNotFound);
        }
        const isWindowsCmd = process.platform === 'win32' && (cli.endsWith('.cmd') || cli.endsWith('.bat'));
        child = spawn(cli, ['chat', '-r', text], {
          cwd,
          windowsHide: true,
          shell: isWindowsCmd,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      }

      let stderr = '';
      let stdout = '';

      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });

      child.on('error', err => {
        reject(new Error(`Failed to invoke Antigravity CLI: ${err.message}`));
      });

      child.on('close', code => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Antigravity CLI chat exited with code ${code}: ${stderr || stdout}`));
        }
      });
    });
  }

  public async approveAction(approval: Approval, response?: string, option?: 'allow_once' | 'always_allow'): Promise<void> {
    // 1. Primary: Native CDP button / modal execution
    if (approval.kind === 'ask_question') {
      try {
        const answer = response || approval.description;
        const cdpRes = await this.cdp.answerQuestion(answer);
        if (cdpRes.success) return;
      } catch (_) {}
      await this.sendPrompt(response || approval.description);
      return;
    }

    try {
      if (option === 'always_allow') {
        const cdpRes = await this.cdp.approveAlwaysAllow();
        if (cdpRes.success) return;
      } else {
        const cdpRes = await this.cdp.approveAllowOnce();
        if (cdpRes.success) return;
      }
    } catch (_) {}

    // Fallback: Dispatch prompt notification
    const message = response
      ? `Approved: ${response}`
      : `Approved: Proceed with execution of ${approval.kind} (${approval.description})`;
    await this.sendPrompt(message);
  }

  public async denyAction(approval: Approval, reason?: string): Promise<void> {
    // 1. Primary: Native CDP deny button click
    try {
      const cdpRes = await this.cdp.denyAction(reason);
      if (cdpRes.success) return;
    } catch (_) {}

    // Fallback: Dispatch deny prompt
    const message = reason
      ? `Denied: ${reason}`
      : `Denied: Do not execute proposed ${approval.kind} (${approval.description}). Please reconsider the approach.`;
    await this.sendPrompt(message);
  }

  public async stopGeneration(): Promise<void> {
    // Primary: Try CDP stop button click
    try {
      const stopScript = `(() => {
        const btn = document.querySelector('.chat-stop-button, button[aria-label*="Stop"], button[aria-label*="Cancel"]');
        if (btn && !btn.disabled) { btn.click(); return { clicked: true }; }
        return { clicked: false };
      })()`;
      const cdpRes = await this.cdp.evaluate(stopScript);
      if (cdpRes.success && cdpRes.value?.clicked) return;
    } catch (_) {}

    // Fallback: Send /stop command
    await this.sendPrompt('/stop');
  }
}

