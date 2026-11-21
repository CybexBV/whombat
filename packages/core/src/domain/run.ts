import { z } from 'zod';
import { BurrowId, ConversationId, MessageId, PrincipalId, RepoId, RunId } from '../ids.js';
import { KeyId } from '../keys/catalog.js';
import { Count, DiffStat, FileChange, Percent, TestCounts, Timestamp } from './common.js';

/** live → paused → live … → done | failed; taken_over when a person takes the branch. */
export const RunStatus = z.enum(['live', 'paused', 'done', 'failed', 'taken_over']);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunStepState = z.enum(['done', 'active', 'queued', 'failed']);
export type RunStepState = z.infer<typeof RunStepState>;

export const RunStep = z.object({
  title: z.string().min(1).max(160),
  detail: z.string().max(280),
  /** When the step became active; null while queued. Shown as HH:MM. */
  at: Timestamp.nullable(),
  state: RunStepState,
});
export type RunStep = z.infer<typeof RunStep>;

/** A LIVE LOG line. Lines starting with `$` are commands, `✓` passes, `✗` failures. */
export const RunLogLine = z.object({
  seq: z.number().int().nonnegative(),
  at: Timestamp,
  text: z.string().max(2000),
});
export type RunLogLine = z.infer<typeof RunLogLine>;

/** An agent run. The log is served separately (`run.log` events, run detail endpoint). */
export const Run = z.object({
  id: RunId,
  /** Burrow-wide number: "Run #1907". */
  number: z.number().int().positive(),
  burrowId: BurrowId,
  agentId: PrincipalId,
  title: z.string().min(1).max(160),
  branch: z.string().min(1).max(255),
  repoId: RepoId.nullable(),
  prNumber: z.number().int().positive().nullable(),
  status: RunStatus,
  /** Person (or agent) the run is for: "Asked by Waffle in #billing-v2". */
  askedById: PrincipalId,
  conversationId: ConversationId,
  /** The run card message. */
  messageId: MessageId.nullable(),
  /**
   * The thread the run card is in (CT-261): its root message, null when the card is in the conversation itself. A
   * channel shows a live run's progress on that thread's reply row.
   */
  threadRootId: MessageId.nullable().optional(),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  /** Progress bar width, 0–100. */
  progress: Percent,
  /** What the run is doing now (latest log line); the card shows "Now: {activity}" while live. */
  activity: z.string().max(280),
  /** One-line result once done ("Pushed 7be20f and asked Waffle to re-review."). */
  summary: z.string().max(280).nullable(),
  /**
   * Why a live run needs a person (CT-197): its agent stopped without finishing it, waiting on nobody, even after
   * Whombat woke it once (“Banjo stopped without finishing this run.”). Cleared when the run moves again (the agent
   * reports, a person resumes or retries it, it finishes). Null or absent: nothing to do.
   */
  attention: z.string().max(280).nullable().optional(),
  steps: z.array(RunStep),
  tests: TestCounts.nullable(),
  files: z.array(FileChange),
  diff: DiffStat,
  keysUsed: z.array(KeyId),
  /** Log lines so far (the page shows the last 12). */
  logCount: Count,
  pausedById: PrincipalId.nullable(),
  takenOverById: PrincipalId.nullable(),
});
export type Run = z.infer<typeof Run>;
