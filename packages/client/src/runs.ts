/**
 * Runs in chat, what web and mobile share: a run that needs a person (contracts CT-197; Whombat
 * docs/decisions/run-checkout.md RC-08…RC-13) and the run line (AP-668, AP-699). No DOM and no React Native here.
 */
import type { Run } from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { formatDuration } from '@whombat/core/text';
import { clientTree } from './i18n/catalog';
import { WORK_AREA_WORDS } from './i18n/messages/chatWork/work';

const words = (locale?: string | null) => clientTree(locale, WORK_AREA_WORDS).runs;

/** Shown before the server's sentence, in a locale: “Needs attention · Banjo stopped without finishing this run.” */
export function runAttentionLabel(locale?: string | null): string {
  return words(locale).attention;
}

/** Shown before the server's sentence: “Needs attention · Banjo stopped without finishing this run.” */
export const RUN_ATTENTION_LABEL = runAttentionLabel();

/**
 * Why a live run needs a person (`Run.attention`): the server's sentence as it is, or null when there is none, it is
 * blank, or the run is no longer live (AP-597).
 */
export function runAttention(run: Pick<Run, 'status' | 'attention'>): string | null {
  if (run.status !== 'live') return null;
  const text = run.attention?.trim();
  return text ? text : null;
}

/**
 * A run shows as one line under its message until it changes something (docs/decisions/run-line.md AP-668): no file
 * changed and no pull request. Asking an agent to check a branch is a question, not a card's worth of work; the
 * first changed file (or a pull request) turns the line into the full run card.
 */
export function runShowsAsLine(run: Pick<Run, 'diff' | 'prNumber'>): boolean {
  return run.diff.files === 0 && run.prNumber === null;
}

/** What a run line says: the lead (“Checking”, “Run #6 · Done in 1m 12s”), what it is on or found, and its tone. */
export interface RunLineText {
  lead: string;
  detail: string | null;
  tone: 'live' | 'warn' | 'ok' | 'bad' | 'mut';
}

/** `Run #6 · Done in 1m 12s` and friends; a live run is `Checking`, with its current step (or why it needs a person). */
export function runLineText(
  run: Pick<Run, 'number' | 'status' | 'activity' | 'summary' | 'attention' | 'startedAt' | 'finishedAt'>,
  locale?: string | null,
): RunLineText {
  const w = words(locale);
  const name = interpolate(w.name, { number: run.number });
  const took = run.finishedAt
    ? interpolate(w.tookIn, {
        time: formatDuration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime(), locale),
      })
    : '';
  const summary = run.summary?.trim() || null;
  switch (run.status) {
    case 'live': {
      const attention = runAttention(run);
      return attention
        ? { lead: w.attention, detail: attention, tone: 'warn' }
        : { lead: w.checking, detail: run.activity.trim() || null, tone: 'live' };
    }
    case 'paused':
      return { lead: interpolate(w.paused, { name }), detail: run.activity.trim() || null, tone: 'warn' };
    case 'done':
      return { lead: interpolate(w.done, { name, took }), detail: summary, tone: 'ok' };
    case 'failed':
      return {
        lead: interpolate(w.failed, { name, took }),
        detail: summary ?? (run.activity.trim() || null),
        tone: 'bad',
      };
    case 'taken_over':
      return { lead: interpolate(w.takenOver, { name }), detail: summary, tone: 'mut' };
  }
}

/** What a run line offers besides its text (docs/decisions/run-line.md AP-699). */
export interface RunLineControls {
  /**
   * “Watch run” while the run is live, also while it needs a person; “Open run” once nothing moves on it any more:
   * done, failed, taken over, or paused until someone resumes it on the run page. Always these English words, so a
   * screen can key its own label on them; `linkText` is the link in the locale asked for.
   */
  link: 'Watch run' | 'Open run';
  /** The link's words in the locale asked for (“Watch run”, “Uitvoering volgen”). */
  linkText: string;
  /** Try again on a failed run: the run page's Try again (AP-596). */
  retry: boolean;
}

/** The run line's link and whether it offers Try again (a failed run). */
export function runLineControls(run: Pick<Run, 'status'>, locale?: string | null): RunLineControls {
  const w = words(locale);
  const live = run.status === 'live';
  return {
    link: live ? 'Watch run' : 'Open run',
    linkText: live ? w.watch : w.open,
    retry: run.status === 'failed',
  };
}

/* Run controls (the run page's, web and phone: TODO 8.3, AP-596, AP-711) ---------------------------------------- */

/** What a person can do to a run: the run page's buttons, and Try again on a failed run's line or card. */
export type RunControlAction = 'pause' | 'resume' | 'take_over' | 'retry';

export interface RunControls {
  /** "Pause" while live, "Resume" while paused, none once the run has ended. */
  toggle: 'pause' | 'resume' | null;
  /** "Take over" while the agent still holds the branch (live or paused). */
  takeOver: boolean;
  /** "Try again" on a failed run (CT-197; AP-596). */
  retry: boolean;
}

export function runControls(status: Run['status']): RunControls {
  switch (status) {
    case 'live':
      return { toggle: 'pause', takeOver: true, retry: false };
    case 'paused':
      return { toggle: 'resume', takeOver: true, retry: false };
    case 'failed':
      return { toggle: null, takeOver: false, retry: true };
    default:
      return { toggle: null, takeOver: false, retry: false };
  }
}

/** The note after a run control went through (the mock has none; same short sentences as its other toasts). */
export function runActionToast(
  action: RunControlAction,
  agentName: string,
  branch: string,
  locale?: string | null,
): string {
  const t = words(locale).toast;
  switch (action) {
    case 'pause':
      return interpolate(t.pause, { agentName });
    case 'resume':
      return interpolate(t.resume, { agentName });
    case 'take_over':
      return interpolate(t.takeOver, { agentName, branch });
    case 'retry':
      return interpolate(t.retry, { agentName });
  }
}
