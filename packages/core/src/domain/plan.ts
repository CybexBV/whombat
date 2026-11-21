import { z } from 'zod';
import {
  ApprovalId,
  BurrowId,
  CanvasId,
  ConversationId,
  DispatchId,
  MessageId,
  PlanId,
  PrincipalId,
  RunId,
  StepId,
} from '../ids.js';
import { AutomationRunId, type AutomationRunStatus } from './automation.js';
import { IsoDate, Timestamp } from './common.js';
import type { DispatchState } from './dispatch.js';
import type { RunStatus } from './run.js';

/**
 * Plan step markers: done = filled ok circle, active = developer-green outline, queued = line2 outline,
 * gate = warn outlined diamond — a step that needs a person. Since 0.12 (work-supervision WS-02): blocked = bad
 * outlined circle — it can't go on until someone acts (a failed or paused run, a declined approval); cancelled =
 * dropped, kept for history, not counted.
 */
export const PlanStepState = z.enum(['done', 'active', 'queued', 'gate', 'blocked', 'cancelled']);
export type PlanStepState = z.infer<typeof PlanStepState>;

/** The default `stateLabel` of each state. */
export const PLAN_STEP_LABELS: Record<PlanStepState, string> = {
  done: 'Done',
  active: 'In progress',
  queued: 'Queued',
  gate: 'Needs a person',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

export const PlanStepNote = z.string().max(280);

export const PlanStepRefs = z.object({
  runNumber: z.number().int().positive().nullable(),
  approvalNumber: z.number().int().positive().nullable(),
  automationRunNumber: z.number().int().positive().nullable(),
});
export type PlanStepRefs = z.infer<typeof PlanStepRefs>;

export const PlanStep = z.object({
  id: StepId,
  title: z.string().min(1).max(160),
  state: PlanStepState,
  /** "Done", "In progress", "Reviewing", "Approved", "Needs you", "Deployed", "Declined", "Run failed". */
  stateLabel: z.string().min(1).max(40),
  /** Run working on this step, if any (the step follows the run). */
  runId: RunId.nullable(),
  /** Approval gating this step, if any (the step follows the approval). */
  approvalId: ApprovalId.nullable(),
  /** Automation run carrying this step (the step follows it; WS-03). */
  automationRunId: AutomationRunId.nullable().default(null),
  /** The agent turn asked to do this step, until it starts a run (WS-04). */
  dispatchId: DispatchId.nullable().default(null),
  /** Why the step is where it is and what's next: “Run #1907 failed. Retry it.” */
  note: PlanStepNote.nullable().default(null),
  updatedAt: Timestamp.nullable().default(null),
  /** The linked work's numbers for links (“Run #1907”, “approval #12”), resolved when the plan is read. */
  refs: PlanStepRefs.default({ runNumber: null, approvalNumber: null, automationRunNumber: null }),
});
export type PlanStep = z.infer<typeof PlanStep>;

/** The message a plan was made from (“Make a plan”, or the request an agent planned). */
export const PlanSource = z.object({
  messageId: MessageId,
  /** The thread the plan card was posted in (the source message's thread, or the message itself as root). */
  threadRootId: MessageId.nullable(),
});
export type PlanSource = z.infer<typeof PlanSource>;

export const Plan = z.object({
  id: PlanId,
  burrowId: BurrowId,
  title: z.string().min(1).max(160),
  due: IsoDate.nullable(),
  conversationId: ConversationId,
  canvasId: CanvasId.nullable(),
  /** For the "Open plan canvas" link. */
  canvasSlug: z.string().nullable(),
  steps: z.array(PlanStep),
  updatedAt: Timestamp,
  /** Who made the plan; null for seeded plans. */
  createdById: PrincipalId.nullable().default(null),
  createdAt: Timestamp.nullable().default(null),
  source: PlanSource.nullable().default(null),
  /** The plan card message. */
  messageId: MessageId.nullable().default(null),
});
export type Plan = z.infer<typeof Plan>;

/** Most steps in one plan. */
export const PLAN_MAX_STEPS = 30;

/** Steps that count towards progress (cancelled ones don't). */
export function planProgress(plan: Pick<Plan, 'steps'>): { done: number; total: number } {
  const counted = plan.steps.filter((s) => s.state !== 'cancelled');
  return { done: counted.filter((s) => s.state === 'done').length, total: counted.length };
}

/**
 * Whether a step can be removed outright (WS-07): only while it is queued, unlinked and was never started. Anything
 * else is cancelled instead, so completed work, links and history are never lost.
 */
export function planStepRemovable(step: PlanStep & { followKey?: string | null }): boolean {
  return (
    step.state === 'queued' &&
    step.runId === null &&
    step.approvalId === null &&
    (step.automationRunId ?? null) === null &&
    (step.dispatchId ?? null) === null &&
    !step.followKey
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Following linked work (WS-05)                                                                   */
/* ---------------------------------------------------------------------------------------------- */

/** The current state of the work a step links to, as the server loaded it (never an event's copy). */
export interface PlanStepWork {
  run?: { id: string; number: number; status: RunStatus; takenOverById: string | null } | null;
  /** The approval's plan-step view (`approvalView(...).planStep` for no viewer). */
  approval?: { id: string; number: number; step: { state: PlanStepState; label: string } } | null;
  automationRun?: { id: string; number: number; status: AutomationRunStatus } | null;
  dispatch?: { id: string; state: DispatchState; hasRun: boolean } | null;
}

export interface PlanStepProjection {
  /** `<kind>:<id>:<status>`: the stored step's `followKey`; unchanged key = nothing to do. */
  followKey: string;
  state: PlanStepState;
  stateLabel: string;
  note: string | null;
}

const RUN_FINISHED: readonly RunStatus[] = ['done', 'failed', 'taken_over'];
const AUTOMATION_FINISHED: readonly AutomationRunStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
  'needs_review',
];

/**
 * What a step's state should be given its linked work, or null when nothing drives it. Pure and idempotent: the
 * caller writes only when `followKey` differs from the stored one, and leaves a step alone that was set to done or
 * cancelled by hand for the same key (`shouldApplyProjection`). Precedence: an unfinished run or automation run,
 * else an approval, else a finished run or automation run, else the dispatch.
 *
 * `names` resolves principal ids to display names for notes (“Mara took over Run #1907.”).
 */
export function projectPlanStep(
  step: Pick<PlanStep, 'state'>,
  work: PlanStepWork,
  names: (id: string) => string = () => 'Someone',
): PlanStepProjection | null {
  const { run, approval, automationRun, dispatch } = work;
  if (run && !RUN_FINISHED.includes(run.status)) return fromRun(run, names);
  if (automationRun && !AUTOMATION_FINISHED.includes(automationRun.status))
    return fromAutomation(automationRun);
  if (approval) {
    const key = `approval:${approval.id}:${approval.step.state}:${approval.step.label}`;
    const note =
      approval.step.state === 'blocked'
        ? `Approval #${approval.number} was ${approval.step.label.toLowerCase()}. Ask again.`
        : approval.step.state === 'gate' && approval.step.label !== 'Approved'
          ? `Waiting for a person to decide approval #${approval.number}.`
          : null;
    return { followKey: key, state: approval.step.state, stateLabel: approval.step.label, note };
  }
  if (run) return fromRun(run, names);
  if (automationRun) return fromAutomation(automationRun);
  if (dispatch && !dispatch.hasRun) {
    const key = `dispatch:${dispatch.id}:${dispatch.state}`;
    switch (dispatch.state) {
      case 'queued':
        return { followKey: key, state: 'active', stateLabel: 'Asked', note: null };
      case 'claimed':
      case 'running':
        return { followKey: key, state: 'active', stateLabel: 'Working', note: null };
      case 'done':
        // The turn ended without a run. Only a step still in progress needs a look; one the agent already marked
        // done (or a person cancelled) stays.
        if (step.state !== 'active') return null;
        return {
          followKey: key,
          state: 'gate',
          stateLabel: 'Check result',
          note: 'The agent answered without finishing the step. Mark it done or ask again.',
        };
      case 'failed':
        return {
          followKey: key,
          state: 'blocked',
          stateLabel: 'Couldn’t start',
          note: 'The agent’s turn failed before it started work. Ask again.',
        };
      case 'cancelled':
        return {
          followKey: key,
          state: 'blocked',
          stateLabel: 'Stopped',
          note: 'The agent’s turn was stopped.',
        };
    }
  }
  return null;
}

function fromRun(run: NonNullable<PlanStepWork['run']>, names: (id: string) => string): PlanStepProjection {
  const followKey = `run:${run.id}:${run.status}`;
  switch (run.status) {
    case 'live':
      return { followKey, state: 'active', stateLabel: 'In progress', note: null };
    case 'paused':
      return {
        followKey,
        state: 'blocked',
        stateLabel: 'Paused',
        note: `Run #${run.number} is paused. Resume it or take over.`,
      };
    case 'done':
      return { followKey, state: 'done', stateLabel: 'Done', note: null };
    case 'failed':
      return {
        followKey,
        state: 'blocked',
        stateLabel: 'Run failed',
        note: `Run #${run.number} failed. Retry it.`,
      };
    case 'taken_over': {
      const who = run.takenOverById;
      return {
        followKey,
        state: 'active',
        stateLabel: 'Taken over',
        note: who ? `${names(who)} took over Run #${run.number}.` : `Run #${run.number} was taken over.`,
      };
    }
  }
}

function fromAutomation(r: NonNullable<PlanStepWork['automationRun']>): PlanStepProjection {
  const followKey = `automation:${r.id}:${r.status}`;
  switch (r.status) {
    case 'queued':
    case 'running':
    case 'waiting':
    case 'paused':
      return { followKey, state: 'active', stateLabel: 'Running', note: null };
    case 'succeeded':
      return { followKey, state: 'done', stateLabel: 'Done', note: null };
    case 'needs_review':
      return {
        followKey,
        state: 'gate',
        stateLabel: 'Needs review',
        note: `Automation run #${r.number} needs a person to review it.`,
      };
    case 'failed':
      return {
        followKey,
        state: 'blocked',
        stateLabel: 'Automation failed',
        note: `Automation run #${r.number} failed. Run it again.`,
      };
    case 'cancelled':
      return {
        followKey,
        state: 'blocked',
        stateLabel: 'Stopped',
        note: `Automation run #${r.number} was stopped.`,
      };
    case 'skipped':
      return {
        followKey,
        state: 'blocked',
        stateLabel: 'Skipped',
        note: `Automation run #${r.number} was skipped.`,
      };
  }
}

/**
 * Whether a projection should be written over the stored step (WS-05): only when the linked work changed since the
 * last one we applied, and never over a step someone finished or cancelled by hand for that same work.
 */
export function shouldApplyProjection(
  stored: Pick<PlanStep, 'state'> & { followKey?: string | null },
  projection: PlanStepProjection,
): boolean {
  if (stored.followKey === projection.followKey) return false;
  const sameLink = !!stored.followKey && linkOf(stored.followKey) === linkOf(projection.followKey);
  if (
    sameLink &&
    (stored.state === 'cancelled' || (stored.state === 'done' && projection.state !== 'done'))
  ) {
    // A person's (or the agent's) own "done" / "cancelled" for this work stands; a later failure of the same run
    // after someone marked the step done doesn't undo their decision.
    return false;
  }
  return true;
}

function linkOf(followKey: string): string {
  const [kind, id] = followKey.split(':');
  return `${kind}:${id}`;
}

/** The next action a step asks for, for the plan pane (WS-06, WS-09). */
export type PlanStepAction = 'start' | 'mark_done' | 'retry' | 'cancel' | 'open_work';

/**
 * A step the agent stopped at for a person's word, with no approval, run or automation run to decide it: its `retry`
 * reads “Go ahead”, and starting it tells the agent to carry on with it.
 */
export function stepGoesAhead(
  step: Pick<PlanStep, 'state' | 'approvalId' | 'runId' | 'automationRunId'>,
): boolean {
  return step.state === 'gate' && !step.approvalId && !step.runId && !step.automationRunId;
}

/**
 * How a step shows its actions: as buttons only where the person is needed (a step at a gate or blocked), plus the way
 * to its work; everything else (Start, Mark done, Cancel on a step the agent is getting to) in the step's menu, so a
 * plan the agent is carrying out reads as its progress, not as a set of controls.
 */
export function planStepControls(step: PlanStep): { buttons: PlanStepAction[]; more: PlanStepAction[] } {
  const actions = planStepActions(step);
  const needsPerson = step.state === 'gate' || step.state === 'blocked';
  const buttons: PlanStepAction[] = needsPerson
    ? actions.filter((a) => a !== 'cancel' && a !== 'mark_done')
    : actions.filter((a) => a === 'open_work');
  return { buttons, more: actions.filter((a) => !buttons.includes(a) && a !== 'open_work') };
}

/** Which actions make sense for a step, before permissions. */
export function planStepActions(step: PlanStep): PlanStepAction[] {
  switch (step.state) {
    case 'queued':
      return ['start', 'mark_done', 'cancel'];
    case 'active':
      return step.runId || step.automationRunId || step.dispatchId
        ? ['open_work', 'mark_done', 'cancel']
        : ['mark_done', 'cancel'];
    case 'gate':
      // Waiting on nothing but a person's word: “Go ahead” first (it asks the agent to carry on, `stepGoesAhead`).
      return stepGoesAhead(step) ? ['retry', 'mark_done', 'cancel'] : ['open_work', 'mark_done', 'cancel'];
    case 'blocked':
      return ['retry', 'open_work', 'cancel'];
    case 'done':
    case 'cancelled':
      return step.runId || step.approvalId || step.automationRunId ? ['open_work'] : [];
  }
}
