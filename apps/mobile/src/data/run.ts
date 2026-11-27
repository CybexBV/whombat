/**
 * Run screen view model (not mocked on mobile; the desktop run page's content in the inbox's language):
 * label and dot, title, the agent and where it was asked, progress with "Now: …" and tests, the steps
 * and the last log lines. Pure, so it is unit-tested.
 */

import {
  agentFaceOf,
  type CommitResult,
  type RunControlAction,
  runAttention,
  runControls,
} from '@whombat/client';
import {
  type AgentFace,
  conversationLabel,
  formatAdditions,
  formatClock,
  formatDeletions,
  formatRunLabel,
  formatTestsPassing,
  logLineTone,
  type Run,
  type RunDetail,
  type RunStatus,
  type RunStep,
  runNowText,
  shortNameOf,
} from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';
import type { ViewContext } from './people';

/** The log card shows the last 8 lines (the desktop page shows 12 on a wider screen). */
export const RUN_MOBILE_LOG_LINES = 8;

export type RunDot = 'live' | 'ok' | 'warn' | 'bad' | 'mut';
export type StepMarker = 'done' | 'active' | 'paused' | 'stopped' | 'queued' | 'failed';

export interface RunStepView {
  key: string;
  title: string;
  detail: string;
  /** HH:MM once started; empty while queued. */
  at: string;
  marker: StepMarker;
  /** Connector under the marker: ok after a done step, line otherwise, none after the last. */
  connector: 'ok' | 'line' | 'none';
  /** Screen-reader state. */
  stateLabel: string;
}

export interface RunLogView {
  seq: number;
  at: string;
  text: string;
  tone: ReturnType<typeof logLineTone>;
}

export interface RunScreenModel {
  number: number;
  /** `RUN · LIVE` */
  label: string;
  dot: RunDot;
  title: string;
  agentName: string;
  /** The face the agent wears (OA-08); null when it isn't the agent's run (nothing to draw). */
  agentFace: AgentFace | null;
  /** `Banjo · #billing-v2 · 11:22` (the approval screen's context line). */
  context: string;
  /** `Asked by Waffle in #billing-v2` */
  askedBy: string;
  branch: string;
  progress: number;
  /** `Now: Rounding VAT before formatting`, or the summary once done. */
  now: string;
  tests: { text: string; tone: 'ok' | 'warn' } | null;
  /** `+214` `−12` `· 6 files` (additions in ok, deletions in bad). */
  diff: { add: string; del: string; files: string } | null;
  steps: RunStepView[];
  log: RunLogView[];
  live: boolean;
  /** Why a live run needs a person, the server's sentence (`Run.attention`, CT-197; AP-597); null otherwise. */
  attention: string | null;
}

function stepLabels(locale?: string): Record<StepMarker, string> {
  const { t } = mobileTranslator(locale);
  return {
    done: t('data.run.step.done'),
    active: t('data.run.step.active'),
    paused: t('data.run.step.paused'),
    stopped: t('data.run.step.stopped'),
    queued: t('data.run.step.queued'),
    failed: t('data.run.step.failed'),
  };
}

function dotFor(status: RunStatus): RunDot {
  switch (status) {
    case 'live':
      return 'live';
    case 'done':
      return 'ok';
    case 'paused':
      return 'warn';
    case 'failed':
      return 'bad';
    case 'taken_over':
      return 'mut';
  }
}

function markerFor(step: RunStep, status: RunStatus): StepMarker {
  if (step.state !== 'active') return step.state;
  if (status === 'paused') return 'paused';
  if (status === 'taken_over' || status === 'failed') return 'stopped';
  return 'active';
}

