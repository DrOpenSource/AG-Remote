/**
 * Antigravity Adapter Configuration
 *
 * ALL Antigravity-specific paths, environment locations, CLI flags,
 * and UI/CDP selectors live exclusively in this file.
 * If Antigravity UI or internal paths change, update them here.
 */

export interface AdapterConfig {
  cliPaths: string[];
  exePath?: string;
  cliJsPath?: string;
  brainDir: string;
  cdpHost: string;
  cdpPorts: number[];
  selectors: {
    chatInput: string[];
    sendButton: string[];
    approveButton: string[];
    denyButton: string[];
    stopButton: string[];
  };
  timing: {
    pollIntervalMs: number;
    actionTimeoutMs: number;
    maxReconnectionAttempts: number;
  };
  messages: {
    uiChanged: string;
    ideNotFound: string;
    disconnected: string;
  };
}

export const defaultConfig: AdapterConfig = {
  cliPaths: [
    'C:/Users/user/AppData/Local/Programs/Antigravity IDE/bin/antigravity-ide.cmd',
    'C:/Users/user/AppData/Local/Programs/Antigravity IDE/bin/antigravity-ide',
    'antigravity-ide.cmd',
    'antigravity-ide'
  ],
  exePath: 'C:/Users/user/AppData/Local/Programs/Antigravity IDE/Antigravity IDE.exe',
  cliJsPath: 'C:/Users/user/AppData/Local/Programs/Antigravity IDE/resources/app/out/cli.js',
  brainDir: 'C:/Users/user/.gemini/antigravity-ide/brain',
  cdpHost: '127.0.0.1',
  cdpPorts: [9222, 9223],
  selectors: {
    chatInput: [
      'textarea.interactive-input-editor',
      '.chat-input textarea',
      '[aria-label="Type a prompt to the agent"]'
    ],
    sendButton: [
      '.chat-input-send-button',
      'button[aria-label="Send"]',
      '.codicon-send'
    ],
    approveButton: [
      'button.approve-action',
      'button[aria-label*="Approve"]',
      'button[aria-label*="Allow"]',
      '.tool-confirmation-approve'
    ],
    denyButton: [
      'button.deny-action',
      'button[aria-label*="Deny"]',
      'button[aria-label*="Reject"]',
      '.tool-confirmation-deny'
    ],
    stopButton: [
      '.chat-stop-button',
      'button[aria-label="Stop Generating"]',
      'button[aria-label="Cancel"]'
    ]
  },
  timing: {
    pollIntervalMs: 500, // Meets Requirement: idle polling >= 500 ms interval
    actionTimeoutMs: 3000,
    maxReconnectionAttempts: 5
  },
  messages: {
    uiChanged: 'Antigravity UI changed, update the extension',
    ideNotFound: 'Antigravity IDE process or session not found',
    disconnected: 'Disconnected from Antigravity IDE session'
  }
};
