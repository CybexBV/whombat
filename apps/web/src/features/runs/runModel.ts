/**
 * Run page view model: everything the page derives from a `Run` (status → dot, controls, notice and the agent's face;
 * steps → timeline markers; log → visible lines and tones). Pure, so it is unit-tested and shared by
 * the page and its stories. Copy is verbatim from the mock where the mock shows it; the paused,
 * taken-over and failed notices are ours (docs/decisions/runs-approvals.md).
 */
import type { FaceState } from '@whombat/avatars/motion';
import { runAttention } from '@whombat/client';
import {
  formatClock,
  formatRunKicker,
  formatRunLabel,
  formatTestsPassing,
  logLineTone,
  RUN_LOG_VISIBLE_LINES,
  type Run,
  type RunLogLine,
  type RunStatus,
  type RunStep,
} from '@whombat/core';

/** Why a live run needs a person (CT-197, AP-597), and the controls a run offers (AP-711): shared with the phone. */
export { type RunControls, runAttention, runControls } from '@whombat/client';

export type Tone = 'ok' | 'warn' | 'bad' | 'mut';

/** Header dot: live = working green with the live halo (as the mock), then the state's tone. */
export interface RunDot {
  tone: 'live' | Tone;
  halo: boolean;
}

export function runDot(status: RunStatus): RunDot {
  switch (status) {
    case 'live':
      return { tone: 'live', halo: true };
    case 'done':
      return { tone: 'ok', halo: false };
    case 'paused':
      return { tone: 'warn', halo: false };
    case 'failed':
      return { tone: 'bad', halo: false };
    case 'taken_over':
      return { tone: 'mut', halo: false };
  }
}

/**
 * What the agent's face in the header shows: thinking until the run has started on something, working while it runs,
 * waiting for a person when the run needs one, glad once done and sorry when it failed. Paused or taken over, it rests.
 */
export function runFaceState(
  run: Pick<Run, 'status' | 'attention' | 'steps' | 'progress' | 'logCount'>,
): FaceState {
  switch (run.status) {
    case 'live': {
      if (runAttention(run)) return 'needs';
      const started = run.progress > 0 || run.logCount > 0 || run.steps.some((s) => s.state !== 'queued');
      return started ? 'working' : 'thinking';
    }
    case 'done':
      return 'done';
    case 'failed':
      return 'sorry';
    case 'paused':
    case 'taken_over':
      return 'idle';
  }
}

/** `git fetch origin feat/invoice-pdf && git switch feat/invoice-pdf` (the server's take-over answer). */
export function takeOverCommand(branch: string): string {
  return `git fetch origin ${branch} && git switch ${branch}`;
}

export interface NoticeNames {
  agent: string;
  /** Try again is offered on a failed run: the fallback note points to it instead of asking again (AP-596). */
  canRetry?: boolean;
  /** Short name of whoever paused / took over, or "you" handled by `viewerId`. */
  nameOf: (principalId: string) => string;
  viewerId: string | null;
}

export interface RunNotice {
  tone: Tone;
  text: string;
  /** Shell command to pick the branch up (taken over). */
  command?: string;
}

/** The quiet sf2 note under the header for paused, taken-over and failed runs; null otherwise. */
export function runNotice(run: Run, names: NoticeNames): RunNotice | null {
  const who = (id: string | null, sentenceStart: boolean) => {
    if (!id) return sentenceStart ? 'Someone' : 'someone';
    if (id === names.viewerId) return sentenceStart ? 'You' : 'you';
    return names.nameOf(id);
  };
  switch (run.status) {
    case 'paused':
      return {
        tone: 'warn',
        text: `${who(run.pausedById, true)} paused this run. ${names.agent} stopped where it was and picks up from the last step on Resume.`,
      };
    case 'taken_over': {
      const mine = run.takenOverById !== null && run.takenOverById === names.viewerId;
      return {
        tone: 'mut',
        text: mine
          ? `You took over ${run.branch}. ${names.agent} has stopped and won’t push to it again. Pick it up locally:`
          : `${who(run.takenOverById, true)} took over ${run.branch}. ${names.agent} has stopped and won’t push to it again.`,
        ...(mine && { command: takeOverCommand(run.branch) }),
      };
    }
    case 'failed':
      return {
        tone: 'bad',
        text:
          run.summary ??
          (names.canRetry
            ? `${names.agent} stopped after an error. Try again to give it another turn.`
            : `${names.agent} stopped after an error. Ask again to retry.`),
      };
    default:
      return null;
  }
}

