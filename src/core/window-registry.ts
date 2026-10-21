import EventEmitter from 'events';

export interface RegisteredWindow {
  windowId: string;
  workspaceName: string;
  workspacePath: string;
  activeConversationId: string | null;
  isFocused: boolean;
  lastHeartbeat: number;
  pid?: number;
}

export class WindowRegistry extends EventEmitter {
  private windows: Map<string, RegisteredWindow> = new Map();
  private selectedWindowId: string | null = null;
  private pruneInterval: NodeJS.Timeout | null = null;
  private readonly HEARTBEAT_TIMEOUT_MS = 10000; // 10s without heartbeat = window closed

  constructor() {
    super();
    this.startPruning();
  }

  public register(info: {
    windowId: string;
    workspaceName?: string;
    workspacePath: string;
    activeConversationId?: string | null;
    isFocused?: boolean;
    pid?: number;
  }): RegisteredWindow {
    const now = Date.now();
    const wsPath = info.workspacePath.replace(/\\/g, '/');
    const wsName = info.workspaceName || wsPath.split('/').pop() || 'Workspace';

    const existing = this.windows.get(info.windowId);
    const updated: RegisteredWindow = {
      windowId: info.windowId,
      workspaceName: wsName,
      workspacePath: wsPath,
      activeConversationId: info.activeConversationId !== undefined ? info.activeConversationId : (existing?.activeConversationId || null),
      isFocused: info.isFocused !== undefined ? info.isFocused : (existing?.isFocused || false),
      lastHeartbeat: now,
      pid: info.pid || existing?.pid
    };

    this.windows.set(info.windowId, updated);

    const prevSelected = this.selectedWindowId;
    // If no window is selected yet, or this window is newly focused, select it
    if (!this.selectedWindowId || updated.isFocused) {
      this.selectedWindowId = updated.windowId;
      if (prevSelected !== updated.windowId) {
        this.emit('selected', updated);
      }
    }

    this.emit('change', this.getAll());
    return updated;
  }

  public heartbeat(windowId: string): boolean {
    const win = this.windows.get(windowId);
    if (!win) return false;
    win.lastHeartbeat = Date.now();
    return true;
  }

  public updateActiveConversation(windowId: string, conversationId: string): boolean {
    const win = this.windows.get(windowId);
    if (!win) return false;
    win.activeConversationId = conversationId;
    win.lastHeartbeat = Date.now();
    this.emit('change', this.getAll());
    return true;
  }

  public unregister(windowId: string): boolean {
    const removed = this.windows.delete(windowId);
    if (removed) {
      if (this.selectedWindowId === windowId) {
        // Fallback to first remaining window or null
        const first = this.windows.values().next().value;
        this.selectedWindowId = first ? first.windowId : null;
        if (first) {
          this.emit('selected', first);
        }
      }
      this.emit('change', this.getAll());
    }
    return removed;
  }

  public selectWindow(windowId: string): RegisteredWindow | null {
    const win = this.windows.get(windowId);
    if (!win) return null;
    this.selectedWindowId = windowId;
    this.emit('selected', win);
    this.emit('change', this.getAll());
    return win;
  }

  public getSelected(): RegisteredWindow | null {
    if (!this.selectedWindowId) {
      // Pick first window if any
      const first = this.windows.values().next().value;
      if (first) {
        this.selectedWindowId = first.windowId;
        return first;
      }
      return null;
    }
    return this.windows.get(this.selectedWindowId) || null;
  }

  public getAll(): RegisteredWindow[] {
    const now = Date.now();
    const result: RegisteredWindow[] = [];
    for (const win of this.windows.values()) {
      if (now - win.lastHeartbeat <= this.HEARTBEAT_TIMEOUT_MS) {
        result.push({ ...win });
      }
    }
    return result;
  }

  public get(windowId: string): RegisteredWindow | null {
    const win = this.windows.get(windowId);
    if (!win) return null;
    if (Date.now() - win.lastHeartbeat > this.HEARTBEAT_TIMEOUT_MS) {
      this.windows.delete(windowId);
      return null;
    }
    return { ...win };
  }

  public pruneDeadWindows(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, win] of this.windows.entries()) {
      if (now - win.lastHeartbeat > this.HEARTBEAT_TIMEOUT_MS) {
        this.windows.delete(id);
        if (this.selectedWindowId === id) {
          const first = this.windows.keys().next().value;
          this.selectedWindowId = first || null;
        }
        changed = true;
      }
    }
    if (changed) {
      this.emit('change', this.getAll());
    }
  }

  private startPruning(): void {
    if (this.pruneInterval) return;
    this.pruneInterval = setInterval(() => {
      this.pruneDeadWindows();
    }, 4000);
    if (this.pruneInterval.unref) {
      this.pruneInterval.unref();
    }
  }

  public stop(): void {
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }
  }
}

export const windowRegistry = new WindowRegistry();
