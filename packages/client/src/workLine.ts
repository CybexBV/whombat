/**
 * The line a thread's row says while work goes on from it: who is at work (a council, a checklist of tasks, T3 Code),
 * what they do now in a few words, how far along it is, and when it waits for the person; and the council card's steps.
 * Shared by web and mobile. Pure.
 */
import type {
  ChatThread,
  CouncilKind,
  CouncilStage,
  Handoff,
  ThreadWork,
  ThreadWorkMember,
} from '@whombat/core';
import { currentStep, handoffMinutes, pullRequestLabel, T3_CODE_NAME } from './handoff';
import { jobDoing } from './job';

/* The work line ----------------------------------------------------------------------------------------------------- */

/** How a row draws how far along the work is. */
export type WorkProgress =
  /** A bar of segments: `done` full, `working` breathing, the rest empty. */
  | { kind: 'steps'; done: number; working: number; total: number }
  /** Work with no count (T3 Code): a soft sweep says it moves. */
  | { kind: 'sweep' }
  | null;

export interface WorkLine {
  /** `Council`, `Tasks`, `T3 Code`: the first word, a little stronger. */
  who: string;
  /** After it: `2 of 3 answered`, `running the tests`, `needs your go-ahead`. */
  text: string;
  /** `warn`: it waits for the person (amber); `live`: at work; `calm`: waits for something else. */
  tone: 'live' | 'warn' | 'calm';
  /** The clock's start (`12m`); null without one. */
  since: number | null;
  progress: WorkProgress;
  /** A council's members, its marks in the row. */
  members: readonly ThreadWorkMember[];
  /** Every word once, for a screen reader: “Council, 2 of 3 answered, 12 minutes”. */
  spoken: string;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** A council's stage, as its row says it. */
function councilText(w: Extract<ThreadWork, { kind: 'council' }>): { text: string; tone: WorkLine['tone'] } {
  const count = w.of ? `${w.answered} of ${w.of} answered` : null;
  switch (w.stage) {
    case 'research':
      return { text: count ?? 'looking at it', tone: 'live' };
    case 'agree':
      return { text: ['agreeing on a plan', count].filter(Boolean).join(' · '), tone: 'live' };
    case 'approve':
      return { text: 'needs your go-ahead', tone: 'warn' };
    case 'build':
      return { text: 'building it', tone: 'live' };
    case 'check':
      return { text: ['checking the result', count].filter(Boolean).join(' · '), tone: 'live' };
    default:
      return { text: 'finished', tone: 'calm' };
  }
}

/** What T3 Code does now, in a few words: its step, else its state. */
export function handoffDoing(h: Handoff): { text: string; tone: WorkLine['tone'] } {
  switch (h.state) {
    case 'needs_ok':
      return { text: 'needs your OK', tone: 'warn' };
    case 'asked':
      return { text: 'asked a question', tone: 'live' };
    case 'checks': {
      const doing = jobDoing(h);
      if (doing) return { text: doing, tone: 'calm' };
      const prs = h.pullRequests.map(pullRequestLabel).filter((l): l is string => !!l);
      return {
        text: prs.length ? `waiting for the checks on ${prs.join(', ')}` : 'waiting for the checks',
        tone: 'calm',
      };
    }
    case 'finishing':
      return { text: 'finishing up', tone: 'live' };
    case 'ended':
      return { text: 'finished', tone: 'calm' };
    default: {
      // A failed check it fixes, else the step it is on now.
      const doing = jobDoing(h);
      if (doing) return { text: doing, tone: 'live' };
      const step = currentStep(h);
      return { text: step ? lowerFirst(step.text) : 'working on it', tone: 'live' };
    }
  }
}

function spokenOf(who: string, text: string, since: number | null, nowMs: number): string {
  const minutes = since !== null ? Math.max(1, Math.floor((nowMs - since) / 60_000)) : null;
  return [who, text, minutes ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : null]
    .filter(Boolean)
    .join(', ');
}

/**
 * The work line of a thread's row, or null when nothing goes on from it. A council or checklist (`thread.work`) comes
 * before a lone T3 Code hand-over; whatever waits for the person wins. `handoffs`: the thread's own (`threadHandoffs`).
 */
export function threadWorkLine(
  thread: Pick<ChatThread, 'work'>,
  handoffs: readonly Handoff[],
  nowMs: number,
): WorkLine | null {
  const w = thread.work ?? null;
  const active = handoffs.filter((h) => h.state !== 'ended');
  const handoff = active.find((h) => h.state === 'needs_ok') ?? active[0] ?? null;
  if (w?.kind === 'council') {
    const { text, tone } = councilText(w);
    const since = ms(w.since);
    return {
      who: 'Council',
      text,
      tone,
      since: tone === 'warn' ? null : since,
      progress:
        w.of && (w.stage === 'research' || w.stage === 'agree' || w.stage === 'check')
          ? { kind: 'steps', done: w.answered, working: w.of - w.answered, total: w.of }
          : w.stage === 'build'
            ? { kind: 'sweep' }
            : null,
      members: w.members,
      spoken: spokenOf('Council', text, tone === 'warn' ? null : since, nowMs),
    };
  }
  if (w?.kind === 'tasks' && w.offered) {
    // Offered, waiting for the person's Hand over: nothing works yet, so no clock and no progress.
    const text = `waiting for your hand-over · ${w.total} ${w.total === 1 ? 'task' : 'tasks'}`;
    return {
      who: 'Tasks',
      text,
      tone: 'warn',
      since: null,
      progress: null,
      members: [],
      spoken: spokenOf('Tasks', text, null, nowMs),
    };
  }
  if (w?.kind === 'tasks') {
    const count = `${w.done} of ${w.total} done`;
    const text = w.needsYou ? `needs your OK · ${count}` : count;
    const since = ms(w.since);
    return {
      who: 'Tasks',
      text,
      tone: w.needsYou ? 'warn' : 'live',
      since,
      progress: w.total ? { kind: 'steps', done: w.done, working: w.working, total: w.total } : null,
      members: [],
      spoken: spokenOf('Tasks', text, since, nowMs),
    };
  }
  if (handoff) {
    const { text, tone } = handoffDoing(handoff);
    const doing = active.length > 1 && tone !== 'warn' ? `${text} · ${active.length} jobs` : text;
    const since = tone === 'live' ? ms(handoff.since) : null;
    return {
      who: T3_CODE_NAME,
      text: doing,
      tone,
      since,
      progress: tone === 'live' ? { kind: 'sweep' } : null,
      members: [],
      spoken: spokenOf(T3_CODE_NAME, doing, since, nowMs),
    };
  }
  return null;
}

/** The work line's clock: `12m`, `1h 05m`. */
export const workClock = (fromMs: number, nowMs: number): string => handoffMinutes(fromMs, nowMs);

/* The council card's steps ------------------------------------------------------------------------------------------ */

/**
 * The steps on a council's card, by what it does: an improve council looks, plans, waits for the go-ahead, builds and
 * checks; a research council researches and agrees on one answer; a review is one round and has no steps to show.
 */
const COUNCIL_STEPS: Record<CouncilKind, readonly (readonly [string, CouncilStage])[]> = {
  improve: [
    ['Look', 'research'],
    ['Plan', 'agree'],
    ['Go-ahead', 'approve'],
    ['Build', 'build'],
    ['Check', 'check'],
  ],
  research: [
    ['Research', 'research'],
    ['Agree', 'agree'],
  ],
  review: [],
};

/** The steps a council of this kind goes through; none for a review. */
export function councilSteps(kind: CouncilKind): string[] {
  return COUNCIL_STEPS[kind].map(([word]) => word);
}

/** Which of its steps a council is on (its number of steps: all done; -1: stopped, or a stage it has no step for). */
export function councilStepIndex(stage: CouncilStage, kind: CouncilKind = 'improve'): number {
  const steps = COUNCIL_STEPS[kind];
  if (stage === 'done') return steps.length;
  if (stage === 'stopped') return -1;
  return steps.findIndex(([, s]) => s === stage);
}