/**
 * `RUN · LIVE · BANJO · STARTED 11:22`, split after the status label. The mock renders the label as its
 * own element inside the flex kicker, so the rest is a separate flex item: the space before the first `·`
 * collapses and the 8px gap stands in for it. The page does the same to stay pixel-identical.
 */
export function runKicker(run: Run, agentName: string, timeZone: string): [string, string] {
  const label = formatRunLabel(run.status);
  const full = formatRunKicker(run.status, agentName, run.startedAt, timeZone);
  return [label, full.slice(label.length)];
}

export interface TestsView {
  text: string;
  tone: 'ok' | 'warn';
}

/** LIVE LOG header: `38 of 41 passing` in warn, `41 of 41 passing` in ok. */
export function testsView(tests: Run['tests']): TestsView | null {
  if (!tests) return null;
  return {
    text: formatTestsPassing(tests),
    tone: tests.total > 0 && tests.passed === tests.total ? 'ok' : 'warn',
  };
}

export type StepMarker = 'done' | 'active' | 'paused' | 'stopped' | 'queued' | 'failed';

export interface StepView {
  key: string;
  title: string;
  detail: string;
  /** HH:MM once the step has started; empty while queued (as in the mock). */
  at: string;
  marker: StepMarker;
  /** Connector below the marker: ok when the step is done, line otherwise, none after the last step. */
  connector: 'ok' | 'line' | 'none';
  /** Screen-reader state ("Done", "In progress"…). */
  stateLabel: string;
}

const STEP_LABELS: Record<StepMarker, string> = {
  done: 'Done',
  active: 'In progress',
  paused: 'Paused',
  stopped: 'Stopped',
  queued: 'Queued',
  failed: 'Failed',
};

function marker(step: RunStep, status: RunStatus): StepMarker {
  if (step.state !== 'active') return step.state;
  if (status === 'paused') return 'paused';
  if (status === 'taken_over' || status === 'failed') return 'stopped';
  return 'active';
}

export function stepViews(run: Run, timeZone: string): StepView[] {
  return run.steps.map((step, i) => {
    const m = marker(step, run.status);
    return {
      key: `${i}-${step.title}`,
      title: step.title,
      detail: step.detail,
      at: step.at && step.state !== 'queued' ? formatClock(step.at, timeZone) : '',
      marker: m,
      connector: i === run.steps.length - 1 ? 'none' : step.state === 'done' ? 'ok' : 'line',
      stateLabel: STEP_LABELS[m],
    };
  });
}

export interface LogLineView {
  seq: number;
  at: string;
  text: string;
  tone: ReturnType<typeof logLineTone>;
}

/**
 * The last 12 lines, oldest first, bottom-anchored on the page. With `logCount` (the run's), lines at or
 * past it are dropped: they are left over from before a rewind (the demo replays the storyline with the
 * same sequence numbers), and every new line arrives with a `logCount` that covers it.
 */
export function visibleLog(
  log: readonly RunLogLine[],
  timeZone: string,
  logCount = Number.POSITIVE_INFINITY,
): LogLineView[] {
  return log
    .filter((l) => l.seq < logCount)
    .sort((a, b) => a.seq - b.seq)
    .slice(-RUN_LOG_VISIBLE_LINES)
    .map((l) => ({ seq: l.seq, at: formatClock(l.at, timeZone), text: l.text, tone: logLineTone(l.text) }));
}
