/**
 * What a failed turn says (0.26, CT-167): one readable, safe sentence per `TurnFailureCode` — no paths, secrets or stack
 * traces — for the agent's failure message and its `turn_failed` card, and the labels of the card and the Work view.
 * The runtime writes it; web and mobile show the same labels.
 */
import type { TurnFailureCode } from '../domain/dispatch.js';
import { TURN_FAILURE_REASON_MAX } from '../domain/dispatch.js';
import { type DateInput, formatClock } from './time.js';
import { formatResetTime } from './usage.js';

/** The provider a turn ran on, as people know it (`codex` is ChatGPT, CT-1450). */
const PROVIDER_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'ChatGPT',
  local: 'the model on your network',
};

export interface TurnFailureTextOptions {
  /** The agent's provider (`claude`, `codex`, …); unnamed when absent or unknown. */
  provider?: string | null;
  /** `usage_limit`: when the limit resets. */
  resetsAt?: DateInput | null;
  /** For the reset time: now and the reader's zone (the burrow's when the message is for everyone). */
  now?: DateInput;
  timeZone?: string;
}

/**
 * The sentence for a failed turn: “I couldn’t start because Claude isn’t signed in for this. Sign in under Settings → AI,
 * then press Try again.” At most `TURN_FAILURE_REASON_MAX` characters.
 */
export function turnFailureText(code: TurnFailureCode, options: TurnFailureTextOptions = {}): string {
  const name = options.provider ? PROVIDER_NAMES[options.provider] : undefined;
  const provider = name ?? 'the AI provider';
  let text: string;
  switch (code) {
    case 'signin':
      text = `I couldn’t start because ${provider} isn’t set up or signed in for this. Sign in under Settings → AI sign-in, then press Try again.`;
      break;
    case 'usage_limit': {
      const limit = name && options.provider !== 'local' ? `the ${name} usage limit` : 'the usage limit';
      if (options.resetsAt && options.timeZone) {
        const at = formatResetTime(options.resetsAt, options.now ?? new Date(), options.timeZone);
        const when = /^\d{2}:\d{2}$/.test(at) ? `at ${at}` : at;
        text = `I stopped because ${limit} was reached. It resets ${when}; press Try again after that.`;
      } else text = `I stopped because ${limit} was reached. Press Try again once it resets.`;
      break;
    }
    case 'provider':
      text = `I stopped because ${provider} returned an error or isn’t available right now. Press Try again in a few minutes.`;
      break;
    case 'refused':
      text =
        'The model wouldn’t answer this one. Try rewording your request, or switch models for this chat, then send it again.';
      break;
    case 'sandbox':
      text =
        'I couldn’t get started. Press Try again; if it keeps happening, restarting your Whombat usually fixes it.';
      break;
    case 'timeout':
      text = 'This took too long, so I stopped. Press Try again, or ask for a smaller piece.';
      break;
    case 'runner':
      text = 'I was interrupted before I could finish. Press Try again.';
      break;
    case 'workspace':
      text =
        'I couldn’t open the code project. Press Try again; if it keeps failing, check GitHub under Settings → Connections.';
      break;
    default:
      text = 'Something went wrong on my side, so I stopped. Press Try again.';
  }
  return text.length > TURN_FAILURE_REASON_MAX ? `${text.slice(0, TURN_FAILURE_REASON_MAX - 1)}…` : text;
}

/** The Work view's and the card's short state per code (mono, uppercase like the other pills). */
export const TURN_FAILURE_LABELS: Record<TurnFailureCode, string> = {
  signin: 'NOT SIGNED IN',
  usage_limit: 'USAGE LIMIT',
  provider: 'AI SERVICE PROBLEM',
  refused: 'MODEL DECLINED',
  sandbox: 'COULDN’T START',
  timeout: 'TOOK TOO LONG',
  runner: 'INTERRUPTED',
  workspace: 'PROJECT PROBLEM',
  internal: 'FAILED',
};

/** The card's button, and what it says once pressed (by anyone). */
export const TURN_RETRY_LABEL = 'Try again';
export const TURN_RETRIED_LABEL = 'Tried again';

/** “Tried again · 14:32”: the card's state after a retry, in the reader's zone. */
export function turnRetriedText(retriedAt: DateInput, timeZone: string): string {
  return `${TURN_RETRIED_LABEL} · ${formatClock(retriedAt, timeZone)}`;
}

/* Stop a turn (0.55, CT-295, Whombat RF-01) ------------------------------------------------------------------- */

/** The button on “{name} is thinking”, in the profile pane's RIGHT NOW and on a Work item (`stop_turn`). */
export const TURN_STOP_LABEL = 'Stop';

/** `DispatchSummary.reason` of a turn a person stopped: “Stopped by Mara”. */
export function turnStoppedText(name: string): string {
  return `Stopped by ${name}`;
}

/** `dispatches.cancel` on a run's turn answers 409 with this: a run is paused, not stopped (the run line has Pause). */
export const TURN_STOP_RUN_REFUSAL = 'Pause the run instead.';

/**
 * `DispatchSummary.reason` of a follow-up dispatch whose message was added to the agent's running turn instead
 * (steering, 0.55, CT-305): the queued turn is `cancelled` with this reason once the runner delivered the message.
 */
export const TURN_MERGED_REASON = 'Answered in the running turn';
