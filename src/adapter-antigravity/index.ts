import type { IdeAdapter, SessionSnapshot, Approval, AdapterEvent } from '../core/types.ts';
import { type AdapterConfig, defaultConfig } from './config.ts';
import { SessionWatcher } from './session-watcher.ts';
import { CliBridge } from './cli-bridge.ts';
import { auditLogger } from '../core/logger.ts';

export class AntigravityAdapter implements IdeAdapter {
  public readonly name: string = 'antigravity';
  private config: AdapterConfig;
  private watcher: SessionWatcher;
  private cli: CliBridge;
  private eventCallbacks: Array<(e: AdapterEvent) => void> = [];

  constructor(workspacePath: string = process.cwd(), customConfig: Partial<AdapterConfig> = {}) {
    this.config = { ...defaultConfig, ...customConfig };
    this.watcher = new SessionWatcher(workspacePath, this.config);
    this.cli = new CliBridge(this.config, workspacePath);

    this.watcher.on('event', (e: AdapterEvent) => {
      for (const cb of this.eventCallbacks) {
        try {
          cb(e);
        } catch (err) {
          console.error('[AntigravityAdapter] Error in event listener:', err);
        }
      }
    });
  }

  public async connect(): Promise<void> {
    auditLogger.log('CONNECT', { adapter: this.name });
    await this.watcher.start();
  }

  public async disconnect(): Promise<void> {
    auditLogger.log('DISCONNECT', { adapter: this.name });
    this.watcher.stop();
  }

  public async getSnapshot(): Promise<SessionSnapshot> {
    return this.watcher.getSnapshot();
  }

  public async sendPrompt(text: string): Promise<void> {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('Prompt text cannot be empty');
    }

    auditLogger.log('PROMPT', { textLength: text.length, preview: text.slice(0, 100) });
    await this.cli.sendPrompt(text.trim());
  }

  public async getPendingApproval(): Promise<Approval | null> {
    return this.watcher.getPendingApproval();
  }

  public async approve(id: string, response?: string, option?: 'allow_once' | 'always_allow'): Promise<void> {
    const pending = this.watcher.getPendingApproval();
    if (!pending) {
      throw new Error('No pending approval awaiting confirmation');
    }

    // Security Rule: Never approve a different item than the displayed one
    if (pending.id !== id) {
      throw new Error(`Approval ID mismatch: requested '${id}', but pending is '${pending.id}'`);
    }

    auditLogger.log('APPROVE', { id, kind: pending.kind, description: pending.description, response, option });
    await this.cli.approveAction(pending, response, option);
  }

  public async deny(id: string, reason?: string): Promise<void> {
    const pending = this.watcher.getPendingApproval();
    if (!pending) {
      throw new Error('No pending approval awaiting confirmation');
    }

    // Security Rule: Never deny a different item than the displayed one
    if (pending.id !== id) {
      throw new Error(`Approval ID mismatch: requested '${id}', but pending is '${pending.id}'`);
    }

    auditLogger.log('DENY', { id, kind: pending.kind, description: pending.description, reason });
    await this.cli.denyAction(pending, reason);
  }

  public async stop(): Promise<void> {
    auditLogger.log('STOP', { timestamp: Date.now() });
    await this.cli.stopGeneration();
  }

  public onEvent(cb: (e: AdapterEvent) => void): void {
    this.eventCallbacks.push(cb);
  }

  public listSessions(): Array<{ id: string; mtime: number; title: string; workspace: string; isCurrent: boolean }> {
    return this.watcher.listAllSessions();
  }

  public setWorkspace(workspacePath: string): void {
    this.cli.setTargetWorkspace(workspacePath);
    this.watcher.setWorkspace(workspacePath);
  }

  public async setActiveSession(id: string): Promise<boolean> {
    auditLogger.log('SWITCH_SESSION', { targetId: id });
    const success = await this.watcher.setActiveConversationId(id);
    if (success) {
      const all = this.watcher.listAllSessions();
      const current = all.find(s => s.id === id);
      if (current && current.workspace) {
        this.setWorkspace(current.workspace);
      }
    }
    return success;
  }
}

