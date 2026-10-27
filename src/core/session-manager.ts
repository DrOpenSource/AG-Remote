import EventEmitter from 'events';
import type { IdeAdapter, SessionSnapshot, Approval, ApprovalOption, AdapterEvent } from './types.ts';
import { AuthManager } from './auth.ts';
import { auditLogger, AuditLogger } from './logger.ts';
import { WindowRegistry, windowRegistry, type RegisteredWindow } from './window-registry.ts';

export interface SessionManagerOptions {
  /**
   * Multi-window mode: builds an adapter for another IDE window's folder. Each open window then gets its
   * own channel (conversation, approvals, status) and every event carries its `windowId`.
   */
  createChannel?: (workspacePath: string) => IdeAdapter;
  /** Window whose channel is the adapter passed to the constructor (the window hosting the server). */
  hostWindowId?: string;
}

type SessionInfo = { id: string; mtime: number; title: string; workspace: string; isCurrent: boolean };

const normPath = (p: string) => (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export class SessionManager extends EventEmitter {
  private adapter: IdeAdapter;
  public auth: AuthManager;
  public logger: AuditLogger;
  public registry: WindowRegistry;
  private isConnected: boolean = false;
  private createChannel?: (workspacePath: string) => IdeAdapter;
  private hostWindowId: string | null;
  private channels: Map<string, IdeAdapter> = new Map();

  constructor(adapter: IdeAdapter, customSessionToken?: string, options: SessionManagerOptions = {}) {
    super();
    this.adapter = adapter;
    this.auth = new AuthManager(customSessionToken);
    this.logger = auditLogger;
    this.registry = windowRegistry;
    this.createChannel = options.createChannel;
    this.hostWindowId = options.hostWindowId || null;

    if (this.isMultiWindow()) {
      this.channels.set(this.hostWindowId!, adapter);
      this.wireChannel(this.hostWindowId!, adapter);
    } else {
      this.adapter.onEvent((event: AdapterEvent) => {
        this.emit('adapter_event', event);
      });
    }

    this.registry.on('change', (windows: RegisteredWindow[]) => {
      if (this.isMultiWindow()) this.syncChannels(windows);
      this.emit('adapter_event', { type: 'windows_changed', windows } as any);
    });

    this.registry.on('selected', (win: RegisteredWindow) => {
      // In multi-window mode every window keeps its own channel; selection is only the phone's default tab.
      if (this.isMultiWindow()) return;
      if (this.adapter.setWorkspace) {
        this.adapter.setWorkspace(win.workspacePath);
      }
      if (win.activeConversationId && this.adapter.setActiveSession) {
        this.adapter.setActiveSession(win.activeConversationId);
      }
    });
  }

  private isMultiWindow(): boolean {
    return !!this.createChannel && !!this.hostWindowId;
  }

  private wireChannel(windowId: string, channel: IdeAdapter): void {
    channel.onEvent((event: AdapterEvent) => {
      // Events from a closed window's channel must not reach the phone.
      if (this.channels.get(windowId) !== channel) return;
      this.emit('adapter_event', { ...event, windowId });
    });
  }

  /** Opens a channel for each newly registered window and closes those of windows that went away. */
  private syncChannels(windows: RegisteredWindow[]): void {
    if (!this.isConnected) return;
    const live = new Set(windows.map(w => w.windowId));
    for (const win of windows) {
      if (this.channels.has(win.windowId)) continue;
      const channel = this.createChannel!(win.workspacePath);
      this.channels.set(win.windowId, channel);
      this.wireChannel(win.windowId, channel);
      channel.connect().catch(() => {});
    }
    for (const [id, channel] of this.channels) {
      if (id === this.hostWindowId || live.has(id)) continue;
      this.channels.delete(id);
      channel.disconnect().catch(() => {});
    }
  }

  /**
   * The adapter for one window. No windowId means the phone's selected window (older clients send none).
   * An unknown windowId is an error: an action must never land in a different window.
   */
  private channel(windowId?: string): IdeAdapter {
    if (!this.isMultiWindow()) return this.adapter;
    if (windowId) {
      const ch = this.channels.get(windowId);
      if (!ch) throw new Error('That IDE window is no longer open. Nothing was sent.');
      return ch;
    }
    const selected = this.registry.getSelected();
    return (selected && this.channels.get(selected.windowId)) || this.adapter;
  }

  public async start(): Promise<void> {
    if (this.isConnected) return;
    await this.adapter.connect();
    this.isConnected = true;
    if (this.isMultiWindow()) this.syncChannels(this.registry.getAll());
  }

  public async stop(): Promise<void> {
    if (!this.isConnected) return;
    this.registry.stop();
    for (const [id, channel] of this.channels) {
      if (id !== this.hostWindowId) await channel.disconnect().catch(() => {});
    }
    this.channels.clear();
    await this.adapter.disconnect();
    this.isConnected = false;
  }

  public async getSnapshot(windowId?: string): Promise<SessionSnapshot> {
    return this.channel(windowId).getSnapshot();
  }

  public async sendPrompt(text: string, windowId?: string): Promise<void> {
    await this.channel(windowId).sendPrompt(text);
  }

  public async approve(id: string, response?: string, option?: ApprovalOption, windowId?: string): Promise<void> {
    await this.channel(windowId).approve(id, response, option);
  }

  public async deny(id: string, reason?: string, windowId?: string): Promise<void> {
    await this.channel(windowId).deny(id, reason);
  }

  public async stopGeneration(windowId?: string): Promise<void> {
    await this.channel(windowId).stop();
  }

  public listWindows(): RegisteredWindow[] {
    return this.registry.getAll();
  }

  public selectWindow(windowId: string): RegisteredWindow | null {
    const win = this.registry.selectWindow(windowId);
    if (win && !this.isMultiWindow()) {
      if (this.adapter.setWorkspace) {
        this.adapter.setWorkspace(win.workspacePath);
      }
      if (win.activeConversationId && this.adapter.setActiveSession) {
        this.adapter.setActiveSession(win.activeConversationId);
      }
    }
    return win;
  }

  public async listSessions(windowId?: string): Promise<SessionInfo[]> {
    const activeWindows = this.registry.getAll();
    const channel = this.channel(windowId);
    const allSessions = channel.listSessions ? await channel.listSessions() : [];

    if (this.isMultiWindow()) {
      // Only this window's conversations, so a pick can never move a tab into another project.
      const win = windowId ? this.registry.get(windowId) : this.registry.getSelected();
      const ws = normPath(win?.workspacePath || '');
      const mine = ws ? allSessions.filter(s => normPath(s.workspace) === ws) : [];
      return mine.length > 0 ? mine : allSessions.filter(s => s.isCurrent);
    }

    // If active windows are registered, filter sessions to only those matching active windows!
    if (activeWindows.length > 0) {
      const activePaths = new Set(activeWindows.map(w => normPath(w.workspacePath)));
      const activeIds = new Set(activeWindows.map(w => w.activeConversationId).filter(Boolean));

      const filtered = allSessions.filter(s => {
        return activePaths.has(normPath(s.workspace)) || activeIds.has(s.id);
      });

      if (filtered.length > 0) {
        return filtered;
      }
    }

    return allSessions;
  }

  public async setActiveSession(id: string, windowId?: string): Promise<boolean> {
    const channel = this.channel(windowId);
    if (channel.setActiveSession) {
      const switched = await channel.setActiveSession(id);
      if (switched) {
        const snap = await channel.getSnapshot();
        const event = { type: 'status_changed', status: snap.status } as AdapterEvent;
        this.emit('adapter_event', this.isMultiWindow()
          ? { ...event, windowId: windowId || this.registry.getSelected()?.windowId || this.hostWindowId }
          : event);
      }
      return switched;
    }
    return false;
  }
}
