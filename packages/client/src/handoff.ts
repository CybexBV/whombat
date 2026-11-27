/**
 * Work the agent handed to T3 Code, in words (Whombat t3code.md T3-24…T3-28; docs/app/decisions/t3code-handoff.md
 * AP-6610…AP-6617): what a thread's reply row says while T3 Code works on it, and the line at the thread's end with what
 * it does now. Shared by web and mobile. Pure, no DOM and no React Native.
 */
import type { Handoff, HandoffStep } from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import { formatDuration } from '@whombat/core/text';
import { clientTree } from './i18n/catalog';
import { WORK_AREA_WORDS } from './i18n/messages/chatWork/work';

const words = (locale?: string | null) => clientTree(locale, WORK_AREA_WORDS).handoff;

/** The program's name, beside its mark. */
export const T3_CODE_NAME = 'T3 Code';

/** The hand-over's few fixed words (open it, its steps), in a locale (English when none). */
export function handoffWords(locale?: string | null) {
  const w = words(locale);
  return { openInT3Code: w.open, showSteps: w.showSteps, hideSteps: w.hideSteps, answering: w.answering };
}

export const OPEN_IN_T3_CODE = handoffWords().openInT3Code;
export const SHOW_STEPS = handoffWords().showSteps;
export const HIDE_STEPS = handoffWords().hideSteps;

const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

const pad2 = (n: number) => String(n).padStart(2, '0');

