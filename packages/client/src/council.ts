/**
 * The council card's words and view (Whombat docs/decisions/council.md CNL-40…CNL-44), shared by web and the phone so
 * both say the same: what the council does now, each member's row (its mark, name, state, score or verdict, how long it
 * has worked), the earlier rounds' scores and the final table, and which buttons show.
 */
import {
  COUNCIL_CARD_ANSWER_MAX,
  type CouncilCard,
  type CouncilCardMember,
  type CouncilKind,
  type CouncilMemberState,
  type CouncilRoundResult,
  type CouncilStage,
  formatTaskDuration,
} from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from './i18n/catalog';
import { CARDS_AREA_WORDS } from './i18n/messages/chatWork/cards';

/** The council card's words, in a locale (English when none). */
export function councilWords(locale?: string | null) {
  const w = clientTree(locale, CARDS_AREA_WORDS).council;
  return {
    /** The card's name in front of what it is about: “Council · Improve the Settings page”. */
    name: w.name,
    /** The first round, by what the council does. */
    firstRound: {
      review: w.firstRound.review,
      research: w.firstRound.research,
      improve: w.firstRound.improve,
    } satisfies Record<CouncilKind, string>,
    stages: {
      agree: w.stages.agree,
      approve: w.stages.approve,
      build: w.stages.build,
      check: w.stages.check,
      done: w.stages.done,
      stopped: w.stages.stopped,
    } satisfies Record<Exclude<CouncilStage, 'research'>, string>,
    /** Building again after a check: the lead fixes what the reviewers found. */
    fixing: w.fixing,
    states: {
      working: w.states.working,
      done: w.states.done,
      failed: w.states.failed,
      no_answer: w.states.no_answer,
      stopped: w.states.stopped,
    } satisfies Record<CouncilMemberState, string>,
    /** A seat whose reviewer hasn't started yet. */
    waiting: w.waiting,
    verdicts: { agree: w.verdicts.agree, changes: w.verdicts.changes },
    /** The thread in T3 Code that runs the council: it starts the reviewers, and builds and fixes. */
    builder: w.builder,
    stop: w.stop,
    /** The live card's link to Settings → the assistant → Council: the rounds and score of the next council. */
    changeCouncil: w.changeCouncil,
    plan: w.plan,
    /** A member's answer, folded on its row (CNL-64). */
    readAnswer: w.readAnswer,
    hideAnswer: w.hideAnswer,
    /** The rest of a long answer is in T3 Code. */
    restInT3: w.restInT3,
    /** The final card: the last round's members whose answers can still be read (CNL-64). */
    lastAnswers: w.lastAnswers,
    /** Stop asks first (CNL-43). */
    stopAsk: { title: w.stopAsk.title, body: w.stopAsk.body, keep: w.stopAsk.keep },
    /** A press that didn't go through (the server's own words come first when it has some). */
    failed: { stop: w.failed.stop },
    pictures: w.pictures,
    /** Under a screen's picture. */
    picturesHint: w.picturesHint,
    /** The status word while its plan waits for the person's go-ahead: the reviewers' part is done. */
    planAgreed: w.planAgreed,
    /** The final table's column of a round: the first named by what the council does, then what the round is. */
    roundShort: { research: w.roundShort.research, agree: w.roundShort.agree, check: w.roundShort.check },
    firstRoundShort: {
      review: w.firstRoundShort.review,
      research: w.firstRoundShort.research,
      improve: w.firstRoundShort.improve,
    } satisfies Record<CouncilKind, string>,
    /** A research council's members agree on one answer, not on a plan to build. */
    agreeOnAnswer: w.agreeOnAnswer,
  };
}

/** The council card's words, in English. */
export const COUNCIL_WORDS = councilWords();

type CouncilWords = ReturnType<typeof councilWords>;
const wordsIn = (locale?: string | null): CouncilWords => (locale ? councilWords(locale) : COUNCIL_WORDS);

/** A round's short name: “Review 1”, “Plan 2”, “Check 1”. */
function roundName(
  r: Pick<CouncilRoundResult, 'stage' | 'round'>,
  kind: CouncilKind,
  COUNCIL_WORDS: CouncilWords = wordsIn(),
): string {
  const word =
    r.stage === 'research'
      ? COUNCIL_WORDS.firstRoundShort[kind]
      : r.stage === 'agree' && kind === 'research'
        ? COUNCIL_WORDS.agreeOnAnswer
        : COUNCIL_WORDS.roundShort[r.stage];
  return `${word} ${r.round}`;
}

/** `7/10`, `7.5/10`. */
export function councilScoreText(score: number): string {
  return `${Number.isInteger(score) ? score : score.toFixed(1)}/10`;
}

