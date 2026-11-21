/**
 * Reading a council's lead thread (docs/decisions/council.md CNL-80…CNL-86). Pure: T3 Code's list of threads and the
 * council's rows in, what Whombat keeps out. The lead starts its reviewers itself (`delegate_task`), so Whombat finds
 * them as the lead thread's children, places each on a seat and a round (by its title, else by its model and its
 * order), and works out where the council is from them.
 */
import { COUNCIL_HISTORY_MAX, type CouncilRoundResult, type CouncilRoundStage } from '@whombat/core';
import type { CouncilMemberRow, CouncilRow, CouncilSeat } from '../db/schema/councils';
import { list, rec, str } from '../things/words';
import { roundOfTitle } from './briefs';
import { roundResult, roundStageOf } from './card';
import { modelLabel, T3_COUNCIL } from './members';

/** A reviewer the lead started, as `t3_thread_list` lists it. */
export interface ListedChild {
  threadId: string;
  title: string;
  provider: string | null;
  model: string | null;
  status: string;
  items: number;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Whether a child of the lead is one of its reviewers, by its title: one that names a round, or says “council” or
 * “review”. Anything else is a helper the lead started for its own work (a build step), which is no reviewer.
 */
export function reviewerTitle(title: string): boolean {
  return roundOfTitle(title) !== null || /council|review/i.test(title);
}

/** The lead thread's reviewers in a `t3_thread_list` answer (asked with `includeSubagents`), oldest first. */
export function childrenOf(body: unknown, leadThreadId: string): ListedChild[] {
  return list(rec(body).threads)
    .map(rec)
    .flatMap((t): ListedChild[] => {
      const threadId = str(t.threadId);
      if (!threadId || t.relationshipToParent !== 'subagent' || t.parentThreadId !== leadThreadId) return [];
      // A task the lead handed out (`delegate_task`), never a subagent of its own AI program: those rest forever.
      if (str(t.creationSource) && t.creationSource !== 'mcp') return [];
      if (!reviewerTitle(str(t.title) ?? '')) return [];
      return [
        {
          threadId: threadId.slice(0, 300),
          title: (str(t.title) ?? '').slice(0, 300),
          provider: str(t.providerInstanceId)?.slice(0, 40) ?? null,
          model: str(t.model)?.slice(0, 80) ?? null,
          status: str(t.status) ?? '',
          items: typeof t.itemCount === 'number' ? t.itemCount : 0,
          createdAt: str(t.createdAt),
          updatedAt: str(t.updatedAt),
        },
      ];
    })
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
}

/** What a reviewer's thread status means for its row; `working` for anything that hasn't ended. */
export function childState(status: string): 'working' | 'done' | 'failed' | 'stopped' {
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'rolled_back') return 'failed';
  if (status === 'interrupted' || status === 'cancelled') return 'stopped';
  return 'working';
}

/** Where a reviewer sits: its round and its seat's row values. */
export interface Placed {
  stage: CouncilRoundStage;
  round: number;
  position: number;
  provider: string;
  providerName: string;
  model: string;
  label: string;
  options: CouncilSeat['options'];
}

const same = (a: string | null | undefined, b: string) => !!a && a.trim().toLowerCase() === b.toLowerCase();

/**
 * Places a reviewer the lead started: on the seat with its provider and model (else the seat its title names; in T3
 * Code's own council a seat of its company nobody sat yet, which becomes its; else a place after the seats, under its
 * own model's name), in the round its title names — else its seat's next: the first is the look, later ones judge the
 * plan, or check the result once the council builds.
 */
export function placeChild(
  council: Pick<CouncilRow, 'seats' | 'kind' | 'stage'> & Partial<Pick<CouncilRow, 'setupName'>>,
  known: readonly Pick<CouncilMemberRow, 'role' | 'stage' | 'round' | 'position' | 'model'>[],
  child: ListedChild,
): Placed {
  const named = roundOfTitle(child.title);
  const members = known.filter((m) => m.role === 'member');
  const seatAt = (seat: CouncilSeat) => council.seats.indexOf(seat);
  // Its provider and model; where two seats run the same model, the one its title names, else the one still free in
  // its round.
  const mine = council.seats.filter((s) => s.provider === child.provider && s.model === child.model);
  const byTitle = named?.label ? council.seats.find((s) => same(named.label, s.label)) : undefined;
  const rowsAt = (seat: CouncilSeat) => members.filter((m) => m.position === seatAt(seat)).length;
  const free = (seat: CouncilSeat) =>
    !members.some((m) => m.position === seatAt(seat) && m.stage === named?.stage && m.round === named?.round);
  let at = -1;
  if (mine.length === 1) at = seatAt(mine[0] as CouncilSeat);
  else if (mine.length > 1) {
    const pick =
      byTitle && mine.includes(byTitle)
        ? byTitle
        : named
          ? (mine.find(free) ?? mine[0])
          : [...mine].sort((a, b) => rowsAt(a) - rowsAt(b))[0];
    at = seatAt(pick as CouncilSeat);
  }
  if (at < 0 && byTitle) at = seatAt(byTitle);
  if (at < 0 && child.model) {
    const byModel = council.seats.filter((s) => s.model === child.model);
    if (byModel.length === 1) at = seatAt(byModel[0] as CouncilSeat);
  }
  // T3 Code's council sits its skill's members, which may have changed since Whombat last saw it: the guess for their
  // company gives way to the one that came.
  let took = false;
  if (at < 0 && council.setupName === T3_COUNCIL && child.provider && child.model) {
    at = council.seats.findIndex(
      (s, i) => s.provider === child.provider && !members.some((m) => m.position === i),
    );
    took = at >= 0;
  }
  const kept = at >= 0 ? (council.seats[at] as CouncilSeat) : null;
  const seat: CouncilSeat | null =
    kept && took
      ? {
          provider: kept.provider,
          providerName: kept.providerName,
          model: child.model as string,
          label: named?.label || modelLabel({ id: child.model as string, label: null }),
          options: [],
        }
      : kept;
  // A reviewer on no seat keeps the place its model had before, else the next one after the seats.
  const extra = members.find(
    (m) => m.position >= council.seats.length && m.model === (child.model ?? 'unknown'),
  );
  const position = seat
    ? at
    : (extra?.position ?? Math.max(council.seats.length, ...members.map((m) => m.position + 1)));
  const before = members.filter((m) => m.position === position);
  let stage: CouncilRoundStage;
  let round: number;
  if (named) ({ stage, round } = named);
  else if (!before.length) {
    stage = 'research';
    round = 1;
  } else {
    stage =
      council.kind === 'improve' && (council.stage === 'build' || council.stage === 'check')
        ? 'check'
        : 'agree';
    round = before.filter((m) => m.stage === stage).length + 1;
  }
  return {
    stage,
    round: Math.max(1, Math.min(10, round)),
    position,
    provider: seat?.provider || child.provider || 'unknown',
    providerName: seat?.providerName || child.provider || 'Another AI',
    model: seat?.model || child.model || 'unknown',
    label: (seat?.label || named?.label || child.model || 'A reviewer').slice(0, 60),
    options: seat?.options ?? [],
  };
}

