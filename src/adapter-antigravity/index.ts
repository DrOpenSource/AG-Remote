import type { IdeAdapter, SessionSnapshot, SessionStatus, Approval, ApprovalOption, AdapterEvent } from '../core/types.ts';
import { type AdapterConfig, defaultConfig } from './config.ts';
import { SessionWatcher } from './session-watcher.ts';
import { LsBridge, type LiveInteraction } from './ls-bridge.ts';
import { auditLogger } from '../core/logger.ts';

export interface AdapterDeps {
  /** Live IDE bridge. `null` disables it (tests, offline). Default: real bridge unless AG_REMOTE_LIVE_BRIDGE=0. */
  lsBridge?: LsBridge | null;
  livePollMs?: number;
}

const BRIDGE_UNAVAILABLE = 'Antigravity live bridge unavailable: is the IDE running? Nothing was sent.';

function toApproval(p: LiveInteraction): Approval {
  const actions: ApprovalOption[] =
    p.kind === 'permission' || p.kind === 'filePermission' ? ['allow_once', 'allow_conversation', 'deny']
    : p.kind === 'runCommand' || ['openBrowserUrl', 'captureBrowserScreenshot', 'executeBrowserJavascript', 'mcp', 'readUrlContent'].includes(p.kind) ? ['allow_once', 'deny']
    : [];
  return {
    id: `ls:${p.cascadeId}:${p.trajectoryId}:${p.stepIndex}`,
    kind: p.stepType === 'RUN_COMMAND' ? 'run_command' : (p.stepType.toLowerCase() || p.kind),
    description: p.actionDescription || 'The agent is waiting for your permission',
    detail: p.commandLine || p.target || p.absolutePathUri,
    cwd: p.cwd,
    stepIndex: p.stepIndex,
    actions
  };
}

export class AntigravityAdapter implements IdeAdapter {
  public readonly name: string = 'antigravity';
  private config: AdapterConfig;
  private watcher: SessionWatcher;
  private ls: LsBridge | null;
  private livePollMs: number;
  private liveTimer: NodeJS.Timeout | null = null;
  private livePending: LiveInteraction | null = null;
  private liveApproval: Approval | null = null;
  private lastStatus: SessionStatus = 'disconnected';
  private eventCallbacks: Array<(e: AdapterEvent) => void> = [];

  constructor(workspacePath: string = process.cwd(), customConfig: Partial<AdapterConfig> = {}, deps: AdapterDeps = {}) {
    this.config = { ...defaultConfig, ...customConfig };
    this.watcher = new SessionWatcher(workspacePath, this.config);
    this.ls = deps.lsBridge !== undefined
      ? deps.lsBridge
      : (process.env.AG_REMOTE_LIVE_BRIDGE === '0' ? null : new LsBridge());
    this.livePollMs = deps.livePollMs ?? 1000;

    this.watcher.on('event', (e: AdapterEvent) => {
      if (this.ls && (e.type === 'approval_requested' || e.type === 'status_changed')) {
        // Transcript-based approval detection is a guess; the live bridge is authoritative.
        this.emitStatusIfChanged();
        return;
      }
      if (e.type === 'status_changed') this.lastStatus = e.status;
      this.emit(e);
    });
  }

  private emit(e: AdapterEvent): void {
    for (const cb of this.eventCallbacks) {
      try {
        cb(e);
      } catch (err) {
        console.error('[AntigravityAdapter] Error in event listener:', err);
      }
    }
  }

  private effectiveStatus(): SessionStatus {
    const base = this.watcher.getSnapshot().status;
    if (!this.ls) return base;
    if (this.liveApproval) return 'awaiting_approval';
    return base === 'awaiting_approval' ? 'generating' : base;
  }

