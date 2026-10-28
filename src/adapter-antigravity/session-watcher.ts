import fs from 'fs';
import path from 'path';
import EventEmitter from 'events';
import type { SessionSnapshot, SessionStatus, ChatMessage, Approval, AdapterEvent } from '../core/types.ts';
import { type AdapterConfig, defaultConfig } from './config.ts';

export class SessionWatcher extends EventEmitter {
  private config: AdapterConfig;
  private currentWorkspace: string;
  private activeTranscriptPath: string | null = null;
  private activeConvId: string | null = null;
  private lastProcessedLineCount: number = 0;
  private lastSnapshot: SessionSnapshot = {
    status: 'disconnected',
    messages: [],
    pendingApproval: null
  };
  private pollTimer: NodeJS.Timeout | null = null;
  private isWatching: boolean = false;
  private lastFollowCheck: number = 0;
  private rejectedConvId: string | null = null;

  constructor(workspacePath: string = process.cwd(), config: AdapterConfig = defaultConfig) {
    super();
    this.currentWorkspace = workspacePath;
    this.config = config;
  }

  /**
   * Set when the adapter picks conversations from the IDE's own list: the watcher then only reads the
   * conversation it is given and stops guessing from transcripts.
   */
  public liveMode: boolean = false;

  public async start(): Promise<void> {
    this.activeTranscriptPath = this.resolveTranscriptPath();
    if (!this.activeTranscriptPath && this.liveMode) {
      // A window with no conversation yet: show it empty and keep polling until the adapter assigns one.
      this.lastSnapshot.status = 'idle';
    } else if (!this.activeTranscriptPath) {
      this.lastSnapshot.status = 'disconnected';
      this.emit('event', { type: 'adapter_error', error: this.config.messages.ideNotFound } as AdapterEvent);
      return;
    }

    this.isWatching = true;
    await this.updateSnapshot();

    // Event-driven periodic check (500ms interval per PRD specs for negligible CPU use)
    this.pollTimer = setInterval(async () => {
      if (this.isWatching) {
        await this.updateSnapshot();
      }
    }, this.config.timing.pollIntervalMs);
  }

  public stop(): void {
    this.isWatching = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.lastSnapshot.status = 'disconnected';
    this.emit('event', { type: 'status_changed', status: 'disconnected' } as AdapterEvent);
  }

  public getSnapshot(): SessionSnapshot {
    return { ...this.lastSnapshot };
  }

  public getPendingApproval(): Approval | null {
    return this.lastSnapshot.pendingApproval;
  }

  /**
   * Chat-history folders that exist. Antigravity has moved this between builds
   * (~/.gemini/antigravity-ide/brain, then ~/.gemini/antigravity/brain), so all are read.
   */
  private brainDirs(): string[] {
    const dirs = this.config.brainDirs?.length ? this.config.brainDirs : [this.config.brainDir];
    return [...new Set(dirs)].filter(d => fs.existsSync(d));
  }

