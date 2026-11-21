/**
 * The Work view (work-supervision WS-18…WS-20): one supervision list built from existing state — approvals, plan
 * steps, the agent's questions, turns (dispatches), runs and automation runs — for one viewer. No new source of truth:
 * every item points at the object that owns its state and offers that object's own controls.
 */
import { z } from 'zod';
import {
  ApprovalId,
  ConversationId,
  DispatchId,
  MessageId,
  PlanId,
  PrincipalId,
  RunId,
  StepId,
} from '../ids.js';
import { Activity } from './activity.js';
import { AutomationRunId } from './automation.js';
import { Count, Timestamp, Tone } from './common.js';
import {
  DispatchState,
  SummaryTrigger,
  TURN_FAILURE_DETAIL_MAX,
  TurnFailure,
  TurnFailureCode,
} from './dispatch.js';
import { LinkRef } from './links.js';

export const WorkSection = z.enum(['needs_you', 'running', 'queued', 'blocked', 'failed', 'done']);
export type WorkSection = z.infer<typeof WorkSection>;

/** Section titles in order (the inbox's mono labels). */
export const WORK_SECTIONS: readonly { section: WorkSection; title: string }[] = [
  { section: 'needs_you', title: 'NEEDS YOU' },
  { section: 'running', title: 'RUNNING' },
  { section: 'queued', title: 'QUEUED' },
  { section: 'blocked', title: 'BLOCKED' },
  { section: 'failed', title: 'FAILED' },
  { section: 'done', title: 'RECENTLY DONE' },
];

export const WorkItemKind = z.enum([
  'approval',
  'plan_step',
  'question',
  'run',
  'dispatch',
  'automation_run',
]);
export type WorkItemKind = z.infer<typeof WorkItemKind>;

/** The controls a Work item offers; each is an existing mechanism (approvals, runs, plans, automations). */
export const WorkAction = z.enum([
  'approve',
  'decline',
  'pause',
  'resume',
  'take_over',
  'start_step',
  'retry_step',
  'mark_step_done',
  'reply',
  'open',
  /** “Try again” on a FAILED turn (0.26, CT-167): `dispatches.retry` with `refs.dispatchId`. */
  'retry_turn',
  /**
   * “Stop” on a QUEUED or RUNNING turn (0.55, CT-295, Whombat RF-01): `dispatches.cancel` with `refs.dispatchId`. Offered
   * only to people who may stop it (`canStopTurn`); never on a run's turn (that one offers `pause`).
   */
  'stop_turn',
]);
export type WorkAction = z.infer<typeof WorkAction>;

/**
 * Heartbeat, waiting and progress are different (WS-19): `progressing` = something new in the last few minutes;
 * `quiet` = the runner's heartbeat is current but nothing new (never called failed); `waiting` = on an approval or
 * a question; `stalled` = no heartbeat for longer than the lease.
 */
export const WorkHealthState = z.enum(['progressing', 'quiet', 'waiting', 'stalled']);
export type WorkHealthState = z.infer<typeof WorkHealthState>;

export const WorkHealth = z.object({
  state: WorkHealthState,
  /** The runner's last beat for the turn. */
  heartbeatAt: Timestamp.nullable(),
  /** The last activity row or run log line. */
  lastProgressAt: Timestamp.nullable(),
  /** “Working · last step 1 min ago”, “Working quietly · last step 6 min ago”, “No word from the runner for 3 min”. */
  text: z.string().max(120),
});
export type WorkHealth = z.infer<typeof WorkHealth>;

/**
 * Why a FAILED turn failed (0.26, CT-167): the classification and sentence, the technical detail (redacted,
 * `turnFailureDetail`; null when there is none), and whether it was tried again.
 */
export const WorkFailure = z.object({
  code: TurnFailureCode,
  reason: TurnFailure.shape.reason,
  detail: z.string().max(TURN_FAILURE_DETAIL_MAX).nullable(),
  retriedAt: Timestamp.nullable().default(null),
  retryDispatchId: DispatchId.nullable().default(null),
});
export type WorkFailure = z.infer<typeof WorkFailure>;

