import EventEmitter from 'events';
import type { IdeAdapter, SessionSnapshot, Approval, ApprovalOption, AdapterEvent } from './types.ts';
import { AuthManager } from './auth.ts';
import { auditLogger, AuditLogger } from './logger.ts';
import { WindowRegistry, windowRegistry, type RegisteredWindow } from './window-registry.ts';

export class SessionManager extends EventEmitter {
  private adapter: IdeAdapter;
  public auth: AuthManager;
  public logger: AuditLogger;
  public registry: WindowRegistry;
  private isConnected: boolean = false;

  constructor(adapter: IdeAdapter, customSessionToken?: string) {
    super();
    this.adapter = adapter;
    this.auth = new AuthManager(customSessionToken);
    this.logger = auditLogger;
    this.registry = windowRegistry;

    this.adapter.onEvent((event: AdapterEvent) => {
      this.emit('adapter_event', event);
    });

    this.registry.on('change', (windows: RegisteredWindow[]) => {
      this.emit('adapter_event', { type: 'windows_changed', windows } as any);
    });

    this.registry.on('selected', (win: RegisteredWindow) => {
      if (this.adapter.setWorkspace) {
        this.adapter.setWorkspace(win.workspacePath);
      }
      if (win.activeConversationId && this.adapter.setActiveSession) {
        this.adapter.setActiveSession(win.activeConversationId);
      }
    });
  }

  public async start(): Promise<void> {
    if (this.isConnected) return;
    await this.adapter.connect();
    this.isConnected = true;
  }

  public async stop(): Promise<void> {
    if (!this.isConnected) return;
    this.registry.stop();
    await this.adapter.disconnect();
    this.isConnected = false;
  }

  public async getSnapshot(): Promise<SessionSnapshot> {
    return this.adapter.getSnapshot();
  }

  public async sendPrompt(text: string): Promise<void> {
    await this.adapter.sendPrompt(text);
  }

  public async approve(id: string, response?: string, option?: ApprovalOption): Promise<void> {
    await this.adapter.approve(id, response, option);
  }

  public async deny(id: string, reason?: string): Promise<void> {
    await this.adapter.deny(id, reason);
  }

  public async stopGeneration(): Promise<void> {
    await this.adapter.stop();
  }

  public listWindows(): RegisteredWindow[] {
    return this.registry.getAll();
  }

  public selectWindow(windowId: string): RegisteredWindow | null {
    const win = this.registry.selectWindow(windowId);
    if (win) {
      if (this.adapter.setWorkspace) {
        this.adapter.setWorkspace(win.workspacePath);
      }
      if (win.activeConversationId && this.adapter.setActiveSession) {
        this.adapter.setActiveSession(win.activeConversationId);
      }
    }
    return win;
  }

  public async listSessions(): Promise<Array<{ id: string; mtime: number; title: string; workspace: string; isCurrent: boolean }>> {
    const activeWindows = this.registry.getAll();
    const allSessions = this.adapter.listSessions ? await this.adapter.listSessions() : [];

    // If active windows are registered, filter sessions to only those matching active windows!
    if (activeWindows.length > 0) {
      const activePaths = new Set(activeWindows.map(w => w.workspacePath.toLowerCase().replace(/\\/g, '/')));
      const activeIds = new Set(activeWindows.map(w => w.activeConversationId).filter(Boolean));

      const filtered = allSessions.filter(s => {
        const sWs = (s.workspace || '').toLowerCase().replace(/\\/g, '/');
        return activePaths.has(sWs) || activeIds.has(s.id);
      });

      if (filtered.length > 0) {
        return filtered;
      }
    }

    return allSessions;
  }

  public async setActiveSession(id: string): Promise<boolean> {
    if (this.adapter.setActiveSession) {
      const switched = await this.adapter.setActiveSession(id);
      if (switched) {
        const snap = await this.adapter.getSnapshot();
        this.emit('adapter_event', { type: 'status_changed', status: snap.status } as AdapterEvent);
      }
      return switched;
    }
    return false;
  }
}

