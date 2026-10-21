/**
 * Core types for IDE Remote Control.
 * IDE-agnostic interfaces implemented by adapter layers.
 */

export type SessionStatus = 'idle' | 'generating' | 'awaiting_approval' | 'disconnected';

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  ts: number;
}

export interface Approval {
  id: string;
  kind: string; // e.g. "run_command", "ask_question", "write_to_file"
  description: string;
  detail?: string;
  stepIndex?: number;
  question?: string;
  options?: string[];
  isMultiSelect?: boolean;
}

export interface SessionSnapshot {
  status: SessionStatus;
  messages: ChatMessage[];
  pendingApproval: Approval | null;
}

export type AdapterEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'approval_requested'; approval: Approval }
  | { type: 'status_changed'; status: SessionStatus }
  | { type: 'windows_changed'; windows: any[] }
  | { type: 'adapter_error'; error: string };

export interface IdeAdapter {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getSnapshot(): Promise<SessionSnapshot>;
  sendPrompt(text: string): Promise<void>;
  getPendingApproval(): Promise<Approval | null>;
  approve(id: string, response?: string, option?: 'allow_once' | 'always_allow'): Promise<void>;
  deny(id: string, reason?: string): Promise<void>;
  stop(): Promise<void>;
  onEvent(cb: (e: AdapterEvent) => void): void;
  listSessions?(): Array<{ id: string; mtime: number; title: string; workspace: string; isCurrent: boolean }>;
  setActiveSession?(id: string): Promise<boolean>;
  setWorkspace?(workspacePath: string): void;
}