/** What the council does now: “Checking the result · round 2 of 3”, “Looking at it”. */
export function councilStageLine(
  card: Pick<CouncilCard, 'what' | 'stage' | 'round' | 'roundsMax' | 'target'>,
  locale?: string | null,
): string {
  const { stage } = card;
  const COUNCIL_WORDS = wordsIn(locale);
  const w = clientTree(locale, CARDS_AREA_WORDS).council;
  const of =
    card.roundsMax > 1 ? ` · ${interpolate(w.roundOf, { round: card.round, max: card.roundsMax })}` : '';
  if (stage === 'research') return COUNCIL_WORDS.firstRound[card.what];
  if (stage === 'agree') return `${COUNCIL_WORDS.stages.agree}${of}`;
  if (stage === 'check') {
    const target =
      card.target !== null ? ` · ${interpolate(w.aimingFor, { score: councilScoreText(card.target) })}` : '';
    return `${COUNCIL_WORDS.stages.check}${of}${target}`;
  }
  if (stage === 'build') return card.round > 1 ? COUNCIL_WORDS.fixing : COUNCIL_WORDS.stages.build;
  return COUNCIL_WORDS.stages[stage];
}

/** One member's row as both apps draw it. */
export interface CouncilMemberView {
  id: string;
  name: string;
  provider: string;
  /** The brand mark to draw, or null: draw `letter` in a round mark (CNL-44). */
  mark: CouncilCardMember['mark'];
  letter: string;
  builder: boolean;
  /** At work now: the waiting animation shows. */
  working: boolean;
  /** Didn't answer, failed or stopped: the row is muted. */
  muted: boolean;
  /** `8/10`, or null while it has none. */
  score: string | null;
  /** “Agrees”, “Wants changes”, or null. */
  verdict: string | null;
  /** What shows at the row's end: its score, its verdict, its state's word. */
  status: string;
  /** How long it worked (ticking while it works). */
  elapsed: string | null;
  /** What the lead does now (“Changing Settings.tsx”). */
  step: string | null;
  url: string | null;
  /** Its answer to read on its row (CNL-64), or null; `cut` when T3 Code has more of it. */
  answer: string | null;
  cut: boolean;
  /** For screen readers: “Claude Opus 5.5, Claude: 8/10, agrees”. */
  label: string;
  /** How its elder sits at the council's table (`@whombat/avatars` `ElderPose`). */
  pose: CouncilElderPose;
}

/**
 * How a member's elder sits: awake and waiting until its reviewer starts, thinking while it works, its verdict once it
 * answered, resting when it gave none.
 */
export type CouncilElderPose = 'waiting' | 'thinking' | 'answered' | 'agrees' | 'doubts' | 'resting';

export function councilElderPose(
  m: Pick<CouncilCardMember, 'state' | 'verdict' | 'waiting'>,
): CouncilElderPose {
  if (m.waiting) return 'waiting';
  if (m.state === 'working') return 'thinking';
  if (m.state !== 'done') return 'resting';
  return m.verdict === 'agree' ? 'agrees' : m.verdict === 'changes' ? 'doubts' : 'answered';
}

const letterOf = (provider: string) => (provider.trim()[0] ?? '?').toUpperCase();

export function councilMemberView(
  m: CouncilCardMember,
  nowMs: number,
  locale?: string | null,
): CouncilMemberView {
  const COUNCIL_WORDS = wordsIn(locale);
  const waiting = !!m.waiting && m.state === 'working';
  const working = m.state === 'working' && !waiting;
  const score = m.score !== null ? councilScoreText(m.score) : null;
  const verdict = m.verdict ? COUNCIL_WORDS.verdicts[m.verdict] : null;
  const start = m.since ? Date.parse(m.since) : null;
  const end = m.endedAt ? Date.parse(m.endedAt) : nowMs;
  const elapsed = start !== null && Number.isFinite(start) ? formatTaskDuration(end - start) : null;
  const status = waiting
    ? COUNCIL_WORDS.waiting
    : working
      ? COUNCIL_WORDS.states.working
      : m.state === 'done'
        ? [score, verdict].filter(Boolean).join(' · ') || COUNCIL_WORDS.states.done
        : COUNCIL_WORDS.states[m.state];
  const said = [score, verdict?.toLowerCase()].filter(Boolean).join(', ');
  return {
    id: m.id,
    name: m.name,
    provider: m.provider,
    mark: m.mark,
    letter: letterOf(m.provider),
    builder: m.role === 'builder',
    working,
    muted: m.state === 'no_answer' || m.state === 'failed' || m.state === 'stopped',
    score,
    verdict,
    status,
    elapsed,
    step: working ? m.step : null,
    url: m.url,
    answer: m.state === 'done' ? (m.answer ?? null) : null,
    cut: m.state === 'done' && !!m.answer && m.answer.length >= COUNCIL_CARD_ANSWER_MAX,
    label: `${m.role === 'builder' ? `${COUNCIL_WORDS.builder}, ` : ''}${m.name}, ${m.provider}: ${
      waiting
        ? COUNCIL_WORDS.waiting.toLowerCase()
        : m.state === 'done' && said
          ? said
          : COUNCIL_WORDS.states[m.state].toLowerCase()
    }`,
    pose: councilElderPose(m),
  };
}

