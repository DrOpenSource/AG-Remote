/**
 * Antigravity Adapter Configuration
 *
 * Antigravity-specific paths and timing for the transcript watcher. The live action
 * protocol (language-server RPC) lives in ls-bridge.ts.
 */
import os from 'os';
import path from 'path';

export interface AdapterConfig {
  /** Chat-history folder. Setting only this (tests) reads just this folder. */
  brainDir: string;
  /** All chat-history folders to read; Antigravity builds have used different ones. */
  brainDirs?: string[];
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
  brainDir: path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
  // Builds from late October 2026 (agy.exe) write to antigravity/; earlier ones to antigravity-ide/.
  brainDirs: [
    path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
    path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain')
  ],
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
