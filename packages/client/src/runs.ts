/**
 * Runs in chat, what web and mobile share: a run that needs a person (contracts CT-197; Whombat
 * docs/decisions/run-checkout.md RC-08…RC-13) and the run line (AP-668, AP-699). No DOM and no React Native here.
 */
import type { Run } from '@whombat/core/domain';
import { formatDuration } from '@whombat/core/text';

/** Shown before the server's sentence: “Needs attention · Banjo stopped without finishing this run.” */
export const RUN_ATTENTION_LABEL = 'Needs attention';

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
): RunLineText {
  const name = `Run #${run.number}`;
  const took = run.finishedAt
    ? ` in ${formatDuration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime())}`
    : '';
  const summary = run.summary?.trim() || null;
  switch (run.status) {
    case 'live': {
      const attention = runAttention(run);
      return attention
        ? { lead: RUN_ATTENTION_LABEL, detail: attention, tone: 'warn' }
        : { lead: 'Checking', detail: run.activity.trim() || null, tone: 'live' };
    }
    case 'paused':
      return { lead: `${name} · Paused`, detail: run.activity.trim() || null, tone: 'warn' };
    case 'done':
      return { lead: `${name} · Done${took}`, detail: summary, tone: 'ok' };
    case 'failed':
      return {
        lead: `${name} · Failed${took}`,
        detail: summary ?? (run.activity.trim() || null),
        tone: 'bad',
      };
    case 'taken_over':
      return { lead: `${name} · Taken over`, detail: summary, tone: 'mut' };
  }
}

/** What a run line offers besides its text (docs/decisions/run-line.md AP-699). */
export interface RunLineControls {
  /**
   * “Watch run” while the run is live, also while it needs a person; “Open run” once nothing moves on it any more:
   * done, failed, taken over, or paused until someone resumes it on the run page.
   */
  link: 'Watch run' | 'Open run';
  /** Try again on a failed run: the run page's Try again (AP-596). */
  retry: boolean;
}

/** The run line's link and whether it offers Try again (a failed run). */
export function runLineControls(run: Pick<Run, 'status'>): RunLineControls {
  return {
    link: run.status === 'live' ? 'Watch run' : 'Open run',
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
export function runActionToast(action: RunControlAction, agentName: string, branch: string): string {
  switch (action) {
    case 'pause':
      return `Paused. ${agentName} stopped where it was.`;
    case 'resume':
      return `Resumed. ${agentName} picks up where it left off.`;
    case 'take_over':
      return `You have ${branch} now. ${agentName} has stopped.`;
    case 'retry':
      return `Asked ${agentName} to try again.`;
  }
}
