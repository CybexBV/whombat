import { z } from 'zod';
import { BurrowId, ConversationId, DispatchId, MessageId, PrincipalId, RunId, RunnerId } from '../ids.js';
import { redactSecrets } from '../skills/secrets.js';
import { Timestamp } from './common.js';

/** Why an agent was woken up. */
export const DispatchTrigger = z.enum([
  'mention',
  'dm',
  'search',
  'approval_declined',
  /**
   * A turn the agent scheduled for itself (Whombat resourceful-agents.md RA-30, 0.44.0): in the schedule's conversation
   * and thread, for the person it was made for, with `DispatchContext.schedule`. It can't wait for answers: it does what
   * it can, posts what it found and asks once when it needs a person.
   */
  'schedule',
  'run_control',
  /** An automation's `dispatch_agent` step (docs/decisions/bp-automations.md). */
  'automation',
  /** A person asked for the detail an agent's short reply left out (docs/decisions/concise-replies.md). */
  'expand',
  /** A Whombat Feedback report's restricted, read-only assessment (docs/decisions/feedback.md FB-20, FB-21). */
  'feedback',
  /**
   * A person said yes to an approval the agent asked for (0.26, CT-168): the agent is woken in the approval's
   * conversation and thread, for the person the asking turn was for, with `DispatchContext.grantedApproval`, and may now
   * do what was approved (push the branch, carry on with a `custom` ask).
   */
  'approval_granted',
  /** “Try again” on a failed turn (0.26, CT-167): same agent, conversation, thread, trigger message and person. */
  'retry',
  /**
   * A background job of the agent's woke it (`whombat notify`, RA-31, 0.44.0; since 3.0 through `runner.notify`): in the
   * conversation and thread of the turn that started the job, with `DispatchContext.notify`.
   */
  'notify',
  /**
   * A person pressed Undo on a change the agent reported with `report_change` and an `undo` (Whombat home-redesign.md
   * HR-03, 0.91.0): the turn runs in the change's chat, for that person; its trigger message is the person's “Please
   * undo this: …”, and `DispatchContext.undoRequest` carries the private note. Server and runner only: clients see it
   * as `mention` (`summaryTrigger`).
   */
  'undo_requested',
  /**
   * Server tasks this agent started ended (Whombat task-feedback.md TF-12, 0.116.0, CT-883): the agent is woken in the
   * task's thread, for the person it was started for, with `DispatchContext.taskFinished` (the tasks that ended, at most
   * `TASK_FINISHED_MAX`; tasks ending while the turn is still queued join it), and tells the person how it went in its own
   * words, offering the next step it can take. Server and runner only: clients see it as `notify` (`summaryTrigger`), a
   * background job that reported back.
   */
  'task_finished',
  /**
   * A server, connection or device needed a look and Whombat asked the assistant to look into it by itself (3.5; Whombat
   * look-research.md LR-01, LR-05): in a thread of the person's Chat that its own line opened, for the person, with
   * `DispatchContext.look`. It finds out what is wrong and ends with `look_report`. Server and runner only: clients see
   * it as `notify` (`summaryTrigger`), something that woke the assistant by itself.
   */
  'look',
  /**
   * The person pressed the step the assistant offered on a look (3.5; look-research.md LR-08): their “Go ahead: …” in
   * the look's thread is its trigger message and `DispatchContext.look.step` the step, which the assistant takes, checks
   * and reports with `look_report`. Server and runner only: clients see it as `mention`, a person's message.
   */
  'look_fix',
  /**
   * A T3 Code thread the agent handed work to finished or asks something (Whombat t3code.md): in the thread
   * of the turn that handed it over, for the same person, with `DispatchContext.t3Threads` (what each thread did or
   * asks; threads moving on while the turn is still queued join it). Server and runner only: clients see it as `notify`
   * (`summaryTrigger`), work of the agent's that reported back.
   */
  't3_thread',
  /**
   * Members of a council the agent leads answered, or its builder finished (Whombat council.md CNL-41): in the council's
   * thread, for its person, with `DispatchContext.council`; answers coming in while the turn is still queued join it.
   * Server and runner only: clients see it as `notify` (`summaryTrigger`).
   */
  'council',
  /**
   * Tasks the agent handed to T3 Code ended (Whombat delegate.md): in the delegation's thread, for its person, with
   * `DispatchContext.delegation`; tasks ending while the turn is still queued join it. Server and runner only: clients
   * see it as `notify` (`summaryTrigger`).
   */
  'delegation',
  /**
   * Looks ahead (Whombat looks-ahead.md): Whombat has the assistant check something on the person's calendar the
   * afternoon before, quietly, with `DispatchContext.ahead`. It reads only the calendar, the mail and public web pages,
   * says nothing unless it found something, and ends with `ahead_report`. Server and runner only: clients see it as
   * `notify` (`summaryTrigger`).
   */
  'ahead',
]);
export type DispatchTrigger = z.infer<typeof DispatchTrigger>;

