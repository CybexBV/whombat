/**
 * Failed turns on the phone (Whombat essentials item 4; contracts CT-167; AP-500, AP-501): the `turn_failed` card's
 * view — the failure's short state, its safe sentence, “Try again” for a person, “Tried again · 14:32” for everyone
 * once pressed — and what a refused retry says (the server decides who may: the person the turn was for, or an owner). Pure, so the rules are unit-tested; the
 * screen adds the runtime's `dispatches.retry` feature, and the shared `useRetryTurn` puts the retry in the cache.
 */
import { ApiError, type CommitResult, problemText } from '@whombat/client';
import {
  canRetryTurn,
  canStopTurn,
  TURN_FAILURE_LABELS,
  TURN_STOP_LABEL,
  type TurnFailedCard,
  turnFailureRetryable,
  turnRetriedText,
} from '@whombat/core';

export interface TurnFailedView {
  dispatchId: string;
  agentId: string;
  agentName: string;
  /** `NOT SIGNED IN`, `USAGE LIMIT`… (mono, uppercase like the other card labels). */
  label: string;
  /** Bad until someone tried again; then quiet. */
  tone: 'bad' | 'neutral';
  /** The safe sentence; null when the message's own text already says it (it is the failure message). */
  reason: string | null;
  /** The viewer gets “Try again” (not retried yet, a person, the runtime can retry). */
  canRetry: boolean;
  /** `Tried again · 14:32` once anyone pressed it; null before. */
  retried: string | null;
  /** What TalkBack reads for the card: “Dusty couldn’t finish. Not signed in. I couldn’t start because…”. */
  accessibilityLabel: string;
}

export interface TurnFailedContext {
  /** The message's own text (the runtime posts the sentence as the text too). */
  text: string;
  agent: { name: string } | undefined;
  viewer: { id: string; kind: 'person' | 'agent' | 'system' } | undefined;
  /** The runtime advertises `dispatches.retry` (always true over the legacy server and in the demo world). */
  retryFeature: boolean;
  timeZone: string;
}

/** “Not signed in” for TalkBack (the labels are written in capitals for the eye). */
function spoken(label: string): string {
  return label.charAt(0) + label.slice(1).toLowerCase();
}

export function turnFailedView(card: TurnFailedCard, ctx: TurnFailedContext): TurnFailedView {
  const label = TURN_FAILURE_LABELS[card.code] ?? TURN_FAILURE_LABELS.internal;
  const agentName = ctx.agent?.name ?? 'The agent';
  const reason = ctx.text.trim() === card.reason.trim() ? null : card.reason;
  const retried = card.retriedAt ? turnRetriedText(card.retriedAt, ctx.timeZone) : null;
  const canRetry = ctx.retryFeature && turnFailureRetryable(card.code) && canRetryTurn(card, ctx.viewer);
  return {
    dispatchId: card.dispatchId,
    agentId: card.agentId,
    agentName,
    label,
    tone: retried ? 'neutral' : 'bad',
    reason,
    canRetry,
    retried,
    accessibilityLabel: [`${agentName} couldn’t finish`, spoken(label), reason, retried]
      .filter(Boolean)
      .join('. '),
  };
}

/** “Asked Dusty to try again.” after a retry went through. */
export function retriedNotice(agentName: string): string {
  return `Asked ${agentName} to try again.`;
}

/**
 * What a retry that didn't happen says (the server's words when it gave some). The runtime's 409 — the person the turn
 * was for left — is final: the card keeps the words and loses the button (`isFinal`).
 */
export function retryFailureText(result: CommitResult<unknown> | Error): string {
  if (result instanceof ApiError) return problemText(result);
  if (result instanceof Error) return 'Couldn’t reach Whombat. Nothing changed, try again.';
  if (result.status === 'blocked') return `This needs “${result.keyNeeded.label}”.`;
  if (result.status === 'pending_approval') return 'That needs a person to approve it first.';
  return '';
}

/** A refusal that won't change on another press (409): the button goes. */
export function isFinalRetryRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

/* Stop (contracts 0.55, CT-295; MX-09) ---------------------------------------------------------------------------- */

/**
 * Whether the agent's thinking line offers Stop to the viewer: the agent thinking with its turn named
 * (`typing.dispatchId`), and core's rule (`canStopTurn`: the person; the server decides again). The thinking line can't
 * tell a run's turn: the server answers that one “Pause the run instead.”.
 */
export function offersStop(input: {
  typing: { dispatchId?: string | undefined };
  viewer: { id: string; kind: 'person' | 'agent' | 'system' } | undefined;
}): boolean {
  if (!input.typing.dispatchId) return false;
  return canStopTurn({ state: 'running', runId: null }, input.viewer);
}

/** Asked before stopping: what was being done is left where it is. */
export function stopConfirm(agentName: string): { title: string; body: string; cta: string } {
  return {
    title: `Stop ${agentName}?`,
    body: `${agentName} stops what it’s doing here now. You can ask again.`,
    cta: TURN_STOP_LABEL,
  };
}