export function runScreen(detail: RunDetail, ctx: ViewContext, where?: string): RunScreenModel {
  const { run } = detail;
  const { locale } = ctx;
  const { t, tp } = mobileTranslator(locale);
  const STEP_LABELS = stepLabels(locale);
  const agent = ctx.people.get(run.agentId);
  const agentName = agent ? shortNameOf(agent) : t('data.turns.theAgent');
  const asker = ctx.people.get(run.askedById);
  const askerName =
    run.askedById === ctx.viewer.id ? t('data.run.you') : asker ? shortNameOf(asker) : t('data.run.someone');
  const place = where ?? conversationLabel(detail.conversation);
  const log = detail.log
    .filter((l) => l.seq < run.logCount)
    .sort((a, b) => a.seq - b.seq)
    .slice(-RUN_MOBILE_LOG_LINES)
    .map((l) => ({
      seq: l.seq,
      at: formatClock(l.at, ctx.timeZone),
      text: l.text,
      tone: logLineTone(l.text),
    }));
  return {
    number: run.number,
    label: formatRunLabel(run.status, locale),
    dot: dotFor(run.status),
    title: run.title,
    agentName,
    agentFace: agent?.kind === 'agent' ? agentFaceOf(agent) : null,
    context: [agentName, place, formatClock(run.startedAt, ctx.timeZone)].filter(Boolean).join(' · '),
    askedBy: place
      ? t('data.run.askedByIn', { who: askerName, place })
      : t('data.run.askedBy', { who: askerName }),
    branch: run.branch,
    progress: run.status === 'done' ? 100 : Math.max(0, Math.min(100, run.progress)),
    now: runNowText(run, locale),
    tests: run.tests
      ? {
          text: formatTestsPassing(run.tests, locale),
          tone: run.tests.total > 0 && run.tests.passed === run.tests.total ? 'ok' : 'warn',
        }
      : null,
    diff:
      run.diff.files > 0
        ? {
            add: formatAdditions(run.diff.add),
            del: formatDeletions(run.diff.del),
            files: `· ${tp('data.messages.files', run.diff.files)}`,
          }
        : null,
    steps: run.steps.map((step, i) => {
      const marker = markerFor(step, run.status);
      return {
        key: `${i}-${step.title}`,
        title: step.title,
        detail: step.detail,
        at: step.at && step.state !== 'queued' ? formatClock(step.at, ctx.timeZone) : '',
        marker,
        connector: i === run.steps.length - 1 ? 'none' : step.state === 'done' ? 'ok' : 'line',
        stateLabel: STEP_LABELS[marker],
      };
    }),
    log,
    live: run.status === 'live' || run.status === 'paused',
    attention: runAttention(run),
  };
}

/* Controls (AP-711) ---------------------------------------------------------------------------------------------- */

/** A control under the run screen's progress card: Pause or Resume, Try again, Take over (asks first, as the web). */
export interface RunControlButton {
  action: RunControlAction;
  label: string;
  variant: 'primary' | 'secondary';
  confirm: { title: string; body: string; cta: string } | null;
}

/**
 * The run page's controls (`runControls`, the web's rule): Pause while live, Resume while paused, Take over while the
 * agent holds the branch, Try again on a failed run. There is no separate Stop:
 * Pause stops the agent where it is, Take over stops it for good and hands the branch over.
 */
export function runControlButtons(
  run: Pick<Run, 'status' | 'branch'>,
  agentName: string,
  locale?: string,
): RunControlButton[] {
  const { t } = mobileTranslator(locale);
  const c = runControls(run.status);
  const out: RunControlButton[] = [];
  if (c.toggle)
    out.push({
      action: c.toggle,
      label: c.toggle === 'pause' ? t('data.run.pause') : t('data.run.resume'),
      variant: 'secondary',
      confirm: null,
    });
  if (c.retry)
    out.push({ action: 'retry', label: t('data.run.tryAgain'), variant: 'secondary', confirm: null });
  if (c.takeOver)
    out.push({
      action: 'take_over',
      label: t('data.run.takeOver'),
      variant: 'primary',
      // The web's take-over dialog, in an alert.
      confirm: {
        title: t('data.run.takeOverTitle', { agent: agentName }),
        body: t('data.run.takeOverBody', { agent: agentName, branch: run.branch }),
        cta: t('data.run.takeOver'),
      },
    });
  return out;
}

/** A control the keys engine didn't let through: its own sentence (the web's toast), null when it went through. */
export function runControlRefusal(result: CommitResult<unknown>, locale?: string): string | null {
  if (result.status === 'blocked') return result.message;
  if (result.status === 'pending_approval') return mobileTranslator(locale).t('data.run.needsApproval');
  return null;
}

/**
 * A run's branch room: the room it was asked in when that is its pull request's, else the room of its pull request and
 * branch, else the only room with that number. Two repositories can both have a #42: a number alone never picks one of
 * them (as `branchRoomFor`), so the run's pull request and branch room aren't another repository's.
 */
export function runBranchRoom<R extends { id: string; prNumber: number | null; branch: string }>(
  rooms: readonly R[],
  run: Pick<Run, 'prNumber' | 'branch' | 'conversationId'>,
): R | null {
  if (!run.prNumber) return null;
  const same = rooms.filter((r) => r.prNumber === run.prNumber);
  const asked = same.find((r) => r.id === run.conversationId);
  if (asked) return asked;
  const branch = same.filter((r) => r.branch === run.branch);
  if (branch.length === 1) return branch[0] ?? null;
  return same.length === 1 ? (same[0] ?? null) : null;
}
