/**
 * The council's card from its rows (docs/decisions/council.md CNL-40, CNL-42), and Whombat's own words under it at each
 * step before the agent writes its own. Pure: rows in, the `council` card out. The card shows the round at work (its
 * reviewers, each answer to read, CNL-64) and the lead thread that runs the council, the rounds before as their scores,
 * the plan, and the screens whose picture is drawn (a council of a box from before CNL-60).
 */
import {
  COUNCIL_CARD_ANSWER_MAX,
  COUNCIL_HISTORY_MAX,
  COUNCIL_MEMBERS_MAX,
  COUNCIL_PLAN_MAX,
  COUNCIL_SHOTS_MAX,
  COUNCIL_SUMMARY_MAX,
  COUNCIL_TITLE_MAX,
  type CouncilCard,
  type CouncilCardMember,
  type CouncilRoundResult,
  type CouncilRoundStage,
  type CouncilShot,
} from '@whombat/core';
import type { CouncilMemberRow, CouncilRow, CouncilSeat, CouncilShotRow } from '../db/schema/councils';
import { markOf } from './members';

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const half = (n: number | null) => (n === null ? null : Math.max(0, Math.min(10, Math.round(n * 2) / 2)));
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** The stage a round of members runs in (the builder's is `build`). */
export function roundStageOf(stage: string): CouncilRoundStage | null {
  return stage === 'research' || stage === 'agree' || stage === 'check' ? stage : null;
}

export function memberOnCard(m: CouncilMemberRow): CouncilCardMember {
  return {
    id: m.id as CouncilCardMember['id'],
    name: cut(m.label, 60),
    provider: cut(m.providerName, 40),
    mark: markOf(m.provider),
    role: m.role,
    state: m.state,
    score: half(m.score),
    verdict: m.verdict,
    since: iso(m.startedAt),
    endedAt: iso(m.endedAt),
    step: m.role === 'builder' && m.state === 'working' && m.step ? cut(m.step, 120) : null,
    url: m.url,
    // What it answered, to read on its row (CNL-64): a reviewer's answer, and the lead's own once it is done.
    answer: m.state === 'done' && m.answer ? m.answer.slice(0, COUNCIL_CARD_ANSWER_MAX) : null,
  };
}

/** A seat whose reviewer hasn't started in the round yet: at the table from the start, getting ready. */
function waitingSeat(seat: CouncilSeat, position: number): CouncilCardMember {
  return {
    id: `cnm_seat${position}` as CouncilCardMember['id'],
    name: cut(seat.label, 60),
    provider: cut(seat.providerName, 40),
    mark: markOf(seat.provider),
    role: 'member',
    state: 'working',
    score: null,
    verdict: null,
    since: null,
    endedAt: null,
    step: null,
    url: null,
    answer: null,
    waiting: true,
  };
}

/** A screen's picture as a card shows it, once Whombat drew it (a council's, or a delegation task's, DLG-27). */
export type ShotRowLike = Pick<
  CouncilShotRow,
  'view' | 'position' | 'compareId' | 'width' | 'height' | 'areas' | 'notes'
>;

export function shotsOnCard(rows: readonly ShotRowLike[], max: number): CouncilShot[] {
  return rows
    .filter((s) => s.compareId && s.width && s.height)
    .sort((a, b) => a.position - b.position)
    .slice(0, max)
    .map((s) => ({
      view: cut(s.view, 80),
      attachmentId: s.compareId as CouncilShot['attachmentId'],
      width: s.width as number,
      height: s.height as number,
      areas: s.areas.length,
      notes: s.notes.filter((n) => s.areas.some((a) => a.n === n.n)),
    }));
}

/** A finished round as the card keeps it. */
export function roundResult(
  stage: CouncilRoundStage,
  round: number,
  members: readonly CouncilMemberRow[],
): CouncilRoundResult {
  return {
    stage,
    round,
    members: members.slice(0, COUNCIL_MEMBERS_MAX).map((m) => ({
      name: cut(m.label, 60),
      mark: markOf(m.provider),
      provider: cut(m.providerName, 40),
      state: m.state,
      score: half(m.score),
      verdict: m.verdict,
    })),
  };
}

/** The members a round of the council's had (in their order), and its latest builder. */
export function roundMembers(
  members: readonly CouncilMemberRow[],
  stage: CouncilRoundStage,
  round: number,
): CouncilMemberRow[] {
  return members
    .filter((m) => m.role === 'member' && m.stage === stage && m.round === round)
    .sort((a, b) => a.position - b.position);
}

export function latestBuilder(members: readonly CouncilMemberRow[]): CouncilMemberRow | null {
  return (
    members
      .filter((m) => m.role === 'builder')
      .sort((a, b) => b.round - a.round || b.startedAt.getTime() - a.startedAt.getTime())[0] ?? null
  );
}

/**
 * The round the card shows now: the stage's own while one runs or ran last; while the plan waits or the builder works,
 * the round before (its scores stay in sight).
 */
function shownRound(council: CouncilRow, members: readonly CouncilMemberRow[]) {
  const stage = roundStageOf(council.stage);
  if (stage) return { stage, round: council.round };
  const last = [...members]
    .filter((m) => m.role === 'member')
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
  return last ? { stage: roundStageOf(last.stage) ?? 'research', round: last.round } : null;
}

export function councilCard(
  council: CouncilRow,
  members: readonly CouncilMemberRow[],
  shots: readonly ShotRowLike[],
  note: string | null = null,
): CouncilCard {
  const shown = shownRound(council, members);
  const round = shown ? roundMembers(members, shown.stage, shown.round) : [];
  const live = council.state === 'active';
  // The council's seats only: the lead runs it from T3 Code and never sits at the table. While a round runs, a seat
  // whose reviewer hasn't started yet is there all the same, getting ready.
  const running = live && roundStageOf(council.stage) !== null;
  const seated = [
    ...round.map((m) => ({ position: m.position, member: memberOnCard(m) })),
    ...(running
      ? council.seats.flatMap((seat, position) =>
          round.some((m) => m.position === position)
            ? []
            : [{ position, member: waitingSeat(seat, position) }],
        )
      : []),
  ].sort((a, b) => a.position - b.position);
  const current = seated.map((s) => s.member).slice(0, COUNCIL_MEMBERS_MAX);
  // The rounds before the one shown; once it ended, all of them (the shown one is the last of `history`).
  const history = council.history.filter(
    (r) => live && !(shown && r.stage === shown.stage && r.round === shown.round),
  );
  return {
    kind: 'council',
    councilId: council.id as CouncilCard['councilId'],
    what: council.kind,
    title: cut(council.title, COUNCIL_TITLE_MAX),
    stage: council.stage,
    round: Math.max(1, Math.min(10, council.round)),
    roundsMax: council.roundsMax,
    target: half(council.target),
    live,
    members: current,
    history: (live ? history : council.history).slice(-COUNCIL_HISTORY_MAX),
    plan: council.plan ? cut(council.plan, COUNCIL_PLAN_MAX) : null,
    shots: shotsOnCard(shots, COUNCIL_SHOTS_MAX),
    outcome: council.outcome,
    note: note ? cut(note, COUNCIL_SUMMARY_MAX) : null,
    startedAt: council.createdAt.toISOString(),
    endedAt: iso(council.endedAt),
  };
}

/** Whombat's words under the card at each step; the agent's own words are replies under it (`council_note`). */
export const COUNCIL_TEXT = {
  agree: 'The council is looking at the plan.',
  approve: 'The council agreed on a plan. Say go ahead to have it built.',
  build: 'T3 Code is building the plan.',
  revise: 'The council is changing the plan.',
  fix: 'T3 Code is fixing what the check found.',
  check: 'The council is checking the result.',
  /** A council from before the lead thread: its plan waited on a Tasks card, or its tasks ran there. */
  approveTasks: 'The council agreed on a plan. Hand over its tasks on the Tasks card to start.',
  buildTasks: 'The council agreed on a plan: its tasks are on the Tasks card.',
  legacy: 'The council stopped: a council now runs in one T3 Code thread. Ask me again to start it there.',
  done: 'The council finished.',
  stopped: 'The council stopped.',
  quiet: 'The council stopped: nothing moved on for a week.',
  notHanded: 'The council stopped: its plan wasn’t handed over.',
  retired:
    'The council stopped: building now goes through a T3 Code checklist. Ask me to hand the plan over.',
} as const;

/** “Claude, GPT 6.1 Sol and Muse Wonder”. */
export function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