  private emitStatusIfChanged(): void {
    const status = this.effectiveStatus();
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.emit({ type: 'status_changed', status });
    }
  }

  private async pollLive(): Promise<void> {
    if (!this.ls) return;
    const cid = this.watcher.getActiveConversationId();
    let pending: LiveInteraction | null = null;
    if (cid) {
      try { pending = await this.ls.findPending(cid); } catch (_) { pending = null; }
    }
    const approval = pending ? toApproval(pending) : null;
    const changed = (approval?.id || null) !== (this.liveApproval?.id || null);
    this.livePending = pending;
    this.liveApproval = approval;
    if (changed && approval) this.emit({ type: 'approval_requested', approval });
    this.emitStatusIfChanged();
  }

  public async connect(): Promise<void> {
    auditLogger.log('CONNECT', { adapter: this.name });
    await this.watcher.start();
    if (this.ls && !this.liveTimer) {
      await this.pollLive();
      this.liveTimer = setInterval(() => { this.pollLive(); }, this.livePollMs);
      this.liveTimer.unref?.();
    }
  }

  public async disconnect(): Promise<void> {
    auditLogger.log('DISCONNECT', { adapter: this.name });
    if (this.liveTimer) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
    this.watcher.stop();
  }

  public async getSnapshot(): Promise<SessionSnapshot> {
    const snap = this.watcher.getSnapshot();
    if (!this.ls) return snap;
    return { ...snap, status: this.effectiveStatus(), pendingApproval: this.liveApproval };
  }

  public async getPendingApproval(): Promise<Approval | null> {
    return this.ls ? this.liveApproval : this.watcher.getPendingApproval();
  }

  /** Validates the request against the currently displayed approval; never acts on anything else. */
  private requirePending(id: string): { approval: Approval; live: LiveInteraction } {
    const approval = this.ls ? this.liveApproval : this.watcher.getPendingApproval();
    if (!approval) throw new Error('No pending approval awaiting confirmation');
    if (approval.id !== id) throw new Error(`Approval ID mismatch: requested '${id}', but pending is '${approval.id}'`);
    if (!this.ls || !this.livePending) throw new Error(BRIDGE_UNAVAILABLE);
    return { approval, live: this.livePending };
  }

  public async sendPrompt(text: string): Promise<void> {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('Prompt text cannot be empty');
    }
    const cid = this.watcher.getActiveConversationId();
    if (!this.ls || !cid) throw new Error(BRIDGE_UNAVAILABLE);
    auditLogger.log('PROMPT', { textLength: text.length, preview: text.slice(0, 100), cascadeId: cid });
    await this.ls.sendPrompt(cid, text.trim());
  }

  public async approve(id: string, _response?: string, option: ApprovalOption = 'allow_once'): Promise<void> {
    const { approval, live } = this.requirePending(id);
    const scope = option === 'allow_conversation' || option === 'always_allow' ? 'conversation' : 'once';
    if (scope === 'conversation' && !approval.actions?.includes('allow_conversation')) {
      throw new Error('"Allow for this conversation" is not available for this request');
    }
    auditLogger.log('APPROVE', { id, kind: approval.kind, detail: approval.detail, scope });
    await this.ls!.respond(live, { allow: true, scope });
    await this.pollLive();
  }

  public async deny(id: string, reason?: string): Promise<void> {
    const { approval, live } = this.requirePending(id);
    auditLogger.log('DENY', { id, kind: approval.kind, detail: approval.detail, reason });
    await this.ls!.respond(live, { allow: false, instruction: reason?.trim() || undefined });
    await this.pollLive();
  }

  public async stop(): Promise<void> {
    const cid = this.watcher.getActiveConversationId();
    if (!this.ls || !cid) throw new Error(BRIDGE_UNAVAILABLE);
    auditLogger.log('STOP', { cascadeId: cid });
    await this.ls.cancel(cid);
  }

  public onEvent(cb: (e: AdapterEvent) => void): void {
    this.eventCallbacks.push(cb);
  }

  public listSessions(): Array<{ id: string; mtime: number; title: string; workspace: string; isCurrent: boolean }> {
    return this.watcher.listAllSessions();
  }

  public setWorkspace(workspacePath: string): void {
    this.livePending = null;
    this.liveApproval = null;
    this.watcher.setWorkspace(workspacePath);
    this.pollLive();
  }

  public async setActiveSession(id: string): Promise<boolean> {
    auditLogger.log('SWITCH_SESSION', { targetId: id });
    const success = await this.watcher.setActiveConversationId(id);
    if (success) {
      this.livePending = null;
      this.liveApproval = null;
      await this.pollLive();
    }
    return success;
  }
}