type RoundRow = Pick<
  CouncilMemberRow,
  'role' | 'stage' | 'round' | 'position' | 'state' | 'startedAt' | 'verdict' | 'score'
>;

/** The rounds the reviewers ran, oldest first: each its stage, number and rows. */
function roundsOf<T extends RoundRow>(
  members: readonly T[],
): { stage: CouncilRoundStage; round: number; rows: T[] }[] {
  const rounds: { stage: CouncilRoundStage; round: number; rows: T[]; at: number }[] = [];
  for (const m of members) {
    const stage = m.role === 'member' ? roundStageOf(m.stage) : null;
    if (!stage) continue;
    const found = rounds.find((r) => r.stage === stage && r.round === m.round);
    if (found) {
      found.rows.push(m);
      found.at = Math.min(found.at, m.startedAt.getTime());
    } else rounds.push({ stage, round: m.round, rows: [m], at: m.startedAt.getTime() });
  }
  return rounds
    .sort((a, b) => a.at - b.at)
    .map(({ stage, round, rows }) => ({ stage, round, rows: rows.sort((a, b) => a.position - b.position) }));
}

/** Every round that is in (none of its reviewers at work), as the card keeps them. */
export function historyOf(members: readonly CouncilMemberRow[]): CouncilRoundResult[] {
  return roundsOf(members)
    .filter((r) => !r.rows.some((m) => m.state === 'working'))
    .map((r) => roundResult(r.stage, r.round, r.rows))
    .slice(-COUNCIL_HISTORY_MAX);
}

/**
 * Where a council is, from its reviewers: the round at work; with none at work, building once the plan is agreed (or
 * its rounds to agree are used up) or a check asked for changes, else where it was. And how many rounds to agree and
 * to check it used.
 */
export function standingOf(
  council: Pick<CouncilRow, 'kind' | 'stage' | 'round' | 'okAt' | 'roundsMax' | 'target'>,
  members: readonly RoundRow[],
): { stage: CouncilRow['stage']; round: number; agreeRounds: number; checkRounds: number } {
  const rounds = roundsOf(members);
  const used = (stage: CouncilRoundStage) =>
    Math.max(0, ...rounds.filter((r) => r.stage === stage).map((r) => r.round));
  const agreeRounds = used('agree');
  const checkRounds = used('check');
  const counts = { agreeRounds, checkRounds };
  const latest = rounds.at(-1);
  if (!latest) return { stage: council.stage, round: council.round, ...counts };
  if (latest.rows.some((m) => m.state === 'working'))
    return { stage: latest.stage, round: latest.round, ...counts };
  // Waiting for the go-ahead, or building already: the reviewers' rounds don't say otherwise.
  if (council.stage === 'approve') return { stage: 'approve', round: council.round, ...counts };
  if (council.stage === 'build') return { stage: 'build', round: checkRounds + 1, ...counts };
  const answered = latest.rows.filter((m) => m.state === 'done');
  // A round nobody answered agreed on nothing, and a check without a score reached nothing unless it says it agrees.
  const agreed = answered.length > 0 && answered.every((m) => m.verdict !== 'changes');
  const reached =
    agreed &&
    answered.every((m) =>
      council.target === null || m.score === null ? m.verdict === 'agree' : m.score >= council.target,
    );
  const lead = members.find((m) => m.role === 'builder');
  const builds =
    council.kind === 'improve' &&
    !!council.okAt &&
    lead?.state === 'working' &&
    ((latest.stage === 'check' && !reached && checkRounds < council.roundsMax) ||
      (latest.stage === 'agree' && (agreed || agreeRounds >= council.roundsMax)));
  if (builds) return { stage: 'build', round: checkRounds + 1, ...counts };
  return { stage: latest.stage, round: latest.round, ...counts };
}
