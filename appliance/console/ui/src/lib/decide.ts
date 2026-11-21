/**
 * Answering an ask on the screen (Whombat DK-05, DK-61, DK-62, TF-14; appliance CG-193, CG-281): what the page sends
 * `POST /api/desk/decide` and what it answered, as the sheet acts on it. Whombat decides whether the screen may; the
 * page shows its answers.
 */
import { type ChoiceScope, deskErrorCode, talkIdOf } from './desk';

export type Decision = 'approve' | 'decline' | 'deny';
/** How far an approve reaches (0.116 `DESK_DECIDE_SCOPES`): once, or one of the ask's wider choices. */
export const DECIDE_SCOPES = ['once', 'task', 'agent'] as const;
export type DecideScope = (typeof DECIDE_SCOPES)[number];

/**
 * Whether a decision needs the PIN typed again (the contracts' `deskDecideNeedsPin`, DK-62, TF-14): an approve of an
 * ask with `approveWithPin`, or an approve with a scope wider than once. Deny and Not now never do.
 */
export function decideNeedsPin(
  ask: { approveWithPin?: boolean },
  request: { decision: Decision; scope?: DecideScope },
): boolean {
  if (request.decision !== 'approve') return false;
  return ask.approveWithPin === true || (request.scope !== undefined && request.scope !== 'once');
}

/**
 * The body the page sends (CG-281): the PIN when typed, a wider choice's scope only with approve (the contracts'
 * `deskDecideRequestValid`); approving once sends no scope, as before 0.116, so an older runtime takes it.
 */
export function decideBody(
  number: number,
  decision: Decision,
  o: { pin?: string; scope?: ChoiceScope } = {},
): { number: number; decision: Decision; pin?: string; scope?: ChoiceScope } {
  return {
    number,
    decision,
    ...(o.pin === undefined ? {} : { pin: o.pin }),
    ...(o.scope === undefined || decision !== 'approve' ? {} : { scope: o.scope }),
  };
}

export type DecideAnswer =
  /** Done; `talk` follows the assistant's next words after a decision in the conversation (DK-63). */
  | { result: 'decided'; talk: string | null }
  /** A risky ask's PIN was wrong, or the wait after five (DK-62). */
  | { result: 'wrong'; triesLeft: number | null }
  | { result: 'backoff'; retryAt: string | null }
  /** 403 `pin_needed`: Approve needs the PIN typed again. */
  | { result: 'pinNeeded' }
  /** 403 `on_phone`: the phone only (an older runtime, or a screen without a PIN). */
  | { result: 'onPhone' }
  /** 403 `not_offered` (0.116, TF-14): the choice isn't the person's to make here, or not any more; nothing decided. */
  | { result: 'notOffered' }
  /** 404 or 409 `decided`: answered somewhere else. */
  | { result: 'gone' }
  | { result: 'locked' }
  | { result: 'failed' };

/** The console server's answer to a decision; a runtime from before 0.108 answers `{v: 1}`, which is decided. */
export function parseDecideAnswer(status: number, body: unknown): DecideAnswer {
  const code = deskErrorCode(body);
  if (status === 403)
    return code === 'pin_needed'
      ? { result: 'pinNeeded' }
      : code === 'not_offered'
        ? { result: 'notOffered' }
        : { result: 'onPhone' };
  if (status === 404 || code === 'decided') return { result: 'gone' };
  if (status === 409 && code === 'locked') return { result: 'locked' };
  if (status !== 200 || typeof body !== 'object' || body === null) return { result: 'failed' };
  const b = body as Record<string, unknown>;
  if (b.result === undefined || b.result === 'decided') return { result: 'decided', talk: talkIdOf(b.talk) };
  if (b.result === 'wrong') {
    const t = b.triesLeft;
    return {
      result: 'wrong',
      triesLeft: typeof t === 'number' && Number.isFinite(t) ? Math.max(0, Math.floor(t)) : null,
    };
  }
  if (b.result === 'backoff')
    return { result: 'backoff', retryAt: typeof b.retryAt === 'string' ? b.retryAt : null };
  return { result: 'failed' };
}