  /** A conversation's transcript, in whichever history folder holds it. */
  private transcriptOf(id: string): string | null {
    for (const dir of this.brainDirs()) {
      const p = path.join(dir, id, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  /** Every conversation with a transcript, across all history folders. */
  private allTranscripts(): Array<{ id: string; transcript: string }> {
    const out: Array<{ id: string; transcript: string }> = [];
    const seen = new Set<string>();
    for (const dir of this.brainDirs()) {
      let entries: string[] = [];
      try { entries = fs.readdirSync(dir); } catch (_) { continue; }
      for (const id of entries) {
        if (seen.has(id)) continue;
        const transcript = path.join(dir, id, '.system_generated', 'logs', 'transcript.jsonl');
        if (fs.existsSync(transcript)) {
          seen.add(id);
          out.push({ id, transcript });
        }
      }
    }
    return out;
  }

  public resolveTranscriptPath(): string | null {
    if (this.brainDirs().length === 0) return null;

    if (this.activeConvId) {
      const explicitPath = this.transcriptOf(this.activeConvId);
      if (explicitPath) return explicitPath;
    }
    // The IDE's list says which conversations belong to this window; a guess here could show
    // (and send prompts to) another project's chat when this window has none yet.
    if (this.liveMode) return null;

    try {
      const targetWorkspace = this.currentWorkspace.toLowerCase().replace(/\\/g, '/');

      interface Candidate {
        id: string;
        mtime: number;
        cwdMatches: number;
        cwdMismatches: number;
        hasTargetString: boolean;
        path: string;
      }

      const candidates: Candidate[] = [];

      for (const { id: entry, transcript } of this.allTranscripts()) {
        if (fs.existsSync(transcript)) {
          const stat = fs.statSync(transcript);
          let cwdMatches = 0;
          let cwdMismatches = 0;
          let hasTargetString = false;

          try {
            const raw = fs.readFileSync(transcript, 'utf8');
            const lines = raw.split('\n').filter(Boolean);
            const sample = lines.slice(0, 50).concat(lines.slice(-30));

            for (const l of sample) {
              const lower = l.toLowerCase().replace(/\\/g, '/');
              if (lower.includes(targetWorkspace)) {
                hasTargetString = true;
              }

              try {
                const step = JSON.parse(l);
                if (Array.isArray(step.tool_calls)) {
                  for (const tc of step.tool_calls) {
                    if (tc.args && tc.args.Cwd) {
                      const cwd = String(tc.args.Cwd).replace(/^"|"$/g, '').toLowerCase().replace(/\\/g, '/');
                      if (cwd === targetWorkspace || cwd.startsWith(targetWorkspace + '/')) {
                        cwdMatches++;
                      } else {
                        cwdMismatches++;
                      }
                    }
                  }
                }
              } catch (_) {}
            }
          } catch (_) {}

          candidates.push({
            id: entry,
            mtime: stat.mtimeMs,
            cwdMatches,
            cwdMismatches,
            hasTargetString,
            path: transcript
          });
        }
      }

      // 1. Strict priority: Sessions where tool calls explicitly run inside our target workspace
      const strictMatches = candidates
        .filter(c => c.cwdMatches > 0 && c.cwdMismatches === 0)
        .sort((a, b) => b.mtime - a.mtime);
      if (strictMatches.length > 0) {
        this.activeConvId = strictMatches[0].id;
        return strictMatches[0].path;
      }

      // 2. Net positive tool call matches
      const netMatches = candidates
        .filter(c => c.cwdMatches > c.cwdMismatches)
        .sort((a, b) => b.mtime - a.mtime);
      if (netMatches.length > 0) {
        this.activeConvId = netMatches[0].id;
        return netMatches[0].path;
      }

      // 3. Target string present without foreign tool calls
      const stringMatches = candidates
        .filter(c => c.hasTargetString && c.cwdMismatches === 0)
        .sort((a, b) => b.mtime - a.mtime);
      if (stringMatches.length > 0) {
        this.activeConvId = stringMatches[0].id;
        return stringMatches[0].path;
      }

      // 4. Fallback to latest modified session
      const latest = candidates.sort((a, b) => b.mtime - a.mtime)[0];
      if (latest) {
        this.activeConvId = latest.id;
        return latest.path;
      }
    } catch (_) {}

    return null;
  }

  /**
   * Switch to a conversation that was updated after the one we're showing (a new chat, or the
   * user going back to an older one), unless its commands clearly ran in another workspace.
   * Only stats files on the normal path; a transcript is read only when a switch is considered.
   */
  private followNewestConversation(): void {
    if (!this.activeConvId || this.brainDirs().length === 0) return;

    let activeMtime = 0;
    const activePath = this.transcriptOf(this.activeConvId);
    try { if (activePath) activeMtime = fs.statSync(activePath).mtimeMs; } catch (_) {}

    let newest: { id: string; mtime: number; transcript: string } | null = null;
    for (const { id, transcript } of this.allTranscripts()) {
      if (id === this.activeConvId) continue;
      try {
        const mtime = fs.statSync(transcript).mtimeMs;
        if (mtime > activeMtime && (!newest || mtime > newest.mtime)) newest = { id, mtime, transcript };
      } catch (_) {}
    }
    if (!newest || newest.id === this.rejectedConvId) return;

    if (this.belongsToOtherWorkspace(newest.transcript)) {
      this.rejectedConvId = newest.id;
      return;
    }

    this.activeConvId = newest.id;
    this.activeTranscriptPath = newest.transcript;
    this.lastProcessedLineCount = 0;
    this.lastSnapshot = { status: 'idle', messages: [], pendingApproval: null };
    this.emit('event', { type: 'session_changed', conversationId: newest.id } as AdapterEvent);
  }

  private belongsToOtherWorkspace(transcript: string): boolean {
    const target = this.currentWorkspace.toLowerCase().replace(/\\/g, '/');
    let matches = 0;
    let mismatches = 0;
    try {
      for (const l of fs.readFileSync(transcript, 'utf8').split('\n')) {
        if (!l.includes('"Cwd"')) continue;
        try {
          for (const tc of JSON.parse(l).tool_calls || []) {
            if (!tc.args?.Cwd) continue;
            const cwd = String(tc.args.Cwd).replace(/^"|"$/g, '').toLowerCase().replace(/\\/g, '/');
            if (cwd === target || cwd.startsWith(target + '/')) matches++; else mismatches++;
          }
        } catch (_) {}
      }
    } catch (_) {}
    return mismatches > 0 && matches === 0;
  }

  public async updateSnapshot(): Promise<void> {
    const now = Date.now();
    if (!this.liveMode && now - this.lastFollowCheck >= 2000) {
      this.lastFollowCheck = now;
      this.followNewestConversation();
    }

    if (!this.activeTranscriptPath && this.liveMode) return;
    if (!this.activeTranscriptPath) this.activeTranscriptPath = this.resolveTranscriptPath();
    if (!this.activeTranscriptPath) {
      if (this.lastSnapshot.status !== 'disconnected') {
        this.lastSnapshot.status = 'disconnected';
        this.emit('event', { type: 'status_changed', status: 'disconnected' } as AdapterEvent);
      }
      return;
    }

    try {
      if (!fs.existsSync(this.activeTranscriptPath!)) return;

      const raw = fs.readFileSync(this.activeTranscriptPath!, 'utf8').trim();
      if (!raw) return;

      const lines = raw.split('\n').filter(Boolean);
      const messages: ChatMessage[] = [];
      let pendingApproval: Approval | null = null;
      let isGenerating = false;

      for (let i = 0; i < lines.length; i++) {
        try {
          const step = JSON.parse(lines[i]);
          const ts = step.created_at ? new Date(step.created_at).getTime() : Date.now();

          if (step.type === 'USER_INPUT') {
            // New user input concludes any preceding tool approvals
            pendingApproval = null;
            const match = step.content?.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            const text = match ? match[1].trim() : (step.content || '').slice(0, 500);
            messages.push({
              id: `msg-${step.step_index}`,
              role: 'user',
              text,
              ts
            });
            // If user input is the last step, agent is likely generating
            if (i === lines.length - 1) {
              isGenerating = true;
            }
          } else if (step.type === 'ASK_QUESTION') {
            // Execution of ask_question clears pending ask_question approval
            if (pendingApproval && pendingApproval.kind === 'ask_question') {
              pendingApproval = null;
            }
          } else if (step.type === 'RUN_COMMAND') {
            // Completed or running command clears pending run_command approval
            if (pendingApproval && pendingApproval.kind === 'run_command') {
              pendingApproval = null;
            }
          } else if (step.type === 'CODE_ACTION') {
            // File edit execution clears pending write/edit approvals
            if (pendingApproval && ['write_to_file', 'replace_file_content', 'multi_replace_file_content'].includes(pendingApproval.kind)) {
              pendingApproval = null;
            }
          } else if (step.type === 'PLANNER_RESPONSE') {
            if (step.content) {
              messages.push({
                id: `msg-${step.step_index}`,
                role: 'agent',
                text: step.content,
                ts
              });
            }

            // Check tool calls
            if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
              for (const tc of step.tool_calls) {
                const toolBaseName = tc.name.includes(':') ? tc.name.split(':').pop()! : tc.name;
                // If interactive tool call (run_command, ask_question, write_to_file, etc.)
                if (['run_command', 'ask_question', 'write_to_file', 'replace_file_content', 'multi_replace_file_content'].includes(toolBaseName)) {
                  let questionText: string | undefined;
                  let optionsList: string[] | undefined;
                  let isMulti: boolean | undefined;

                  if (toolBaseName === 'ask_question' && tc.args) {
                    let questionsData = tc.args.questions;
                    if (typeof questionsData === 'string') {
                      try {
                        questionsData = JSON.parse(questionsData);
                      } catch (_) {}
                    }
                    if (Array.isArray(questionsData) && questionsData.length > 0) {
                      const qObj = questionsData[0];
                      questionText = qObj.question || undefined;
                      if (Array.isArray(qObj.options)) {
                        optionsList = qObj.options.map((opt: any) => typeof opt === 'string' ? opt : String(opt));
                      }
                      isMulti = !!qObj.is_multi_select;
                    } else if (questionsData && typeof questionsData === 'object') {
                      questionText = (questionsData as any).question || undefined;
                      if (Array.isArray((questionsData as any).options)) {
                        optionsList = (questionsData as any).options.map((opt: any) => typeof opt === 'string' ? opt : String(opt));
                      }
                      isMulti = !!(questionsData as any).is_multi_select;
                    }
                  }

                  const cleanSummary = tc.args?.toolSummary ? String(tc.args.toolSummary).replace(/^"|"$/g, '') : undefined;
                  const cleanAction = tc.args?.toolAction ? String(tc.args.toolAction).replace(/^"|"$/g, '') : undefined;

                  pendingApproval = {
                    id: `approval-${step.step_index}-${toolBaseName}`,
                    kind: toolBaseName,
                    description: questionText || cleanSummary || cleanAction || toolBaseName,
                    detail: tc.args?.CommandLine || tc.args?.TargetFile || (questionText ? undefined : JSON.stringify(tc.args, null, 2)),
                    stepIndex: step.step_index,
                    question: questionText,
                    options: optionsList,
                    isMultiSelect: isMulti
                  };
                }
              }
            }
          }
        } catch (_) {}
      }

      // Determine current status
      let newStatus: SessionStatus = 'idle';
      if (pendingApproval) {
        newStatus = 'awaiting_approval';
      } else if (isGenerating) {
        newStatus = 'generating';
      }

      const prevStatus = this.lastSnapshot.status;
      const prevApproval = this.lastSnapshot.pendingApproval;

      // Detect new messages
      if (messages.length > this.lastSnapshot.messages.length) {
        const newMessages = messages.slice(this.lastSnapshot.messages.length);
        for (const msg of newMessages) {
          this.emit('event', { type: 'message', message: msg } as AdapterEvent);
        }
      }
      this.lastProcessedLineCount = lines.length;

      // Detect approval changes
      if (pendingApproval && (!prevApproval || prevApproval.id !== pendingApproval.id)) {
        this.emit('event', { type: 'approval_requested', approval: pendingApproval } as AdapterEvent);
      }

      // Detect status changes
      if (newStatus !== prevStatus) {
        this.emit('event', { type: 'status_changed', status: newStatus } as AdapterEvent);
      }

      this.lastSnapshot = {
        status: newStatus,
        messages,
        pendingApproval
      };
    } catch (err: any) {
      this.emit('event', { type: 'adapter_error', error: err?.message || 'Error reading session state' } as AdapterEvent);
    }
  }

  public getActiveConversationId(): string | null {
    return this.activeConvId;
  }

  public listAllSessions(): Array<{ id: string; mtime: number; title: string; workspace: string; isCurrent: boolean }> {
    const sessions: Array<{ id: string; mtime: number; title: string; workspace: string; isCurrent: boolean }> = [];
    try {
      for (const { id: entry, transcript } of this.allTranscripts()) {
        if (fs.existsSync(transcript)) {
          const stat = fs.statSync(transcript);
          let title = `Session ${entry.slice(0, 8)}`;
          let workspace = '';

          try {
            const raw = fs.readFileSync(transcript, 'utf8');
            const lines = raw.split('\n').filter(Boolean);
            for (let i = 0; i < Math.min(lines.length, 30); i++) {
              try {
                const step = JSON.parse(lines[i]);
                if (step.type === 'USER_INPUT' && step.content) {
                  const match = step.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
                  const firstReq = match ? match[1].trim() : step.content.trim();
                  if (firstReq && title.startsWith('Session ')) {
                    title = firstReq.length > 50 ? firstReq.slice(0, 50) + '...' : firstReq;
                  }
                }
                if (!workspace && step.type === 'USER_INPUT' && step.content) {
                  const wsMatch = step.content.match(/c:\\Users\\[^\s\r\n<>'"]+|[A-Za-z]:\\[^\s\r\n<>'"]+|\/[^\s\r\n<>'"]+/);
                  if (wsMatch) {
                    workspace = wsMatch[0];
                  }
                }
              } catch (_) {}
            }
          } catch (_) {}

          sessions.push({
            id: entry,
            mtime: stat.mtimeMs,
            title,
            workspace: workspace || this.currentWorkspace,
            isCurrent: entry === this.activeConvId
          });
        }
      }
    } catch (_) {}

    return sessions.sort((a, b) => b.mtime - a.mtime);
  }

  public setWorkspace(workspacePath: string): void {
    if (workspacePath) {
      this.currentWorkspace = workspacePath;
      this.activeConvId = null;
      this.activeTranscriptPath = this.resolveTranscriptPath();
      this.lastProcessedLineCount = 0;
      this.lastSnapshot = {
        status: 'idle',
        messages: [],
        pendingApproval: null
      };
      this.updateSnapshot();
    }
  }

  public async setActiveConversationId(id: string): Promise<boolean> {
    const transcript = this.transcriptOf(id);
    if (transcript) {
      const changed = id !== this.activeConvId;
      this.activeConvId = id;
      this.activeTranscriptPath = transcript;
      this.lastProcessedLineCount = 0;
      this.lastSnapshot = { status: 'idle', messages: [], pendingApproval: null };
      // Announce the switch before the new conversation's messages arrive, so the phone clears first.
      if (changed) this.emit('event', { type: 'session_changed', conversationId: id } as AdapterEvent);
      await this.updateSnapshot();
      return true;
    }
    return false;
  }
}
