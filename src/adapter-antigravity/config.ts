/**
 * Antigravity Adapter Configuration
 *
 * Antigravity-specific paths and timing for the transcript watcher. The live action
 * protocol (language-server RPC) lives in ls-bridge.ts.
 */
import os from 'os';
import path from 'path';

export interface AdapterConfig {
  brainDir: string;
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
  brainDir: path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain'),
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