/** The final card's table: one column per round, one row per member (by name), `—` where a member had no score. */
export interface CouncilScoreTable {
  columns: string[];
  rows: { name: string; mark: CouncilCardMember['mark']; letter: string; cells: string[] }[];
}

export function councilScoreTable(
  history: readonly CouncilRoundResult[],
  kind: CouncilKind = 'improve',
  locale?: string | null,
): CouncilScoreTable {
  const COUNCIL_WORDS = wordsIn(locale);
  const rounds = history.filter((r) => r.members.some((m) => m.score !== null || m.verdict !== null));
  const columns = rounds.map((r) => roundName(r, kind, COUNCIL_WORDS));
  const names: { name: string; mark: CouncilCardMember['mark']; provider: string }[] = [];
  for (const r of rounds)
    for (const m of r.members)
      if (!names.some((n) => n.name === m.name))
        names.push({ name: m.name, mark: m.mark, provider: m.provider });
  return {
    columns,
    rows: names.map((n) => ({
      name: n.name,
      mark: n.mark,
      letter: letterOf(n.provider),
      cells: rounds.map((r) => {
        const m = r.members.find((x) => x.name === n.name);
        if (!m) return '';
        if (m.score !== null) return councilScoreText(m.score);
        if (m.verdict) return COUNCIL_WORDS.verdicts[m.verdict];
        return m.state === 'done' ? '—' : COUNCIL_WORDS.states[m.state];
      }),
    })),
  };
}

export interface CouncilCardView {
  /** “Council · Improve the Settings page”. */
  heading: string;
  stage: string;
  members: CouncilMemberView[];
  /** The round's members who answered, of how many: “2 of 3 answered”; null when none works or all ended. */
  progress: string | null;
  /** Live: the earlier rounds in one line each (“Look 1 · 7 · 8 · 7”). */
  earlier: string[];
  table: CouncilScoreTable;
  /** Stop shows (the council works). */
  stoppable: boolean;
  /** How it ended, for the final card: “Done”, “Stopped”, “Done, 1 didn’t answer”. */
  ended: string | null;
  /** For screen readers: the heading and what it does now. */
  label: string;
}

export function councilCardView(card: CouncilCard, nowMs: number, locale?: string | null): CouncilCardView {
  const COUNCIL_WORDS = wordsIn(locale);
  const w = clientTree(locale, CARDS_AREA_WORDS).council;
  const heading = `${COUNCIL_WORDS.name} · ${card.title}`;
  const stage = councilStageLine(card, locale);
  const members = card.members.map((m) => councilMemberView(m, nowMs, locale));
  const round = card.members.filter((m) => m.role === 'member');
  // Only answers count: a member that didn't answer is shown as such on its row.
  const answered = round.filter((m) => m.state === 'done').length;
  const working = round.some((m) => m.state === 'working');
  const progress =
    card.live && round.length && working ? interpolate(w.answered, { answered, of: round.length }) : null;
  const earlier = card.history.map(
    (r) =>
      `${roundName(r, card.what, COUNCIL_WORDS)} · ${r.members
        .map((m) =>
          m.score !== null
            ? councilScoreText(m.score).replace('/10', '')
            : m.verdict
              ? COUNCIL_WORDS.verdicts[m.verdict]
              : '—',
        )
        .join(' · ')}`,
  );
  const noAnswer = card.history.at(-1)?.members.filter((m) => m.state === 'no_answer').length ?? 0;
  const ended = card.live
    ? null
    : card.outcome === 'stopped'
      ? COUNCIL_WORDS.stages.stopped
      : noAnswer
        ? interpolate(w.doneNoAnswer, { done: COUNCIL_WORDS.stages.done, n: noAnswer })
        : COUNCIL_WORDS.stages.done;
  return {
    heading,
    stage,
    members,
    progress,
    earlier,
    table: councilScoreTable(card.history, card.what, locale),
    stoppable: card.live && card.stage !== 'done' && card.stage !== 'stopped',
    ended,
    label: `${heading}: ${ended ?? stage}`,
  };
}