/**
 * The triggers clients read in a `DispatchSummary` (0.91, CT-406). `undo_requested`, `task_finished`, `look`,
 * `look_fix`, `t3_thread`, `council`, `delegation` and `ahead` stay between the server and the runner; `summaryTrigger` names them for clients.
 */
export const SummaryTrigger = DispatchTrigger.exclude([
  'undo_requested',
  'task_finished',
  'look',
  'look_fix',
  't3_thread',
  'council',
  'delegation',
  'ahead',
]);
export type SummaryTrigger = z.infer<typeof SummaryTrigger>;

/**
 * A trigger as clients see it (CT-406): an Undo request is a person's message in the chat, `mention`; a task that ended
 * (0.116, CT-883) is a background job that reported back, `notify`; a look the assistant looks into by itself (3.5) and
 * a T3 Code thread that moved on are `notify` too, and the step the person let it take (3.5) their message, `mention`.
 */
export function summaryTrigger(trigger: DispatchTrigger): SummaryTrigger {
  if (trigger === 'undo_requested' || trigger === 'look_fix') return 'mention';
  if (
    trigger === 'task_finished' ||
    trigger === 'look' ||
    trigger === 't3_thread' ||
    trigger === 'council' ||
    trigger === 'delegation' ||
    trigger === 'ahead'
  )
    return 'notify';
  return trigger;
}

/**
 * Why a turn failed for good (0.26, CT-167), for the `turn_failed` card and the Work view: `signin` (Claude or Codex
 * isn't set up or signed in for the person), `usage_limit` (the subscription's limit; the reset time when known),
 * `provider` (the provider errored or is unavailable), `refused` (the model declined the request's content — a safety
 * or content filter — so rewording or another model is the way forward, not the same request again), `sandbox` (the
 * sandbox or workspace couldn't start, e.g. a read-only path), `timeout` (the wall time), `runner` (no runner, or the
 * lease was lost), `workspace` (git or the checkout), `internal` (anything else).
 */
export const TurnFailureCode = z.enum([
  'signin',
  'usage_limit',
  'provider',
  'refused',
  'sandbox',
  'timeout',
  'runner',
  'workspace',
  'internal',
]);
export type TurnFailureCode = z.infer<typeof TurnFailureCode>;

/**
 * Whether “Try again” can help a turn that failed with this code: it re-sends the same request, so a model that
 * declined the content (`refused`) would only decline again — reword it or switch models instead. Every other code is
 * fixed by waiting, signing in or trying again, so the retry stands.
 */
export function turnFailureRetryable(code: TurnFailureCode): boolean {
  return code !== 'refused';
}

/** Longest public failure sentence (the card's `reason`). */
export const TURN_FAILURE_REASON_MAX = 200;
/** Longest technical detail the person sees in the Work view (redacted, `turnFailureDetail`). */
export const TURN_FAILURE_DETAIL_MAX = 2000;

/** A failed turn's classification and its readable, safe sentence (no paths, secrets or stack traces). */
export const TurnFailure = z.object({
  code: TurnFailureCode,
  reason: z.string().min(1).max(TURN_FAILURE_REASON_MAX),
});
export type TurnFailure = z.infer<typeof TurnFailure>;