export const WorkItem = z.object({
  /** `<kind>:<id>`, stable across refreshes. */
  id: z.string().min(1).max(120),
  kind: WorkItemKind,
  section: WorkSection,
  /** “Deploy feat/invoice-pdf to staging”, “Build the export endpoint”, “Run #1907 · Invoice PDF export”. */
  title: z.string().max(200),
  /** “Chat”, “Feedback”, “feat/invoice-pdf”. */
  where: z.string().max(120),
  /** The agent doing (or asking for) it. */
  agentId: PrincipalId.nullable(),
  /** The person who makes the next move: the approver, the person asked, the person the turn is for. */
  ownerId: PrincipalId.nullable(),
  /** The state as a pill: “NEEDS A PERSON”, “FAILED”, “PAUSED”, “QUEUED · WAITING FOR A RUNNER”. */
  status: z.object({ text: z.string().max(60), tone: Tone }),
  /** One line of why / what's next / latest activity. */
  detail: z.string().max(280).nullable(),
  since: Timestamp,
  health: WorkHealth.nullable(),
  /** The latest important activity row of the turn behind it. */
  activity: Activity.nullable(),
  link: LinkRef,
  actions: z.array(WorkAction),
  refs: z.object({
    conversationId: ConversationId.nullable(),
    messageId: MessageId.nullable().default(null),
    runNumber: z.number().int().positive().nullable().default(null),
    runId: RunId.nullable().default(null),
    approvalNumber: z.number().int().positive().nullable().default(null),
    approvalId: ApprovalId.nullable().default(null),
    planId: PlanId.nullable().default(null),
    stepId: StepId.nullable().default(null),
    automationRunNumber: z.number().int().positive().nullable().default(null),
    automationRunId: AutomationRunId.nullable().default(null),
    dispatchId: DispatchId.nullable().default(null),
  }),
  /** A failed turn's failure (0.26, CT-167); absent or null otherwise. */
  failure: WorkFailure.nullable().optional(),
});
export type WorkItem = z.infer<typeof WorkItem>;

export const WorkOverview = z.object({
  sections: z.array(z.object({ section: WorkSection, title: z.string(), items: z.array(WorkItem) })),
  counts: z.object({
    needs_you: Count,
    running: Count,
    queued: Count,
    blocked: Count,
    failed: Count,
    done: Count,
  }),
  generatedAt: Timestamp,
});
export type WorkOverview = z.infer<typeof WorkOverview>;

/** A turn's lifecycle as clients see it (realtime `dispatch.updated`, WS-19). */
export const DispatchSummary = z.object({
  id: DispatchId,
  agentId: PrincipalId,
  conversationId: ConversationId,
  threadRootId: MessageId.nullable(),
  /** As clients may read it (0.91, CT-406): `summaryTrigger` of the dispatch's own. */
  trigger: SummaryTrigger,
  state: DispatchState,
  runId: RunId.nullable(),
  createdAt: Timestamp,
  claimedAt: Timestamp.nullable(),
  heartbeatAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  /** A short, safe reason for a failed or cancelled turn (“The runner stopped”, “Taken over”). */
  reason: z.string().max(200).nullable(),
  /** A failed turn's classification and sentence (0.26, CT-167); absent or null otherwise. */
  failure: TurnFailure.nullable().optional(),
});
export type DispatchSummary = z.infer<typeof DispatchSummary>;

/** A turn that hasn't ended: it can still be stopped (0.55, CT-295). */
export function isTurnLive(state: DispatchState): boolean {
  return state === 'queued' || state === 'claimed' || state === 'running';
}

/**
 * Whether the viewer gets “Stop” on the agent's turn (0.55, CT-295, Whombat RF-01): the turn hasn't ended and isn't a
 * run's turn (`runId` set: a run is paused, `TURN_STOP_RUN_REFUSAL`), and the viewer is the person. Never the agent.
 */
export function canStopTurn(
  turn: Pick<DispatchSummary, 'state' | 'runId'>,
  viewer: { id: string; kind: 'person' | 'agent' | 'system' } | undefined,
): boolean {
  if (!isTurnLive(turn.state) || turn.runId) return false;
  return viewer?.kind === 'person';
}

/** Minutes after the last new activity when a working turn counts as quiet. */
export const WORK_QUIET_AFTER_MS = 2 * 60_000;

function minutesAgo(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 1 ? 'just now' : `${m} min ago`;
}

/**
 * The health of a working turn (WS-19). `leaseMs` is the server's lease; beyond it without a heartbeat the turn is
 * stalled (the lease sweep then retries or fails it). Quiet is not failure.
 */
export function workHealth(input: {
  now: Date;
  heartbeatAt: string | null;
  lastProgressAt: string | null;
  leaseMs: number;
  waiting?: 'approval' | 'question' | null;
}): WorkHealth {
  const now = input.now.getTime();
  const beat = input.heartbeatAt ? Date.parse(input.heartbeatAt) : null;
  const progress = input.lastProgressAt ? Date.parse(input.lastProgressAt) : null;
  const base = { heartbeatAt: input.heartbeatAt, lastProgressAt: input.lastProgressAt };
  if (input.waiting) {
    return {
      ...base,
      state: 'waiting',
      text: input.waiting === 'approval' ? 'Waiting for approval' : 'Waiting for an answer',
    };
  }
  if (beat === null || now - beat > input.leaseMs) {
    const since = beat === null ? null : now - beat;
    return {
      ...base,
      state: 'stalled',
      text:
        since === null
          ? 'No word from the runner yet'
          : `No word from the runner for ${minutesAgo(since).replace(' ago', '')}`,
    };
  }
  if (progress !== null && now - progress <= WORK_QUIET_AFTER_MS) {
    return { ...base, state: 'progressing', text: `Working · last step ${minutesAgo(now - progress)}` };
  }
  return {
    ...base,
    state: 'quiet',
    text:
      progress === null
        ? 'Working quietly · no steps reported yet'
        : `Working quietly · last step ${minutesAgo(now - progress)}`,
  };
}
