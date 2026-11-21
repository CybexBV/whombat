/**
 * What the agent reads of a council (docs/decisions/council.md CNL-41, CNL-S03): `DispatchContext.council` of a
 * `council` turn — the lead thread's answer that woke it, and each reviewer's score and verdict — of a turn the person
 * wrote in while its council waits for their go-ahead, and `council_read`'s answer (every answer of the round shown).
 * Answers are their agents' words: the persona fences them in as data.
 */
import {
  COUNCIL_ANSWER_MAX,
  COUNCIL_MEMBERS_MAX,
  COUNCIL_READ_MAX,
  type CouncilDispatchContext,
  type CouncilMemberUpdate,
  type CouncilShotUpdate,
} from '@whombat/core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import {
  type CouncilMemberRow,
  type CouncilRow,
  catalogConnections,
  councilMembers,
  councilShots,
  councils,
  delegationTasks,
} from '../db/schema/index';
import { allOver } from '../delegate/state';
import { latestBuilder, roundMembers, roundStageOf } from './card';
import { councilDelegation, loadMembers } from './commands';

const half = (n: number | null) => (n === null ? null : Math.max(0, Math.min(10, Math.round(n * 2) / 2)));

/** How much of an answer told before the round-complete wake tells again: its end, with its score and verdict. */
const RETOLD = 2000;
const endOf = (s: string, max: number) =>
  s.length > max ? `…${s.slice(s.length - max + 1).trimStart()}` : s;

function update(m: CouncilMemberRow, told: boolean, again = false): CouncilMemberUpdate {
  // Every seat, also one whose thread couldn't start: the agent says who didn't take part.
  return {
    memberId: m.id as CouncilMemberUpdate['memberId'],
    name: m.label.slice(0, 60),
    provider: m.providerName.slice(0, 40),
    role: m.role,
    state: m.state,
    score: half(m.score),
    verdict: m.verdict,
    threadId: m.threadId?.slice(0, 300) ?? null,
    told,
    answer:
      told && m.answer ? (again ? endOf(m.answer, RETOLD) : m.answer.slice(0, COUNCIL_ANSWER_MAX)) : null,
  };
}

/**
 * The council as the agent reads it. `toldBy`: the turn whose members it tells (their answers, and every answer once
 * the round is in); null tells every answer (`council_read`).
 */
export async function councilContext(
  db: Db | Tx,
  council: CouncilRow,
  toldBy: string | null,
): Promise<CouncilDispatchContext | null> {
  const [members, shots, connection, d] = await Promise.all([
    loadMembers(db as Tx, council.id),
    db.select().from(councilShots).where(eq(councilShots.councilId, council.id)),
    db
      .select({ handle: catalogConnections.handle })
      .from(catalogConnections)
      .where(eq(catalogConnections.id, council.connectionId)),
    councilDelegation(db as Tx, council.id),
  ]);
  const handle = connection[0]?.handle;
  if (!handle) return null;
  const stage = roundStageOf(council.stage);
  const lastMember = members.filter((m) => m.role === 'member').at(-1);
  const shown = stage
    ? { stage, round: council.round }
    : lastMember
      ? { stage: roundStageOf(lastMember.stage) ?? 'research', round: lastMember.round }
      : null;
  const round = shown ? roundMembers(members, shown.stage, shown.round) : [];
  const builder = latestBuilder(members);
  const allIn = round.length > 0 && !round.some((m) => m.state === 'working');
  const lead = !!council.builderThreadId;
  // A council's turn is told its lead's answer, which brings the reviewers' together; `council_read` tells every one.
  const tells = (m: CouncilMemberRow) =>
    toldBy === null ||
    (lead ? m.role === 'builder' : m.dispatchId === toldBy || (allIn && m.role === 'member'));
  // Once the round is in, an answer an earlier turn was told comes again only as its end (`council_read` has it all).
  const again = (m: CouncilMemberRow) =>
    !lead &&
    toldBy !== null &&
    m.dispatchId !== toldBy &&
    m.dispatchId !== null &&
    allIn &&
    m.role === 'member';
  // `council_read` of a council on a lead thread has every round: the shown one whole, the earlier ones as their
  // ends (where the scores are), each named by its round.
  const every = lead && toldBy === null;
  const earlier = every
    ? members.filter((m) => m.role === 'member' && !round.includes(m)).slice(-(COUNCIL_READ_MAX - 6))
    : [];
  const named = (m: CouncilMemberRow) => {
    const stage = roundStageOf(m.stage);
    return stage ? `${{ research: 'look', agree: 'plan', check: 'check' }[stage]} ${m.round}` : undefined;
  };
  const listed = [
    ...earlier.map((m) => ({ ...update(m, true, true), round: named(m) })),
    ...round
      .slice(0, COUNCIL_MEMBERS_MAX)
      .map((m) => ({ ...update(m, tells(m), again(m)), ...(every ? { round: named(m) } : {}) })),
    ...(builder ? [update(builder, tells(builder), again(builder))] : []),
  ];
  const builderTold = !!builder && builder.dispatchId === toldBy && builder.state !== 'working';
  // Its plan's tasks are all over (CNL-61): what they built is ready to be checked.
  const tasksOver =
    !lead && council.stage === 'build' && d?.handedAt
      ? d.stage !== 'working' ||
        allOver(
          await db.select().from(delegationTasks).where(eq(delegationTasks.delegationId, d.id)),
          d.integrationMode === 'batch',
        )
      : false;
  const event = lead
    ? council.stage === 'approve'
      ? builderTold
        ? 'plan'
        : 'waiting'
      : builder?.state === 'working'
        ? 'working'
        : 'finished'
    : tasksOver || (builderTold && council.stage === 'build')
      ? 'built'
      : allIn
        ? 'round'
        : 'member';
  const areas = (s: (typeof shots)[number]): CouncilShotUpdate['areas'] =>
    s.areas.map((a) => ({
      n: a.n,
      where: a.where?.slice(0, 60) || 'on the screen',
      note: s.notes.find((n) => n.n === a.n)?.text ?? null,
    }));
  return {
    councilId: council.id as CouncilDispatchContext['councilId'],
    kind: council.kind,
    title: council.title.slice(0, 120),
    question: council.question.slice(0, 4000),
    stage: council.stage,
    round: Math.max(1, Math.min(10, council.round)),
    roundsMax: council.roundsMax,
    agreeRoundsLeft: Math.max(0, council.roundsMax - council.agreeRounds),
    checkRoundsLeft: Math.max(0, council.roundsMax - council.checkRounds),
    target: half(council.target),
    event,
    connection: handle as CouncilDispatchContext['connection'],
    project: council.projectTitle?.slice(0, 300) || null,
    members: listed,
    plan: council.plan,
    goAllTheWay: council.goAllTheWay,
    shots: shots
      .filter((s) => s.compareId)
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ view: s.view.slice(0, 80), areas: areas(s) })),
    delegationId: (d?.id as CouncilDispatchContext['delegationId']) ?? null,
  };
}

