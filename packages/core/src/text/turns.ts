/**
 * What a failed turn says (0.26, CT-167): one readable, safe sentence per `TurnFailureCode` — no paths, secrets or stack
 * traces — for the agent's failure message and its `turn_failed` card, and the labels of the card and the Work view.
 * The runtime writes it; web and mobile show the same labels.
 */
import type { TurnFailureCode } from '../domain/dispatch.js';
import { TURN_FAILURE_REASON_MAX } from '../domain/dispatch.js';
import { coreTranslator } from '../i18n/catalog.js';
import { type DateInput, formatClock } from './time.js';
import { formatResetTime } from './usage.js';

const KNOWN_PROVIDERS = new Set(['claude', 'codex', 'local']);

export interface TurnFailureTextOptions {
  /** The agent's provider (`claude`, `codex`, …); unnamed when absent or unknown. */
  provider?: string | null;
  /** `usage_limit`: when the limit resets. */
  resetsAt?: DateInput | null;
  /** For the reset time: now and the reader's zone (the burrow's when the message is for everyone). */
  now?: DateInput;
  timeZone?: string;
  /** The reader's language (English when absent). */
  locale?: string | null;
}

/**
 * The sentence for a failed turn: “I couldn’t start because Claude isn’t signed in for this. Sign in under Settings → AI,
 * then press Try again.” At most `TURN_FAILURE_REASON_MAX` characters.
 */
export function turnFailureText(code: TurnFailureCode, options: TurnFailureTextOptions = {}): string {
  const tr = coreTranslator(options.locale);
  const known = options.provider && KNOWN_PROVIDERS.has(options.provider) ? options.provider : null;
  const name = known ? tr.t(`turn.provider.${known as 'claude' | 'codex' | 'local'}`) : undefined;
  const provider = name ?? tr.t('turn.provider.unknown');
  let text: string;
  switch (code) {
    case 'signin':
      text = tr.t('turn.signin', { provider });
      break;
    case 'usage_limit': {
      const limit =
        name && options.provider !== 'local' ? tr.t('turn.namedLimit', { name }) : tr.t('turn.limit');
      if (options.resetsAt && options.timeZone) {
        const at = formatResetTime(
          options.resetsAt,
          options.now ?? new Date(),
          options.timeZone,
          options.locale,
        );
        const when = /^\d{2}:\d{2}$/.test(at) ? tr.t('turn.atTime', { time: at }) : at;
        text = tr.t('turn.usageLimitWhen', { limit, when });
      } else text = tr.t('turn.usageLimit', { limit });
      break;
    }
    case 'provider':
      text = tr.t('turn.provider', { provider });
      break;
    case 'refused':
    case 'sandbox':
    case 'timeout':
    case 'runner':
    case 'workspace':
      text = tr.t(`turn.${code}`);
      break;
    default:
      text = tr.t('turn.internal');
  }
  return text.length > TURN_FAILURE_REASON_MAX ? `${text.slice(0, TURN_FAILURE_REASON_MAX - 1)}…` : text;
}

const TURN_FAILURE_CODES: readonly TurnFailureCode[] = [
  'signin',
  'usage_limit',
  'provider',
  'refused',
  'sandbox',
  'timeout',
  'runner',
  'workspace',
  'internal',
];

/** The Work view's and the card's short state per code, in a locale. */
export function turnFailureLabels(locale?: string | null): Record<TurnFailureCode, string> {
  const tr = coreTranslator(locale);
  return Object.fromEntries(TURN_FAILURE_CODES.map((c) => [c, tr.t(`turn.label.${c}`)])) as Record<
    TurnFailureCode,
    string
  >;
}

/** The Work view's and the card's short state per code (mono, uppercase like the other pills). */
export const TURN_FAILURE_LABELS: Record<TurnFailureCode, string> = turnFailureLabels('en');

/** The card's button, and what it says once pressed (by anyone). */
export const TURN_RETRY_LABEL = 'Try again';
export const TURN_RETRIED_LABEL = 'Tried again';

/** The retry button's words in a locale. */
export function turnRetryLabel(locale?: string | null): string {
  return coreTranslator(locale).t('turn.retry');
}

/** “Tried again · 14:32”: the card's state after a retry, in the reader's zone. */
export function turnRetriedText(retriedAt: DateInput, timeZone: string, locale?: string | null): string {
  const tr = coreTranslator(locale);
  return tr.t('turn.retriedAt', { label: tr.t('turn.retried'), time: formatClock(retriedAt, timeZone) });
}

/* Stop a turn (0.55, CT-295, Whombat RF-01) ------------------------------------------------------------------- */

/** The button on “{name} is thinking”, in the profile pane's RIGHT NOW and on a Work item (`stop_turn`). */
export const TURN_STOP_LABEL = 'Stop';

/** The stop button's words in a locale. */
export function turnStopLabel(locale?: string | null): string {
  return coreTranslator(locale).t('turn.stop');
}

/** `DispatchSummary.reason` of a turn a person stopped: “Stopped by Mara”. */
export function turnStoppedText(name: string, locale?: string | null): string {
  return coreTranslator(locale).t('turn.stoppedBy', { name });
}

/** `dispatches.cancel` on a run's turn answers 409 with this: a run is paused, not stopped (the run line has Pause). */
export const TURN_STOP_RUN_REFUSAL = 'Pause the run instead.';

/**
 * `DispatchSummary.reason` of a follow-up dispatch whose message was added to the agent's running turn instead
 * (steering, 0.55, CT-305): the queued turn is `cancelled` with this reason once the runner delivered the message.
 * Stored and compared as is, so it stays English.
 */
export const TURN_MERGED_REASON = 'Answered in the running turn';
