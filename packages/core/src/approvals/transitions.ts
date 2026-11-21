/**
 * Approval transitions. Pure: each returns a new approval or an error; the server applies them inside
 * the commit pipeline and signs an event for each.
 *
 *   pending ──approve──▶ approved ──(all conditions met)──▶ executing ──▶ executed
 *      │                    │  ▲                                 └──▶ failed
 *      │                    └──┘ undo (until executed; a failed run is retried by undo + approve)
 *      └──decline──▶ declined ──undo──▶ pending
 */
import type { Approval } from '../domain/approval.js';
import { readyToExecute, refreshMet } from './conditions.js';

export type ApprovalError =
  | 'not_pending'
  | 'not_decided'
  | 'already_executed'
  | 'executing'
  | 'agents_cannot_decide'
  | 'not_ready'
  | 'not_running';

export type TransitionResult =
  | { ok: true; approval: Approval }
  | { ok: false; error: ApprovalError; message: string };

export interface Decider {
  id: string;
  kind: 'person' | 'agent';
}

const MESSAGES: Record<ApprovalError, string> = {
  not_pending: 'This request has already been decided.',
  not_decided: 'There is no decision to undo.',
  already_executed: 'It already happened, so it can’t be undone.',
  executing: 'It is happening right now, so it can’t be undone.',
  agents_cannot_decide: 'Only a person can decide this.',
  not_ready: 'Not every condition is met yet.',
  not_running: 'Nothing is running for this request.',
};

function fail(error: ApprovalError): TransitionResult {
  return { ok: false, error, message: MESSAGES[error] };
}

function ok(approval: Approval): TransitionResult {
  return { ok: true, approval: refreshMet(approval) };
}

/**
 * The person decides (since 3.0 there is one, Whombat one-person.md OP-03, CT-1517: no approvers to choose, no owners
 * overriding, no private approvals). Agents never decide.
 */
export function canDecide(_approval: Approval, actor: Decider): ApprovalError | null {
  return actor.kind === 'person' ? null : 'agents_cannot_decide';
}

/** Approve (possibly in advance). The executor runs once every other condition is met. */
export function approve(approval: Approval, actor: Decider, at: string): TransitionResult {
  if (approval.state !== 'pending') return fail('not_pending');
  const denied = canDecide(approval, actor);
  if (denied) return fail(denied);
  return ok({ ...approval, state: 'approved', decidedById: actor.id, decidedAt: at });
}

/** Decline. The requester and involved agents are told (a message + dispatch). */
export function decline(approval: Approval, actor: Decider, at: string): TransitionResult {
  if (approval.state !== 'pending') return fail('not_pending');
  const denied = canDecide(approval, actor);
  if (denied) return fail(denied);
  return ok({ ...approval, state: 'declined', decidedById: actor.id, decidedAt: at });
}

/** Why Undo is unavailable, or null when it is available. */
export function undoBlock(approval: Approval): ApprovalError | null {
  if (approval.state === 'pending') return 'not_decided';
  // A command runs (or is refused) the moment a person answers (agent-computer.md AC-41).
  if (approval.action.type === 'run_command') return 'already_executed';
  if (approval.executedAt !== null || approval.execution.state === 'succeeded') return 'already_executed';
  if (approval.execution.state === 'running') return 'executing';
  return null;
}

/** Undo returns to pending; only until the action has executed (DECISIONS B-02). */
export function undo(approval: Approval, actor: Decider, _at: string): TransitionResult {
  const blocked = undoBlock(approval);
  if (blocked) return fail(blocked);
  if (actor.kind !== 'person') return fail('agents_cannot_decide');
  return ok({
    ...approval,
    state: 'pending',
    decidedById: null,
    decidedAt: null,
    execution: { ...approval.execution, state: 'idle', error: null },
  });
}

/** Executor starts the action. Allowed when approved, every condition met, and not yet executed. */
export function startExecution(approval: Approval, at: string): TransitionResult {
  if (!readyToExecute(approval))
    return fail(approval.execution.state === 'running' ? 'executing' : 'not_ready');
  return ok({
    ...approval,
    execution: {
      state: 'running',
      startedAt: at,
      finishedAt: null,
      durationMs: null,
      resultUrl: null,
      error: null,
    },
  });
}

/**
 * What an executor reports. `durationMs` is the action's own measured duration (a deploy workflow's run
 * time); without it the duration is the wall-clock time between start and completion.
 */
export type ExecutionOutcome =
  | { ok: true; resultUrl?: string | null; durationMs?: number }
  | { ok: false; error: string; durationMs?: number };

/** Executor reports the result. Success sets `executedAt`. */
export function completeExecution(
  approval: Approval,
  at: string,
  outcome: ExecutionOutcome,
): TransitionResult {
  if (approval.execution.state !== 'running') return fail('not_running');
  const startedAt = approval.execution.startedAt;
  const durationMs =
    outcome.durationMs !== undefined
      ? Math.max(0, Math.round(outcome.durationMs))
      : startedAt
        ? Math.max(0, Date.parse(at) - Date.parse(startedAt))
        : null;
  if (outcome.ok) {
    return ok({
      ...approval,
      executedAt: at,
      execution: {
        ...approval.execution,
        state: 'succeeded',
        finishedAt: at,
        durationMs,
        resultUrl: outcome.resultUrl ?? null,
        error: null,
      },
    });
  }
  return ok({
    ...approval,
    execution: { ...approval.execution, state: 'failed', finishedAt: at, durationMs, error: outcome.error },
  });
}