/**
 * What the runner tells the server about a failed turn (`CompleteBody.failure`, CT-167): its classification and, for
 * `usage_limit`, when the limit resets. The server writes the sentence (`turnFailureText`).
 */
export const TurnFailureReport = z.object({
  code: TurnFailureCode,
  resetsAt: Timestamp.nullable().optional(),
});
export type TurnFailureReport = z.infer<typeof TurnFailureReport>;

/**
 * The technical detail of a failure (CT-167): secrets redacted (`redactSecrets`), control
 * characters dropped, at most {@link TURN_FAILURE_DETAIL_MAX} characters (the end kept, where errors say what broke).
 * Null for an empty text. Never shown in the channel.
 */
export function turnFailureDetail(raw: string | null | undefined): string | null {
  const text = redactSecrets(String(raw ?? ''))
    // biome-ignore lint/suspicious/noControlCharactersInRegex: dropping control characters is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  if (!text) return null;
  return text.length > TURN_FAILURE_DETAIL_MAX ? `…${text.slice(-(TURN_FAILURE_DETAIL_MAX - 1))}` : text;
}

/* Notify (Whombat resourceful-agents.md RA-31; contracts 0.44.0) -------------------------------------------------- */

/** `whombat notify "<text>"`: at most this many characters (RA-31). */
export const NOTIFY_TEXT_MAX = 2000;
/** Notifies an agent may send in an hour; more are refused. */
export const NOTIFY_PER_HOUR_MAX = 10;
/** A turn id (`WHOMBAT_TURN`) older than this is refused, as is another agent's. */
export const NOTIFY_TURN_MAX_AGE_DAYS = 7;
/** The environment variable that carries the turn's dispatch id into every command of the turn (OP-07). */
export const NOTIFY_TURN_ENV = 'WHOMBAT_TURN';
/**
 * A notice's own id (`runner.notify`, 3.0, CT-1538): the runner names each `whombat notify` once; the same id again is
 * the same notice.
 */
export const NotifyEventId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export type NotifyEventId = z.infer<typeof NotifyEventId>;

export const DispatchState = z.enum(['queued', 'claimed', 'running', 'done', 'failed', 'cancelled']);
export type DispatchState = z.infer<typeof DispatchState>;

/** What the agent is expected to produce: a chat reply, a search answer, or run work. */
export const DispatchMode = z.enum(['reply', 'answer', 'run']);
export type DispatchMode = z.infer<typeof DispatchMode>;

export const Dispatch = z.object({
  id: DispatchId,
  burrowId: BurrowId,
  agentId: PrincipalId,
  trigger: DispatchTrigger,
  mode: DispatchMode,
  conversationId: ConversationId,
  /** The message that triggered the dispatch (the mention / DM). */
  messageId: MessageId.nullable(),
  threadRootId: MessageId.nullable(),
  /** Run being resumed or controlled (`run_control`). */
  runId: RunId.nullable(),
  state: DispatchState,
  /** The Hermes session to resume (`hermes:<id>`, Whombat hermes-engine.md HE-S26). */
  providerSessionId: z.string().max(200).nullable(),
  runnerId: RunnerId.nullable(),
  /**
   * Claims so far. With `runnerId` it names the lease a runner holds: the runner sends both back on
   * progress / complete, and a runner that lost the lease (requeued, claimed again) changes nothing.
   */
  attempts: z.number().int().nonnegative().optional(),
  error: z.string().max(2000).nullable(),
  createdAt: Timestamp,
  claimedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  /**
   * When the turn first posted (a message, card or answer), over all its attempts; set by the server. A turn
   * retried after it posted (the runner restarted, crashed or lost its lease) carries on from there instead of
   * answering the trigger again (docs/decisions/turn-retries.md).
   */
  postedAt: Timestamp.nullable().default(null),
});
export type Dispatch = z.infer<typeof Dispatch>;
