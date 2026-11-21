/**
 * One layout for the cards in a thread (docs/decisions/chat-threads-cards.md): a status line (a mark, a word, the
 * time), a plain title, one sentence, the main button and at most two others in a fixed place, and every technical word
 * under one Details. This module says what each card's status line, title and sentence are, from the card's own data;
 * web and phone draw them. Pure.
 */
import type {
  CouncilCard,
  CouncilRoundResult,
  DelegationCard,
  DelegationCardTask,
  Plan,
  PlanStep,
  Run,
} from '@whombat/core';
import { runNowText } from '@whombat/core/text';
import { COUNCIL_WORDS, councilStageLine } from './council';
import { DELEGATION_WORDS } from './delegation';

/**
 * The status line's mark: a dot waiting for the person, an open ring at work, the branch arrow when handed over, a
 * tick done, a square stopped, a ring with a bar where it didn't finish, a hollow circle not started.
 */
export type CardMark = 'waiting' | 'working' | 'handedOver' | 'done' | 'stopped' | 'failed' | 'queued';

export const CARD_FRAME_WORDS = {
  details: 'Details',
  showMore: 'Show more',
  showLess: 'Show less',
  /** A plan's step the card names (the plan's own words for the step under it). */
  currentStep: 'Current step',
  blockedStep: 'Blocked step',
  /** What kind of card it is, after the status word: “Done · Council”. */
  kinds: { plan: 'Plan', council: 'Council', delegation: 'Tasks', run: 'Run' },
  marks: {
    waiting: 'Waiting for you',
    working: 'Working',
    handedOver: 'Handed over',
    done: 'Done',
    stopped: 'Stopped',
    failed: 'Didn’t finish',
    queued: 'Not started yet',
  } satisfies Record<CardMark, string>,
  /** A plan's status while the assistant carries it out. */
  planWorking: (assistant: string) => `${assistant} is working`,
  planBlocked: 'Blocked',
  /** A plan's sentence: “Now: build the export endpoint.” */
  planNow: (step: string) => `Now: ${lowerFirst(step)}.`,
  planNext: (step: string) => `Next: ${lowerFirst(step)}.`,
  planGate: (step: string) => `Waiting for your go on “${step}”.`,
  planStuck: (step: string) => `Stuck on “${step}”.`,
  /** The council's final card: the button that opens its answers. */
  readAnswers: 'Read the answers',
  hideAnswers: 'Hide the answers',
  answers: 'The answers',
  /** A delegation's button that opens its tasks' records. */
  openTasks: 'Open tasks',
  tasks: 'Task records and pull requests',
  /** The AI each task takes, under the checklist's Details. */
  aiPerTask: 'Which AI does each task',
  /** A handed-over checklist's headline: “2 finished · 6 still in progress”. */
  tasksProgress: (finished: number, open: number) =>
    [finished ? `${finished} finished` : null, open ? `${open} still in progress` : null]
      .filter(Boolean)
      .join(' · ') || 'Nothing handed over',
  /** An offered list's last change, under its title. */
  changed: (said: readonly string[]) => `Changed: ${said.map(lowerFirst).join(' · ')}.`,
  /** A run's facts under Details. */
  run: (n: number) => `Run #${n}`,
  runTerm: 'Run',
  branch: 'Branch',
} as const;

/** What a card's head says. */
export interface CardFrame {
  mark: CardMark;
  /** The status word: “Waiting for you”, “Neo is working”, “Done”. */
  word: string;
  /** What kind of card: “Plan”, “Council”, “Tasks”, “Run”. */
  kind: string;
  /** The time the status line ends with (the card's own time), or null. */
  at: string | null;
  title: string;
  /** A short result line in words above the sentence (a council's “All three agree.”), or null. */
  headline: string | null;
  /** One sentence of what and why, or null. */
  sentence: string | null;
  /** What the last change did, under the title: “Changed: took off “A search box” · moved “Plainer words” to 1.” */
  changed?: string | null;
  /** For screen readers: the status, the title and the sentence. */
  label: string;
}

function capitalFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lowerFirst(s: string): string {
  // “PDF export” keeps its capitals: only a word whose second letter is small turns small.
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function frame(parts: Omit<CardFrame, 'label'>): CardFrame {
  return {
    ...parts,
    label: [`${parts.word} · ${parts.kind}`, parts.title, parts.changed, parts.headline, parts.sentence]
      .filter(Boolean)
      .join('. '),
  };
}

/* Plans ------------------------------------------------------------------------------------------------------- */

/** The step a plan's card names: the one waiting for the person, else the blocked one, else the one at work. */
export interface PlanFocus {
  step: PlanStep;
  /** “Current step” or “Blocked step”. */
  label: string;
  kind: 'gate' | 'blocked' | 'active';
}

export function planFocus(plan: Pick<Plan, 'steps'>): PlanFocus | null {
  const gate = plan.steps.find((s) => s.state === 'gate');
  if (gate) return { step: gate, label: CARD_FRAME_WORDS.blockedStep, kind: 'gate' };
  const blocked = plan.steps.find((s) => s.state === 'blocked');
  if (blocked) return { step: blocked, label: CARD_FRAME_WORDS.blockedStep, kind: 'blocked' };
  const active = plan.steps.find((s) => s.state === 'active');
  if (active) return { step: active, label: CARD_FRAME_WORDS.currentStep, kind: 'active' };
  return null;
}

export function planFrame(plan: Pick<Plan, 'title' | 'steps' | 'updatedAt'>, assistant: string): CardFrame {
  const focus = planFocus(plan);
  const base = { kind: CARD_FRAME_WORDS.kinds.plan, at: plan.updatedAt, title: plan.title, headline: null };
  if (focus?.kind === 'gate')
    return frame({
      ...base,
      mark: 'waiting',
      word: CARD_FRAME_WORDS.marks.waiting,
      sentence: focus.step.note ?? CARD_FRAME_WORDS.planGate(focus.step.title),
    });
  if (focus?.kind === 'blocked')
    return frame({
      ...base,
      mark: 'failed',
      word: CARD_FRAME_WORDS.planBlocked,
      sentence: focus.step.note ?? CARD_FRAME_WORDS.planStuck(focus.step.title),
    });
  if (focus?.kind === 'active')
    return frame({
      ...base,
      mark: 'working',
      word: CARD_FRAME_WORDS.planWorking(assistant),
      sentence: CARD_FRAME_WORDS.planNow(focus.step.title),
    });
  const next = plan.steps.find((s) => s.state === 'queued');
  if (next)
    return frame({
      ...base,
      mark: 'queued',
      word: CARD_FRAME_WORDS.marks.queued,
      sentence: CARD_FRAME_WORDS.planNext(next.title),
    });
  return frame({ ...base, mark: 'done', word: CARD_FRAME_WORDS.marks.done, sentence: null });
}

/* Councils ---------------------------------------------------------------------------------------------------- */

const NUMBER_WORDS = ['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const numberWord = (n: number) => NUMBER_WORDS[n] ?? String(n);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** “All three agree.”, “Both agree.”, “Two of three agree.”, “None of the three agree yet.” */
function agreeWords(agree: number, of: number): string {
  if (of === 1) return agree ? 'It agrees.' : 'It wants changes.';
  if (agree === of) return of === 2 ? 'Both agree.' : `All ${numberWord(of)} agree.`;
  if (agree === 0) return `None of the ${numberWord(of)} agree yet.`;
  return `${capital(numberWord(agree))} of ${numberWord(of)} agree.`;
}

/** “All three give it 8 out of 10.”, “Both give it 7 out of 10.”, “They give it 6 to 7 out of 10.” */
function scoreWords(scores: readonly number[]): string {
  const say = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  const low = Math.min(...scores);
  const high = Math.max(...scores);
  if (low !== high) return `They give it ${say(low)} to ${say(high)} out of 10.`;
  const who =
    scores.length === 1
      ? 'It gives'
      : scores.length === 2
        ? 'Both give'
        : `All ${numberWord(scores.length)} give`;
  return `${who} it ${say(low)} out of 10.`;
}

/**
 * How a council came out, in words, from its last round with verdicts, else with scores (against its aim when it has
 * one); null when no round says.
 */
export function councilResultWords(
  card: Pick<CouncilCard, 'history' | 'target'>,
  rounds: readonly CouncilRoundResult[] = card.history,
): string | null {
  for (const r of [...rounds].reverse()) {
    const judged = r.members.filter((m) => m.verdict);
    if (judged.length) return agreeWords(judged.filter((m) => m.verdict === 'agree').length, judged.length);
    const scored = r.members.filter((m) => m.score !== null);
    // A review without an aim says what they gave it.
    if (scored.length && card.target === null) return scoreWords(scored.map((m) => m.score ?? 0));
    if (scored.length && card.target !== null) {
      const reached = scored.filter((m) => (m.score ?? 0) >= (card.target ?? 0)).length;
      const of = scored.length;
      const who =
        reached === of
          ? of === 2
            ? 'Both'
            : of === 1
              ? 'It'
              : `All ${numberWord(of)}`
          : `${capital(numberWord(reached))} of ${numberWord(of)}`;
      return `${who} reached the ${card.target} out of 10 they aimed for.`;
    }
  }
  return null;
}

export function councilFrame(card: CouncilCard): CardFrame {
  const base = { kind: CARD_FRAME_WORDS.kinds.council, title: card.title };
  if (card.live) {
    const round = card.members.filter((m) => m.role === 'member');
    const answered = round.filter((m) => m.state === 'done').length;
    const working = round.some((m) => m.state === 'working');
    const progress = round.length && working ? `${answered} of ${round.length} answered` : null;
    // Its plan waits for the Tasks card's Hand over: that card asks, this one says its own part is done.
    const agreed = card.stage === 'approve';
    return frame({
      ...base,
      mark: agreed ? 'done' : 'working',
      word: agreed ? COUNCIL_WORDS.planAgreed : CARD_FRAME_WORDS.marks.working,
      at: card.startedAt,
      headline: null,
      sentence: `${[councilStageLine(card), progress].filter(Boolean).join(' · ')}.`,
    });
  }
  const stopped = card.outcome === 'stopped';
  const noAnswer = card.history.at(-1)?.members.filter((m) => m.state === 'no_answer').length ?? 0;
  return frame({
    ...base,
    mark: stopped ? 'stopped' : 'done',
    word: stopped ? COUNCIL_WORDS.stages.stopped : COUNCIL_WORDS.stages.done,
    at: card.endedAt ?? card.startedAt,
    headline: councilResultWords(card),
    sentence: noAnswer ? `${capital(numberWord(noAnswer))} didn’t answer in time.` : null,
  });
}

/* Delegations ------------------------------------------------------------------------------------------------- */

function finished(t: DelegationCardTask): boolean {
  return t.state === 'done' && t.checks !== 'failing' && (!t.merge || t.merge === 'merged');
}

/** `still`: a copy of the card as it was, which asks nothing: its sentence says what was ticked, not what to do. */
export function delegationFrame(card: DelegationCard, still = false): CardFrame {
  const base = { kind: CARD_FRAME_WORDS.kinds.delegation, title: card.title };
  const offered = card.tasks.filter((t) => t.state === 'offered');
  if (card.live && card.stage === 'offer') {
    const picked = offered.filter((t) => t.picked).length;
    // A list changed since it was offered says what changed, at the time it changed; one a council is looking at
    // doesn't wait for the person until it answers.
    return frame({
      ...base,
      mark: card.checking ? 'working' : 'waiting',
      word: card.checking ? DELEGATION_WORDS.checkingWord : CARD_FRAME_WORDS.marks.waiting,
      at: card.changed?.at ?? card.startedAt,
      headline: null,
      changed: card.changed ? CARD_FRAME_WORDS.changed(card.changed.said) : null,
      sentence: still
        ? `${capitalFirst(DELEGATION_WORDS.ticked(picked, offered.length))}.`
        : card.checking
          ? DELEGATION_WORDS.checking
          : `${DELEGATION_WORDS.offer} · ${DELEGATION_WORDS.ticked(picked, offered.length)}.`,
    });
  }
  const handed = card.tasks.filter((t) => t.state !== 'offered' && t.state !== 'skipped');
  // What a thread doing several tasks said it finished counts, unless finished means merged.
  const said = (t: DelegationCardTask) => !card.merge && t.state === 'working' && !!t.reported;
  const done = handed.filter((t) => finished(t) || said(t)).length;
  const ended = ['failed', 'timed_out', 'stopped'];
  if (card.live)
    return frame({
      ...base,
      mark: 'handedOver',
      word: CARD_FRAME_WORDS.marks.handedOver,
      at: card.handedAt ?? card.startedAt,
      headline: CARD_FRAME_WORDS.tasksProgress(
        done,
        handed.filter((t) => !finished(t) && !said(t) && !ended.includes(t.state)).length,
      ),
      sentence: null,
    });
  const stopped = card.outcome === 'stopped';
  const unfinished = card.tasks.filter((t) => ended.includes(t.state)).length;
  const unmerged = card.tasks.filter((t) => t.state === 'done' && t.merge === 'not_merged').length;
  const word = stopped
    ? card.handedAt
      ? DELEGATION_WORDS.stopped
      : DELEGATION_WORDS.notHanded
    : unfinished
      ? DELEGATION_WORDS.doneSome(unfinished)
      : unmerged
        ? DELEGATION_WORDS.doneUnmerged(unmerged)
        : DELEGATION_WORDS.done;
  return frame({
    ...base,
    mark: stopped ? 'stopped' : unfinished || unmerged ? 'failed' : 'done',
    word,
    at: card.endedAt ?? card.handedAt ?? card.startedAt,
    headline: handed.length ? CARD_FRAME_WORDS.tasksProgress(done, 0) : null,
    sentence: null,
  });
}

/* Runs -------------------------------------------------------------------------------------------------------- */

const RUN_MARK: Record<Run['status'], CardMark> = {
  live: 'working',
  paused: 'queued',
  done: 'done',
  failed: 'failed',
  taken_over: 'stopped',
};

const RUN_WORD: Record<Run['status'], string> = {
  live: CARD_FRAME_WORDS.marks.working,
  paused: 'Paused',
  done: CARD_FRAME_WORDS.marks.done,
  failed: CARD_FRAME_WORDS.marks.failed,
  taken_over: 'Taken over',
};

export function runFrame(
  run: Pick<Run, 'status' | 'title' | 'activity' | 'summary' | 'startedAt' | 'finishedAt'>,
): CardFrame {
  const sentence = runNowText(run);
  return frame({
    mark: RUN_MARK[run.status],
    word: RUN_WORD[run.status],
    kind: CARD_FRAME_WORDS.kinds.run,
    at: run.finishedAt ?? run.startedAt,
    title: run.title,
    headline: null,
    sentence: sentence ? (/[.!?…]$/.test(sentence) ? sentence : `${sentence}.`) : null,
  });
}