/** A reply row's clock: `6m`, `1h 05m` (at least a minute: the row isn't a stopwatch). */
export function handoffMinutes(fromMs: number, nowMs: number): string {
  const minutes = Math.max(1, Math.floor((nowMs - fromMs) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${pad2(minutes % 60)}m`;
}

/** Ended work shows in a thread's rows at most this long (the box keeps a job with its receipt for days). */
export const HANDOFF_ENDED_SHOWN_MS = 30 * 60_000;

/**
 * The hand-overs of one Whombat thread that show: those from it, without an ended one the thread had a reply after (the
 * agent's answer says how it went) or, given `nowMs`, one that ended more than half an hour ago.
 */
export function threadHandoffs(
  handoffs: readonly Handoff[],
  rootId: string | null,
  lastReplyAt: string | null,
  nowMs?: number,
): Handoff[] {
  const last = ms(lastReplyAt);
  return handoffs.filter((h) => {
    if (h.rootId !== rootId) return false;
    if (h.state !== 'ended') return true;
    const ended = ms(h.endedAt);
    if (nowMs !== undefined && ended !== null && nowMs - ended > HANDOFF_ENDED_SHOWN_MS) return false;
    return last === null || ended === null || last < ended;
  });
}

/** A job's hand-overs, ended ones too (its receipt): the job view's, latest last. */
export const jobHandoffs = (handoffs: readonly Handoff[], rootId: string | null): Handoff[] =>
  handoffs.filter((h) => h.rootId === rootId);

/** `#342` from a pull request's address (or the `#342` T3 Code gave); null when it has no number. */
export function pullRequestLabel(pr: string): string | null {
  if (/^#\d+$/.test(pr)) return pr;
  const m = /\/pull\/(\d+)/.exec(pr);
  return m ? `#${m[1]}` : null;
}

const checksOn = (h: Handoff, locale?: string | null): string => {
  const labels = h.pullRequests.map(pullRequestLabel).filter((l): l is string => !!l);
  const w = words(locale);
  return labels.length ? interpolate(w.checksOn, { prs: labels.join(', ') }) : w.checks;
};

/**
 * What a thread's reply row says: `T3 Code` (with its mark) and the rest, or null when nothing is going on there. A
 * permission it waits for comes first; two or more at work are counted.
 */
export interface HandoffRow {
  /** After `T3 Code`: `is working on it`, `needs your OK`, `· 2 jobs`. */
  text: string;
  /** `warn`: it waits for the person; `calm`: it waits for checks, nothing to do. */
  tone: 'live' | 'warn' | 'calm';
  /** The clock's start (`· 6m` after the words); null without one. */
  since: number | null;
}

export function handoffRow(shown: readonly Handoff[], locale?: string | null): HandoffRow | null {
  const active = shown.filter((h) => h.state !== 'ended');
  const first = active[0];
  if (!first) return null;
  const w = words(locale);
  if (active.some((h) => h.state === 'needs_ok')) return { text: w.needsOk, tone: 'warn', since: null };
  if (active.length > 1) {
    const starts = active.map((h) => ms(h.since)).filter((t): t is number => t !== null);
    return {
      text: interpolate(w.jobs, { count: active.length }),
      tone: 'live',
      since: starts.length ? Math.min(...starts) : null,
    };
  }
  switch (first.state) {
    case 'working':
      return { text: w.working, tone: 'live', since: ms(first.since) };
    case 'finishing':
      return { text: w.finishing, tone: 'live', since: null };
    case 'asked':
      return { text: w.asked, tone: 'live', since: null };
    default:
      return { text: checksOn(first, locale), tone: 'calm', since: null };
  }
}

/** The reply row's words while the agent answers T3 Code's question there. */
export const ANSWERING_T3_CODE = handoffWords().answering;

/** The step T3 Code is on: its last one not done, else its last. */
export function currentStep(h: Pick<Handoff, 'steps'>): HandoffStep | null {
  return [...h.steps].reverse().find((s) => !s.done) ?? h.steps.at(-1) ?? null;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The line at the end of a thread for one hand-over. */
export interface HandoffLine {
  title: string;
  /** Under the title: what it does now, what it asks, what to do. */
  now: string | null;
  /** `done`: its work ended (one quiet line, no box). */
  tone: 'live' | 'warn' | 'calm' | 'done';
  /** The mark breathes: something happens there now. */
  live: boolean;
  /** The ticking clock's start; null without one. */
  clockFrom: number | null;
  /** The folded details' first line: its title in T3 Code and the program it runs on. */
  meta: string;
  /** Whether there are steps to fold out. */
  hasSteps: boolean;
}

export function handoffLine(h: Handoff, agentName: string, locale?: string | null): HandoffLine {
  const w = words(locale);
  const t3 = T3_CODE_NAME;
  const step = currentStep(h);
  const meta = [h.title, h.program].filter(Boolean).join(' · ');
  const base = { meta, hasSteps: h.steps.length > 0, clockFrom: null, live: false };
  const doing = step ? interpolate(w.now, { step: lowerFirst(step.text) }) : null;
  switch (h.state) {
    case 'working':
      return {
        ...base,
        title: interpolate(w.lineWorking, { t3 }),
        now: doing,
        tone: 'live',
        live: true,
        clockFrom: ms(h.since),
      };
    case 'finishing':
      return { ...base, title: interpolate(w.lineFinishing, { t3 }), now: doing, tone: 'live', live: true };
    case 'asked':
      return {
        ...base,
        title: interpolate(w.lineAsked, { t3, agentName }),
        now: h.asks,
        tone: 'live',
        live: true,
      };
    case 'needs_ok':
      return {
        ...base,
        title: interpolate(w.lineNeedsOk, { t3 }),
        now: h.asks ? interpolate(w.approveAsks, { t3, asks: h.asks }) : interpolate(w.approve, { t3 }),
        tone: 'warn',
      };
    case 'checks':
      return {
        ...base,
        title: interpolate(w.lineChecks, { t3, checks: checksOn(h, locale) }),
        now: interpolate(w.hears, { agentName }),
        tone: 'calm',
      };
    default:
      return { ...base, title: endedWords(h, locale), now: null, tone: 'done' };
  }
}

/** `T3 Code finished in 14m`, `T3 Code ran into a problem after 3m`, `T3 Code was stopped`. */
export function endedWords(
  h: Pick<Handoff, 'outcome' | 'since' | 'endedAt'>,
  locale?: string | null,
): string {
  const w = words(locale);
  const t3 = T3_CODE_NAME;
  if (h.outcome === 'stopped') return interpolate(w.stopped, { t3 });
  const from = ms(h.since);
  const to = ms(h.endedAt);
  const took = from !== null && to !== null && to > from ? handoffMinutes(from, to) : null;
  if (h.outcome === 'failed')
    return took ? interpolate(w.problemAfter, { t3, took }) : interpolate(w.problem, { t3 });
  return took ? interpolate(w.finishedIn, { t3, took }) : interpolate(w.finished, { t3 });
}

/** The line's clock: `6m 12s` (`formatDuration`). */
export const handoffClock = (fromMs: number, nowMs: number, locale?: string | null): string =>
  formatDuration(nowMs - fromMs, locale);