/** The turns a person's own words start. */
const WRITTEN = new Set(['dm', 'mention', 'thread_reply']);

/**
 * A turn's `DispatchContext.council`: for a `council` turn the council whose lead told it; for a turn the person's words
 * started, the council of that thread that waits for their go-ahead; null otherwise.
 */
export async function councilOfTurn(
  db: Db,
  dispatch: {
    id: string;
    trigger: string;
    burrowId?: string;
    conversationId?: string;
    threadRootId?: string | null;
  },
): Promise<CouncilDispatchContext | null> {
  if (dispatch.trigger !== 'council') {
    // The person wrote where a council waits for their go-ahead: the turn knows it, and can send the lead on.
    if (!WRITTEN.has(dispatch.trigger) || !dispatch.burrowId || !dispatch.conversationId) return null;
    const waiting = await councilOfThread(
      db,
      dispatch.burrowId,
      dispatch.conversationId,
      dispatch.threadRootId ?? null,
    );
    return waiting?.state === 'active' && waiting.stage === 'approve' && waiting.builderThreadId
      ? councilContext(db, waiting, dispatch.id)
      : null;
  }
  const [told] = await db
    .select({ councilId: councilMembers.councilId })
    .from(councilMembers)
    .where(eq(councilMembers.dispatchId, dispatch.id))
    .limit(1);
  if (told) {
    const [council] = await db.select().from(councils).where(eq(councils.id, told.councilId));
    return council ? councilContext(db, council, dispatch.id) : null;
  }
  // Woken because its plan's tasks are over (CNL-61): no member told it; the thread's council building.
  if (!dispatch.burrowId || !dispatch.conversationId) return null;
  const council = await councilOfThread(
    db,
    dispatch.burrowId,
    dispatch.conversationId,
    dispatch.threadRootId ?? null,
  );
  return council?.state === 'active' && council.stage === 'build'
    ? councilContext(db, council, dispatch.id)
    : null;
}

/** The council of a thread: the active one there, else the latest. */
export async function councilOfThread(
  db: Db | Tx,
  burrowId: string,
  conversationId: string,
  threadRootId: string | null,
): Promise<CouncilRow | null> {
  const rows = await db
    .select()
    .from(councils)
    .where(
      and(
        eq(councils.burrowId, burrowId),
        eq(councils.conversationId, conversationId),
        ...(threadRootId ? [eq(councils.threadRootId, threadRootId)] : []),
      ),
    )
    .orderBy(desc(councils.createdAt))
    .limit(5);
  return rows.find((r) => r.state === 'active') ?? rows[0] ?? null;
}

/** The councils still at work in these threads (they don't settle). */
export async function activeCouncilThreads(
  db: Db | Tx,
  conversationId: string,
  rootIds: readonly string[] | null,
): Promise<Set<string>> {
  const rows = await db
    .select({ root: councils.threadRootId })
    .from(councils)
    .where(
      and(
        eq(councils.conversationId, conversationId),
        eq(councils.state, 'active'),
        ...(rootIds ? [inArray(councils.threadRootId, [...rootIds])] : []),
      ),
    );
  return new Set(rows.flatMap((r) => (r.root ? [r.root] : [])));
}
