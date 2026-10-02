import type { TaskRetry } from './retry.js';
import type { BriefSnapshot } from './brief.js';
import type { TaskPermissions } from './permissions.js';
import type { ReviewAudit } from './review.js';
/** Coder-agnostic request, decision, and task shapes. Adapters normalize into these; the decider only sees these. */

export type CoderKind = 'claude' | 'codex';

export const CODER_NAMES: Record<CoderKind, string> = { claude: 'Claude Code', codex: 'Codex' };

export type CoderRequestKind = 'command' | 'file-write' | 'file-read' | 'network' | 'question' | 'other';

export interface CoderQuestionOption { label: string; description?: string }

export interface CoderQuestion {
  question: string;
  header?: string;
  options: CoderQuestionOption[];
  multiSelect: boolean;
}

export interface CoderRequest {
  kind: CoderRequestKind;
  /** Sub-tool name as reported by the coder (Bash, Edit, AskUserQuestion, ...). */
  tool: string;
  /** One line for the user and the model. */
  summary: string;
  /** Full command, diff, or question body; truncated before display. */
  detail: string;
  /** The exact command line for `command` requests, without the coder's explanation. */
  command?: string;
  /** Absolute paths the request touches, when known. */
  paths: string[];
  /** Present for `question` requests only. */
  questions?: CoderQuestion[];
  raw: Record<string, unknown>;
}

export type CoderDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

/** Request kinds a habit rule can describe; network requests always escalate. */
export type HabitKind = Exclude<CoderRequestKind, 'network'>;

/**
 * Second decision layer: a deterministic rule the user set, learning solidified,
 * or a project file declared. Hard rules run first and cannot be overridden.
 */
export interface HabitRule {
  id: string;
  source: 'user' | 'learned' | 'project';
  kind: HabitKind;
  /** Leading command tokens, a path glob, a question keyword, or a tool-name glob, by kind. */
  pattern: string;
  decision: 'allow' | 'deny' | 'answer';
  /** Fixed answer for `answer` rules on questions. */
  answer?: string;
  note?: string;
  createdAt: number;
}

export type DecisionLayer = 'hard' | 'habit' | 'user' | 'supervisor';

/** One thing the coder did, in a line: a command it ran, a file it edited. Never the tool's output. */
export interface TaskStep { at: number; text: string }

export interface DecisionRecord {
  at: number;
  kind: CoderRequestKind;
  summary: string;
  layer: DecisionLayer;
  outcome: 'allow' | 'deny' | 'answer' | 'ask';
  reason?: string;
  /** What hard rule settled this, so repeated attempts at one block are recognisable as the same block. */
  blockKey?: string;
  /** Rules the user asked to remember with this decision, described for the report. */
  remembered?: string[];
}

export type TaskStatus = 'queued' | 'running' | 'waiting-user' | 'verifying' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface TaskResult {
  summary: string;
  changedFiles: string[];
  commits?: string[];
  outsideRoots: string[];
  verifyOk?: boolean;
  verifyOutput?: string;
  verifyChecks?: { command: string; ok: boolean; executed: boolean; output: string }[];
  detail?: string;
  execution?: 'completed' | 'failed' | 'stopped';
  verification?: 'passed' | 'failed' | 'not-run';
}

export interface TaskRecord {
  id: string;
  coder: CoderKind;
  description: string;
  brief?: BriefSnapshot;
  planStep?: string;
  cwd: string;
  verify?: string;
  verifyCommands?: string[];
  verifyCwd?: string;
  verifyNetwork?: 'offline' | 'loopback' | 'ask';
  /** Explicit owner choice; applies only to this run, never inferred from model prose. */
  verificationSkipped?: { at: number; command: string };
  permissions?: TaskPermissions;
  safetyReviews?: (ReviewAudit & { at: number })[];
  stopReason?: string;
  retry?: TaskRetry;
  status: TaskStatus;
  /** DSH session that dispatched the task; escalations are asked on its live agent. */
  ownerSession: string;
  jobId?: string;
  /** Presentation link only; never drives task execution or recovery. */
  completionNotice?: { messageId: string; seq: number; at: number };
  /** The coder's own session id: set from the start when this task continues another, else once the coder reports it. */
  coderSessionId?: string;
  /** The task this one continues in the same coder session. */
  resumedFrom?: string;
  replaces?: string;
  /** Explicit earlier tasks in the same owner session; all must pass independent verification. */
  dependsOn?: string[];
  createdAt: number;
  /** Actual execution start; queue wait is excluded from the runtime budget. */
  startedAt?: number;
  updatedAt: number;
  escalations: number;
  decisions: DecisionRecord[];
  /** Requests nothing stopped and nobody was asked about; kept as a count, the steps themselves are in `trace`. */
  autoAllowed?: number;
  /** The escalation currently waiting for the user, so status can say what is awaited. */
  pending?: PendingEscalation;
  /** What the coder is doing now; only meaningful while the task is running. */
  activity?: string;
  /** The last steps the coder took, oldest first. */
  trace?: TaskStep[];
  result?: TaskResult;
}

export interface PendingEscalation {
  at: number;
  kind: CoderRequestKind;
  summary: string;
  detail?: string;
}

export const ACTIVE_STATUSES: readonly TaskStatus[] = ['queued', 'running', 'waiting-user', 'verifying'];

export function isActive(task: Pick<TaskRecord, 'status'>): boolean {
  return ACTIVE_STATUSES.includes(task.status);
}
