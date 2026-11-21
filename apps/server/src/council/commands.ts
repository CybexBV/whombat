/**
 * A council's changes, each one commit (docs/decisions/council.md). The agent's: `council.start` (the council, its lead
 * thread's row and the live card), `council.launched` / `council.launch_failed` (the lead's T3 Code thread, and its
 * watch), `council.sync` (the reviewers the lead started, as the watcher's pass found them: their rows, where the
 * council is, the card), `council.member_ended` (the lead thread ended its work: a plan that waits for the go-ahead, or
 * the result; the agent woken), `council.told` (the agent sent the lead on), `council.note` (the agent's words under
 * the card) and `council.finish` (the final card). The person's: `council.stop`. T3 Code is called between these
 * commits, never inside one (`run.ts`). A council of a box from before the lead thread built through a delegation
 * (CNL-60): the delegation's commands still call `councilHandedOver` and `councilPutAside` for those.
 */
import {
  COUNCIL_ANSWER_MAX,
  COUNCIL_AREAS_MAX,
  COUNCIL_HISTORY_MAX,
  COUNCIL_NOTE_MAX,
  COUNCIL_PLAN_MAX,
  COUNCIL_SHOT_NOTE_MAX,
  COUNCIL_SHOTS_MAX,
  CouncilKind,
  type CouncilMemberState,
  newId,
  SUGGESTIONS_MAX,
  Suggestion,
} from '@whombat/core';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { readsRoom } from '../chats/rooms';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Tx } from '../db/client';
import {
  attachments,
  type CouncilMemberRow,
  type CouncilRow,
  type CouncilSeat,
  councilMembers,
  councilShots,
  councils,
  delegations,
  messages,
  t3Watches,
} from '../db/schema/index';
import { cardNews, placeCard } from '../domain/card-move';
import { postMessage } from '../domain/messages';
import { indexMessage } from '../domain/search-index';
import { postUnderCard } from '../domain/under-card';
import { wakeQuietly } from '../domain/wake';
import { putOnMessage } from '../files/commands';
import { conflict, forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadMessageRow } from '../read/messages';
import { loadPrincipalRow } from '../read/principals';
import { scoreOf, verdictOf } from './answers';
import { MEMBER_HOURS } from './briefs';
import { COUNCIL_TEXT, councilCard, roundMembers, roundResult, roundStageOf } from './card';
import { historyOf, standingOf } from './lead';
import { T3_COUNCIL } from './members';

const Id = z.string().min(1).max(64);
const ThreadId = z.string().min(1).max(300);

export { MEMBER_HOURS };
/** How long the lead thread may work on one go before the council counts it as not answering. */
export const LEAD_HOURS = 12;
const HOUR = 3_600_000;

const Seat = z.object({
  provider: z.string().min(1).max(40),
  providerName: z.string().min(1).max(40),
  model: z.string().min(1).max(80),
  label: z.string().min(1).max(60),
  options: z
    .array(z.object({ id: z.string().min(1).max(40), value: z.union([z.string().max(40), z.boolean()]) }))
    .max(6),
});

/* Reading ------------------------------------------------------------------------------------------------------- */

export async function loadCouncil(tx: Tx, burrowId: string, councilId: string): Promise<CouncilRow | null> {
  const [row] = await tx
    .select()
    .from(councils)
    .where(and(eq(councils.id, councilId), eq(councils.burrowId, burrowId)));
  return row ?? null;
}

export async function loadMembers(tx: Tx, councilId: string): Promise<CouncilMemberRow[]> {
  return tx
    .select()
    .from(councilMembers)
    .where(eq(councilMembers.councilId, councilId))
    .orderBy(asc(councilMembers.startedAt), asc(councilMembers.position));
}

/** The council for a change of the agent's: this burrow's, still at work. */
async function activeCouncil(ctx: ApplyContext, councilId: string): Promise<CouncilRow> {
  const row = await loadCouncil(ctx.tx, ctx.burrow.id, councilId);
  if (!row) throw notFound('Council');
  if (row.state !== 'active') throw conflict('This council has ended.');
  return row;
}

/** The words under the council's card on its message now, kept when only the rows changed. */
function noteOnCard(card: unknown): string | null {
  if (!card || typeof card !== 'object') return null;
  const c = card as { kind?: unknown; note?: unknown };
  return c.kind === 'council' && typeof c.note === 'string' ? c.note : null;
}

/**
 * The card says what the rows say now. `note` replaces the words under the card; the message's own words, what the
 * agent asked the council, stay above it. Real news while the thread went on under the card moves it to the thread's
 * end (`placeCard`), unless the person's own press brought it (they are looking at the card) or `inPlace`: its
 * checklist brought it, and the checklist is where the person acts, so the council card stays above it.
 * Answers the message that holds the card now.
 */
export async function refreshCard(
  ctx: ApplyContext,
  councilId: string,
  note?: string,
  { inPlace = false }: { inPlace?: boolean } = {},
): Promise<string | null> {
  const { tx } = ctx;
  const council = await loadCouncil(tx, ctx.burrow.id, councilId);
  if (!council?.liveMessageId) return null;
  const [members, shots, message] = await Promise.all([
    loadMembers(tx, council.id),
    tx.select().from(councilShots).where(eq(councilShots.councilId, council.id)),
    loadMessageRow(tx, council.liveMessageId),
  ]);
  const card = councilCard(council, members, shots, note ?? noteOnCard(message?.card));
  const move = !inPlace && ctx.actor.kind !== 'person' && cardNews(message?.card, card);
  const at = await placeCard(ctx, council.liveMessageId, card, move);
  if (at && at !== council.liveMessageId)
    await tx.update(councils).set({ liveMessageId: at }).where(eq(councils.id, council.id));
  // Search finds the card by the words under it too, as they are now.
  if (note && at) {
    const { services } = ctx;
    ctx.after(async () => indexMessage(services.db, at));
  }
  return at;
}

/* Start --------------------------------------------------------------------------------------------------------- */

export const startCouncil = defineCommand({
  name: 'council.start',
  schema: z.object({
    id: Id,
    conversationId: Id,
    threadRootId: Id.nullable(),
    personId: Id.nullable(),
    connectionId: Id,
    project: z
      .object({ id: z.string().min(1).max(300), title: z.string().max(200), root: z.string().max(2000) })
      .nullable(),
    kind: CouncilKind,
    title: z.string().min(1).max(120),
    question: z.string().min(1).max(4000),
    /** The agent's words above the card: what it asked the council. */
    intro: z.string().min(1).max(COUNCIL_NOTE_MAX),
    /** What T3 Code couldn't run as set, in the person's words: the first words under the card. */
    seatNotes: z.array(z.string().min(1).max(300)).max(8),
    seats: z.array(Seat).min(2).max(4),
    builderSeat: z.number().int().min(0).max(3),
    /** The lead's AI: the chat's own as T3 Code runs it; null: the builder seat's. */
    lead: Seat.nullable().default(null),
    setupName: z.string().min(1).max(40).nullable(),
    target: z.number().min(0).max(10).nullable(),
    roundsMax: z.number().int().min(1).max(5),
    goAllTheWay: z.boolean(),
  }),
  async apply(tx, ctx, input): Promise<{ council: CouncilRow; lead: CouncilMemberRow }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent starts a council.');
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('Conversation');
    const root = input.threadRootId ? await loadMessageRow(tx, input.threadRootId) : null;
    const threadRootId =
      root && root.conversationId === conversation.id ? (root.threadRootId ?? root.id) : null;
    const [council] = await tx
      .insert(councils)
      .values({
        id: input.id,
        burrowId: ctx.burrow.id,
        conversationId: conversation.id,
        threadRootId,
        agentId: ctx.actor.id,
        personId: input.personId,
        connectionId: input.connectionId,
        projectId: input.project?.id ?? null,
        projectTitle: input.project?.title ?? null,
        projectRoot: input.project?.root ?? null,
        kind: input.kind,
        seats: input.seats as CouncilSeat[],
        builderSeat: Math.min(input.builderSeat, input.seats.length - 1),
        setupName: input.setupName,
        title: input.title,
        question: input.question,
        stage: 'research',
        round: 1,
        roundsMax: input.roundsMax,
        target: input.target,
        goAllTheWay: input.goAllTheWay,
        okAt: input.goAllTheWay ? ctx.now : null,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .returning();
    if (!council) throw new Error('council not kept');
    const lead = await addLead(ctx, council, (input.lead as CouncilSeat | null) ?? null);
    const card = councilCard(council, [lead], [], input.seatNotes.join(' ') || null);
    // The person just asked for it: its start isn't news to them (the end and a go-ahead are, `notifyCouncil`).
    const posted = await postMessage(ctx, {
      conversation,
      text: input.intro.trim(),
      card,
      threadRootId,
      dispatch: false,
      notifyDmPerson: false,
    });
    const [kept] = await tx
      .update(councils)
      .set({ liveMessageId: posted.id })
      .where(eq(councils.id, council.id))
      .returning();
    await offerInThread(ctx, council);
    return { council: kept ?? council, lead };
  },
});

/**
 * A list offered in the council's thread says whether this council is checking it (Hand over waits for its answer):
 * changed where it is when a council starts or ends there. Loaded when needed, as the delegation's commands use the
 * council's.
 */
async function offerInThread(ctx: ApplyContext, council: CouncilRow): Promise<void> {
  const { refreshThreadOffer } = await import('../delegate/commands');
  await refreshThreadOffer(ctx, council.conversationId, council.threadRootId);
}

/**
 * The lead thread's row: it runs on the chat's own AI, else on the council's builder seat (it builds and fixes for a
 * council that improves something), at work from now. It never sits at the table on the card.
 */
async function addLead(
  ctx: ApplyContext,
  council: CouncilRow,
  chat: CouncilSeat | null,
): Promise<CouncilMemberRow> {
  const seat = chat ?? council.seats[council.builderSeat] ?? (council.seats[0] as CouncilSeat);
  const [row] = await ctx.tx
    .insert(councilMembers)
    .values({
      id: newId('councilMember'),
      councilId: council.id,
      burrowId: council.burrowId,
      role: 'builder' as const,
      stage: 'build' as const,
      round: 1,
      position: council.seats.length,
      provider: seat.provider,
      providerName: seat.providerName,
      model: seat.model,
      label: seat.label,
      options: seat.options,
      state: 'working' as const,
      startedAt: ctx.now,
      deadline: new Date(ctx.now.getTime() + LEAD_HOURS * HOUR),
    })
    .returning();
  if (!row) throw new Error('council lead not kept');
  return row;
}

/* A member's thread ---------------------------------------------------------------------------------------------- */

export const councilLaunched = defineCommand({
  name: 'council.launched',
  schema: z.object({
    councilId: Id,
    memberId: Id,
    threadId: ThreadId,
    title: z.string().min(1).max(160),
    url: z.string().max(2000).nullable(),
  }),
  async apply(tx, ctx, input): Promise<{ cancelled: boolean }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent starts a council’s threads.');
    const council = await loadCouncil(tx, ctx.burrow.id, input.councilId);
    if (!council) throw notFound('Council');
    const [member] = await tx
      .select({ state: councilMembers.state, role: councilMembers.role })
      .from(councilMembers)
      .where(and(eq(councilMembers.id, input.memberId), eq(councilMembers.councilId, council.id)));
    // The lead thread: the council's reviewers are found as its children.
    if (member?.role === 'builder')
      await tx.update(councils).set({ builderThreadId: input.threadId }).where(eq(councils.id, council.id));
    // Stopped while T3 Code was starting it (Stop, the council's end, its time): the new thread is stopped at once.
    const cancelled = council.state !== 'active' || member?.state !== 'working';
    await tx
      .update(councilMembers)
      .set({ threadId: input.threadId, url: input.url, ...(cancelled ? { stopPending: true } : {}) })
      .where(and(eq(councilMembers.id, input.memberId), eq(councilMembers.councilId, council.id)));
    if (cancelled) return { cancelled: true };
    const watch = {
      conversationId: council.conversationId,
      threadRootId: council.threadRootId,
      agentId: council.agentId,
      personId: council.personId,
      wakes: true,
      state: 'watching' as const,
      armedAt: ctx.now,
      councilId: council.id,
      title: input.title,
      status: null,
      pending: null,
      asks: null,
      steps: null,
      prs: null,
      runStartedAt: null,
      runEndedAt: null,
      url: input.url,
    };
    await tx
      .insert(t3Watches)
      .values({
        burrowId: council.burrowId,
        connectionId: council.connectionId,
        threadId: input.threadId,
        ...watch,
      })
      .onConflictDoUpdate({ target: [t3Watches.connectionId, t3Watches.threadId], set: watch });
    await refreshCard(ctx, council.id);
    return { cancelled: false };
  },
});

export const councilLaunchFailed = defineCommand({
  name: 'council.launch_failed',
  schema: z.object({ councilId: Id, memberId: Id, wake: z.boolean() }),
  async apply(tx, ctx, input): Promise<{ dispatchId: string | null }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent starts a council’s threads.');
    const council = await loadCouncil(tx, ctx.burrow.id, input.councilId);
    if (!council) throw notFound('Council');
    const [member] = await tx
      .update(councilMembers)
      .set({ state: 'failed', endedAt: ctx.now })
      .where(
        and(
          eq(councilMembers.id, input.memberId),
          eq(councilMembers.councilId, council.id),
          eq(councilMembers.state, 'working'),
        ),
      )
      .returning();
    if (!member || council.state !== 'active') return { dispatchId: null };
    await refreshCard(ctx, council.id);
    return { dispatchId: input.wake ? await wakeFor(ctx, council, member) : null };
  },
});

/**
 * The agent woken for a member's end in the council's thread, for its person: a queued `council` turn there takes it
 * (`wakeQuietly`), else a new one. Null when it can't be woken there (the person left, a room they can't read).
 */
async function wakeFor(
  ctx: ApplyContext,
  council: CouncilRow,
  member: CouncilMemberRow,
): Promise<string | null> {
  if (ctx.services.licence.lapsed) return null;
  const personRow = council.personId ? await loadPrincipalRow(ctx.tx, council.personId) : null;
  const person = personRow?.accountId ?? null;
  const room = await loadConversationRow(ctx.tx, council.conversationId);
  if (!person || !room || !readsRoom(room, personRow ?? null)) return null;
  const woken = await wakeQuietly(ctx, {
    agentId: council.agentId,
    conversationId: council.conversationId,
    threadRootId: council.threadRootId,
    person,
    trigger: 'council',
    coalesce: false,
  });
  const dispatchId = woken?.dispatchId ?? null;
  if (dispatchId)
    await ctx.tx.update(councilMembers).set({ dispatchId }).where(eq(councilMembers.id, member.id));
  return dispatchId;
}

export const memberEnded = defineCommand({
  name: 'council.member_ended',
  schema: z.object({
    councilId: Id,
    threadId: ThreadId,
    state: z.enum(['done', 'failed', 'no_answer', 'stopped']),
    answer: z.string().max(COUNCIL_ANSWER_MAX).nullable(),
  }),
  async apply(tx, ctx, input): Promise<{ handled: boolean; dispatchId: string | null }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent hears from a council’s threads.');
    const council = await loadCouncil(tx, ctx.burrow.id, input.councilId);
    if (!council) return { handled: false, dispatchId: null };
    const [working] = await tx
      .select()
      .from(councilMembers)
      .where(
        and(
          eq(councilMembers.councilId, council.id),
          eq(councilMembers.threadId, input.threadId),
          eq(councilMembers.state, 'working'),
        ),
      )
      .orderBy(asc(councilMembers.startedAt))
      .limit(1);
    // A thread nobody of the council waits for any more (the agent sent it work itself): the ordinary watch tells it.
    if (!working) return { handled: false, dispatchId: null };
    const answer = input.answer?.trim() || null;
    // A member that ended without a word didn't answer: it isn't counted as one that did.
    const state: CouncilMemberState =
      input.state === 'done' && !answer && working.role === 'member' ? 'failed' : input.state;
    const [member] = await tx
      .update(councilMembers)
      .set({
        state,
        answer,
        score: answer && working.role === 'member' ? scoreOf(answer) : null,
        verdict: answer && working.role === 'member' ? verdictOf(answer) : null,
        step: null,
        endedAt: ctx.now,
        // Ran out of time: its thread is stopped, and tried again until T3 Code answers.
        ...(input.state === 'no_answer' ? { stopPending: true } : {}),
      })
      .where(eq(councilMembers.id, working.id))
      .returning();
    if (!member) return { handled: true, dispatchId: null };
    await tx
      .update(t3Watches)
      .set({ state: 'idle' })
      .where(and(eq(t3Watches.connectionId, council.connectionId), eq(t3Watches.threadId, input.threadId)));
    if (council.state !== 'active') return { handled: true, dispatchId: null };
    if (member.role === 'builder' && council.builderThreadId === input.threadId)
      await addMissingSeats(ctx, council);
    // The lead ended with the agreed plan, and nobody said to build it yet: it waits for the person's go-ahead. Only
    // once reviewers judged a plan: a lead that ended before that (no seat could run, it has a question) has none.
    const planned =
      member.role === 'builder' && state === 'done' && council.kind === 'improve' && !council.okAt && answer
        ? (await loadMembers(tx, council.id)).some((m) => m.role === 'member' && m.stage === 'agree')
        : false;
    const plan = planned && answer;
    await tx
      .update(councils)
      .set({
        updatedAt: ctx.now,
        ...(plan ? { stage: 'approve' as const, plan: answer.slice(0, COUNCIL_PLAN_MAX) } : {}),
      })
      .where(eq(councils.id, council.id));
    await refreshCard(ctx, council.id, plan ? COUNCIL_TEXT.approve : undefined);
    // Even one stopped in T3 Code by hand: the agent hears the round is in. (Members stopped with the council never get
    // here: its end set them stopped, and an ended council wakes nobody.)
    return { handled: true, dispatchId: await wakeFor(ctx, council, member) };
  },
});

/**
 * The seats that took no part in the council's latest round, as its lead ends: each gets a row that says so, so a seat
 * T3 Code refused shows on the card instead of being left out.
 */
async function addMissingSeats(ctx: ApplyContext, council: CouncilRow): Promise<void> {
  const rows = (await loadMembers(ctx.tx, council.id)).filter((m) => m.role === 'member');
  const latest = [...rows].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
  const stage = latest ? (roundStageOf(latest.stage) ?? 'research') : 'research';
  const round = latest?.round ?? 1;
  const seated = new Set(rows.filter((m) => m.stage === stage && m.round === round).map((m) => m.position));
  const missing = council.seats.flatMap((seat, position) =>
    seated.has(position) ? [] : [{ seat, position }],
  );
  if (!missing.length) return;
  await ctx.tx.insert(councilMembers).values(
    missing.map(({ seat, position }) => ({
      id: newId('councilMember'),
      councilId: council.id,
      burrowId: council.burrowId,
      role: 'member' as const,
      stage,
      round,
      position,
      provider: seat.provider,
      providerName: seat.providerName,
      model: seat.model,
      label: seat.label,
      options: seat.options,
      state: 'failed' as const,
      startedAt: latest?.startedAt ?? ctx.now,
      endedAt: ctx.now,
      deadline: ctx.now,
    })),
  );
  const all = await loadMembers(ctx.tx, council.id);
  await ctx.tx
    .update(councils)
    .set({ history: historyOf(all) })
    .where(eq(councils.id, council.id));
}

/** What the builder does now, in plain words (from the watch's steps). */
export const builderStep = defineCommand({
  name: 'council.builder_step',
  schema: z.object({
    councilId: Id,
    threadId: ThreadId,
    step: z.string().max(120).nullable(),
    worktree: z.string().max(2000).nullable(),
    branch: z.string().max(300).nullable(),
  }),
  async apply(tx, ctx, input): Promise<void> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent follows a council’s builder.');
    const council = await loadCouncil(tx, ctx.burrow.id, input.councilId);
    if (council?.state !== 'active') return;
    const [builder] = await tx
      .select({ id: councilMembers.id })
      .from(councilMembers)
      .where(
        and(
          eq(councilMembers.councilId, council.id),
          eq(councilMembers.threadId, input.threadId),
          eq(councilMembers.role, 'builder'),
        ),
      )
      .limit(1);
    // A member's thread says nothing about where the builder works.
    if (!builder) return;
    const [changed] = await tx
      .update(councilMembers)
      .set({ step: input.step })
      .where(
        and(
          eq(councilMembers.councilId, council.id),
          eq(councilMembers.threadId, input.threadId),
          eq(councilMembers.role, 'builder'),
          eq(councilMembers.state, 'working'),
        ),
      )
      .returning({ id: councilMembers.id });
    if ((input.worktree && !council.builderWorktree) || (input.branch && !council.builderBranch))
      await tx
        .update(councils)
        .set({
          ...(input.worktree && !council.builderWorktree ? { builderWorktree: input.worktree } : {}),
          ...(input.branch && !council.builderBranch ? { builderBranch: input.branch } : {}),
        })
        .where(eq(councils.id, council.id));
    if (changed) await refreshCard(ctx, council.id);
  },
});

/* The lead's reviewers --------------------------------------------------------------------------------------------- */

/** A reviewer of the lead's as the watcher's pass found it: placed on its seat and round, with its answer once it ended. */
export const Reviewer = z.object({
  threadId: ThreadId,
  stage: z.enum(['research', 'agree', 'check']),
  round: z.number().int().min(1).max(10),
  position: z.number().int().min(0).max(40),
  provider: z.string().min(1).max(40),
  providerName: z.string().min(1).max(40),
  model: z.string().min(1).max(80),
  label: z.string().min(1).max(60),
  options: Seat.shape.options,
  url: z.string().max(2000).nullable(),
  startedAt: z.coerce.date().nullable(),
  state: z.enum(['working', 'done', 'failed', 'stopped']),
  answer: z.string().max(COUNCIL_ANSWER_MAX).nullable(),
});
export type CouncilReviewer = z.input<typeof Reviewer>;

/** Whombat's words under the card when the council moves to a stage. */
function stageNote(stage: CouncilRow['stage'], round: number): string | undefined {
  if (stage === 'agree') return COUNCIL_TEXT.agree;
  if (stage === 'check') return COUNCIL_TEXT.check;
  if (stage === 'build') return round > 1 ? COUNCIL_TEXT.fix : COUNCIL_TEXT.build;
  return undefined;
}

/** Whether a reviewer's round is one more than the council allows: a second look, or a round past the limit. */
const pastLimit = (council: Pick<CouncilRow, 'roundsMax'>, stage: string, round: number) =>
  stage === 'research' ? round > 1 : round > council.roundsMax;

/**
 * The lead's reviewers as T3 Code lists them now: a new one gets its row, one that ended its state, answer, score and
 * verdict; one that ran out of time counts as not answering. Then where the council is and its card. Nobody is woken:
 * the lead brings the answers together. A reviewer the lead has to hear about — it ran out of time, or its round is
 * past what the council allows — is marked (`stopPending`) until the lead was told (`run.ts` `tellPending`).
 */
export const syncCouncil = defineCommand({
  name: 'council.sync',
  schema: z.object({ councilId: Id, reviewers: z.array(Reviewer).max(80) }),
  async apply(tx, ctx, input): Promise<{ changed: boolean }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent follows a council’s threads.');
    const council = await loadCouncil(tx, ctx.burrow.id, input.councilId);
    if (council?.state !== 'active') return { changed: false };
    const rows = await loadMembers(tx, council.id);
    let changed = false;
    // T3 Code's own council: a seat a reviewer on another model of its company took is that reviewer's from now on.
    const seats = [...council.seats];
    let seatsChanged = false;
    for (const seen of input.reviewers) {
      const row = rows.find((m) => m.threadId === seen.threadId);
      const answer = seen.answer?.trim() || null;
      // A reviewer that ended without a word didn't answer: it isn't counted as one that did.
      const state: CouncilMemberState = seen.state === 'done' && !answer ? 'failed' : seen.state;
      const ended = {
        state,
        answer,
        score: answer ? scoreOf(answer) : null,
        verdict: answer ? verdictOf(answer) : null,
        endedAt: state === 'working' ? null : ctx.now,
      };
      if (!row) {
        const startedAt = seen.startedAt ?? ctx.now;
        await tx.insert(councilMembers).values({
          id: newId('councilMember'),
          councilId: council.id,
          burrowId: council.burrowId,
          role: 'member' as const,
          stage: seen.stage,
          round: seen.round,
          position: seen.position,
          provider: seen.provider,
          providerName: seen.providerName,
          model: seen.model,
          label: seen.label,
          options: seen.options,
          threadId: seen.threadId,
          url: seen.url,
          startedAt,
          deadline: new Date(startedAt.getTime() + MEMBER_HOURS * HOUR),
          // One round too many: the lead is told once to finish with what it has.
          stopPending: pastLimit(council, seen.stage, seen.round),
          ...ended,
        });
        changed = true;
        const seat = seats[seen.position];
        if (
          council.setupName === T3_COUNCIL &&
          seat &&
          seat.provider === seen.provider &&
          seat.model !== seen.model
        ) {
          seats[seen.position] = { ...seat, model: seen.model, label: seen.label, options: seen.options };
          seatsChanged = true;
        }
      } else if (row.role === 'member' && row.state === 'working' && state !== 'working') {
        await tx.update(councilMembers).set(ended).where(eq(councilMembers.id, row.id));
        changed = true;
      }
    }
    // Ran out of time (CNL-14): counted as not answering; the lead is told to go on without it.
    const now = await loadMembers(tx, council.id);
    const late = now.filter(
      (m) => m.role === 'member' && m.state === 'working' && m.deadline.getTime() < ctx.now.getTime(),
    );
    if (late.length) {
      await tx
        .update(councilMembers)
        .set({ state: 'no_answer', endedAt: ctx.now, stopPending: true })
        .where(
          inArray(
            councilMembers.id,
            late.map((m) => m.id),
          ),
        );
      changed = true;
    }
    if (!changed) return { changed: false };
    const all = late.length ? await loadMembers(tx, council.id) : now;
    const standing = standingOf(council, all);
    await tx
      .update(councils)
      .set({ ...standing, ...(seatsChanged ? { seats } : {}), history: historyOf(all), updatedAt: ctx.now })
      .where(eq(councils.id, council.id));
    const moved = standing.stage !== council.stage || standing.round !== council.round;
    await refreshCard(ctx, council.id, moved ? stageNote(standing.stage, standing.round) : undefined);
    return { changed: true };
  },
});

/**
 * The agent sent the lead on (`council_tell`): the lead's row is at work again and its thread watched. A council that
 * waited for the go-ahead builds now when this is the go-ahead (`goAhead`); else its plan is being changed, and it
 * comes back with it. `text` is what the lead was told.
 */
export const councilTold = defineCommand({
  name: 'council.told',
  schema: z.object({
    councilId: Id,
    text: z.string().min(1).max(COUNCIL_PLAN_MAX),
    goAhead: z.boolean().default(false),
  }),
  async apply(tx, ctx, input): Promise<{ goAhead: boolean }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent leads a council.');
    const council = await activeCouncil(ctx, input.councilId);
    if (council.agentId !== ctx.actor.id) throw forbidden('Only the agent that leads it tells its lead.');
    if (!council.builderThreadId) throw conflict('no_lead');
    const waiting = council.stage === 'approve';
    const goAhead = waiting && input.goAhead;
    await tx
      .update(councilMembers)
      .set({
        state: 'working',
        answer: null,
        step: null,
        endedAt: null,
        dispatchId: null,
        stopPending: false,
        deadline: new Date(ctx.now.getTime() + LEAD_HOURS * HOUR),
      })
      .where(
        and(
          eq(councilMembers.councilId, council.id),
          eq(councilMembers.role, 'builder'),
          eq(councilMembers.threadId, council.builderThreadId),
        ),
      );
    await tx
      .update(councils)
      .set({
        instructions: input.text,
        ...(goAhead
          ? { okAt: ctx.now, stage: 'build' as const, round: council.checkRounds + 1 }
          : waiting
            ? // The plan is being changed: the reviewers judge it again, and the council waits again after.
              { stage: 'agree' as const, round: Math.max(1, council.agreeRounds) }
            : {}),
        updatedAt: ctx.now,
      })
      .where(eq(councils.id, council.id));
    await tx
      .update(t3Watches)
      .set({ state: 'watching', wakes: true, armedAt: ctx.now })
      .where(
        and(
          eq(t3Watches.connectionId, council.connectionId),
          eq(t3Watches.threadId, council.builderThreadId),
        ),
      );
    await refreshCard(
      ctx,
      council.id,
      goAhead ? COUNCIL_TEXT.build : waiting ? COUNCIL_TEXT.revise : undefined,
    );
    return { goAhead };
  },
});

/* The agent's words ---------------------------------------------------------------------------------------------- */

export const noteCouncil = defineCommand({
  name: 'council.note',
  schema: z.object({ councilId: Id, text: z.string().min(1).max(COUNCIL_NOTE_MAX) }),
  async apply(_tx, ctx, input): Promise<void> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent writes on a council’s card.');
    const council = await activeCouncil(ctx, input.councilId);
    if (council.agentId !== ctx.actor.id) throw forbidden('Only the agent that leads it writes on it.');
    // A reply of its own under the card, not words that replace the last ones; progress tells nobody.
    await postUnderCard(
      ctx,
      {
        messageId: council.liveMessageId,
        conversationId: council.conversationId,
        threadRootId: council.threadRootId,
      },
      input.text,
      false,
    );
  },
});

/* Rounds --------------------------------------------------------------------------------------------------------- */

/** Whether no member and no builder of the council is at work: every one answered, failed or ran out of time. */
export function roundIn(members: readonly CouncilMemberRow[]): boolean {
  return !members.some((m) => m.state === 'working');
}

/** The round that ran last (its stage and number), for the history. */
function lastRound(council: CouncilRow, members: readonly CouncilMemberRow[]) {
  const stage = roundStageOf(council.stage);
  if (stage) return { stage, round: council.round };
  const last = members.filter((m) => m.role === 'member').at(-1);
  const lastStage = last ? roundStageOf(last.stage) : null;
  return last && lastStage ? { stage: lastStage, round: last.round } : null;
}

/** The council's history with the round that ran last kept, once. */
function withLastRound(council: CouncilRow, members: readonly CouncilMemberRow[]) {
  const last = lastRound(council, members);
  if (!last) return council.history;
  if (council.history.some((r) => r.stage === last.stage && r.round === last.round)) return council.history;
  const done = roundMembers(members, last.stage, last.round);
  if (!done.length) return council.history;
  return [...council.history, roundResult(last.stage, last.round, done)].slice(-COUNCIL_HISTORY_MAX);
}

/**
 * The delegation carrying out a council's plan (CNL-60), its latest; null before the plan was offered as one.
 */
export async function councilDelegation(tx: Tx, councilId: string) {
  const [d] = await tx
    .select()
    .from(delegations)
    .where(eq(delegations.councilId, councilId))
    .orderBy(desc(delegations.createdAt))
    .limit(1);
  return d ?? null;
}

/**
 * The council's plan is offered on its checklist card (CNL-60): the council waits for the person's go-ahead, which is
 * the checklist's Hand over, so it doesn't say it builds before anyone said go. Its card changes where it is, above
 * the checklist. Called in the delegation's commit.
 */
export async function councilOffered(ctx: ApplyContext, councilId: string): Promise<void> {
  const { tx } = ctx;
  const council = await loadCouncil(tx, ctx.burrow.id, councilId);
  if (council?.state !== 'active' || council.stage === 'build' || council.stage === 'approve') return;
  const all = await loadMembers(tx, council.id);
  if (!roundIn(all)) return;
  const [next] = await tx
    .update(councils)
    .set({ history: withLastRound(council, all), stage: 'approve', updatedAt: ctx.now })
    .where(eq(councils.id, council.id))
    .returning();
  if (next) await refreshCard(ctx, council.id, COUNCIL_TEXT.approveTasks, { inPlace: true });
}

/**
 * The council's plan was handed over, or its checklist got fixes after a check (CNL-60, CNL-61): its stage is `build`
 * (once its members are in), and its card says where the tasks are. Its card changes where it is, so it doesn't jump
 * below the checklist it points to. Called in the delegation's commit.
 */
export async function councilHandedOver(ctx: ApplyContext, councilId: string): Promise<void> {
  const { tx } = ctx;
  const council = await loadCouncil(tx, ctx.burrow.id, councilId);
  if (council?.state !== 'active' || council.stage === 'build') return;
  const all = await loadMembers(tx, council.id);
  if (!roundIn(all)) return;
  const [next] = await tx
    .update(councils)
    .set({
      history: withLastRound(council, all),
      stage: 'build',
      // Its first build, then one more after each check.
      round: council.checkRounds + 1,
      updatedAt: ctx.now,
    })
    .where(eq(councils.id, council.id))
    .returning();
  if (next)
    await refreshCard(ctx, council.id, council.checkRounds ? COUNCIL_TEXT.fix : COUNCIL_TEXT.buildTasks, {
      inPlace: true,
    });
}

/** The council's checklist was put aside before it was handed over: the council ends there (CNL-60). */
export async function councilPutAside(ctx: ApplyContext, councilId: string): Promise<void> {
  const council = await loadCouncil(ctx.tx, ctx.burrow.id, councilId);
  if (council?.state !== 'active') return;
  await endCouncil(ctx, council, { stopped: true, text: COUNCIL_TEXT.notHanded, notes: [], tell: false });
}

/* The end -------------------------------------------------------------------------------------------------------- */

/** Notes per screen and number, as the agent or the builder gave them. */
const Notes = z
  .array(
    z.object({
      view: z.string().min(1).max(80),
      n: z.number().int().min(1).max(COUNCIL_AREAS_MAX),
      text: z.string().min(1).max(COUNCIL_SHOT_NOTE_MAX),
    }),
  )
  .max(COUNCIL_SHOTS_MAX * COUNCIL_AREAS_MAX);

async function endCouncil(
  ctx: ApplyContext,
  council: CouncilRow,
  how: { stopped: boolean; text: string; notes: z.output<typeof Notes>; tell: boolean },
): Promise<{ working: CouncilMemberRow[]; messageId: string | null }> {
  const { tx } = ctx;
  const all = await loadMembers(tx, council.id);
  const working = all.filter((m) => m.state === 'working');
  if (working.length)
    await tx
      .update(councilMembers)
      .set({ state: 'stopped', endedAt: ctx.now, step: null, stopPending: true })
      .where(
        inArray(
          councilMembers.id,
          working.map((m) => m.id),
        ),
      );
  const ended = await loadMembers(tx, council.id);
  const threads = working.flatMap((m) => (m.threadId ? [m.threadId] : []));
  if (threads.length)
    await tx
      .update(t3Watches)
      .set({ state: 'idle' })
      .where(and(eq(t3Watches.connectionId, council.connectionId), inArray(t3Watches.threadId, threads)));
  const shots = await tx.select().from(councilShots).where(eq(councilShots.councilId, council.id));
  for (const note of how.notes) {
    const shot = shots.find((s) => s.view === note.view);
    if (!shot?.areas.some((a) => a.n === note.n)) continue;
    shot.notes = [...shot.notes.filter((n) => n.n !== note.n), { n: note.n, text: note.text }].sort(
      (a, b) => a.n - b.n,
    );
    await tx
      .update(councilShots)
      .set({ notes: shot.notes, updatedAt: ctx.now })
      .where(and(eq(councilShots.councilId, council.id), eq(councilShots.view, shot.view)));
  }
  const incomplete = ended.some(
    (m) => m.role === 'member' && (m.state === 'no_answer' || m.state === 'failed'),
  );
  await tx
    .update(councils)
    .set({
      history: council.builderThreadId ? historyOf(ended) : withLastRound(council, ended),
      state: how.stopped ? 'stopped' : 'done',
      stage: how.stopped ? 'stopped' : 'done',
      outcome: how.stopped ? 'stopped' : incomplete ? 'incomplete' : 'done',
      uploadHash: null,
      uploadUntil: null,
      endedAt: ctx.now,
      updatedAt: ctx.now,
    })
    .where(eq(councils.id, council.id));
  // The pictures move onto the final message; the shots they were drawn from go (the sweep takes them).
  const compares = shots.flatMap((s) => (s.compareId ? [s.compareId] : []));
  if (council.liveMessageId)
    await putOnMessage(
      tx,
      ctx,
      { id: council.liveMessageId, conversationId: council.conversationId },
      compares,
    );
  const raw = shots.flatMap((s) => [s.beforeId, s.afterId].filter((id): id is string => !!id));
  if (raw.length) {
    await tx
      .update(councilShots)
      .set({ beforeId: null, afterId: null })
      .where(eq(councilShots.councilId, council.id));
    await tx.update(attachments).set({ state: 'deleted' }).where(inArray(attachments.id, raw));
  }
  if (how.tell) {
    // The agent's conclusion is a reply of its own, which tells the person; the card keeps a short status.
    const at = await refreshCard(ctx, council.id, how.stopped ? COUNCIL_TEXT.stopped : COUNCIL_TEXT.done);
    await postUnderCard(
      ctx,
      { messageId: at, conversationId: council.conversationId, threadRootId: council.threadRootId },
      how.text,
      true,
    );
    // A list it was checking may be handed over now: it comes after the conclusion, where the person acts.
    await offerInThread(ctx, council);
    return { working, messageId: at };
  }
  const at = await refreshCard(ctx, council.id, how.text);
  await offerInThread(ctx, council);
  return { working, messageId: at };
}

export const finishCouncil = defineCommand({
  name: 'council.finish',
  schema: z.object({
    councilId: Id,
    summary: z.string().min(1).max(4000),
    notes: Notes,
    stopped: z.boolean(),
    /** Quick replies under the card's message (DLG-29), when no checklist follows it. */
    next: z.array(Suggestion).max(SUGGESTIONS_MAX).default([]),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent finishes a council.');
    const council = await activeCouncil(ctx, input.councilId);
    if (council.agentId !== ctx.actor.id) throw forbidden('Only the agent that leads it finishes it.');
    if (input.next.length && council.liveMessageId)
      await tx
        .update(messages)
        .set({ suggestions: input.next })
        .where(eq(messages.id, council.liveMessageId));
    return endCouncil(ctx, council, {
      stopped: input.stopped,
      text: input.summary.trim(),
      notes: input.notes,
      tell: true,
    });
  },
});

export const stopCouncil = defineCommand({
  name: 'council.stop',
  schema: z.object({ councilId: Id }),
  async apply(_tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you stop a council here.');
    const council = await loadCouncil(ctx.tx, ctx.burrow.id, input.councilId);
    if (!council) throw notFound('Council');
    if (council.state !== 'active')
      return { working: [] as CouncilMemberRow[], messageId: council.liveMessageId, council };
    // The person pressed it: nothing to tell them.
    const ended = await endCouncil(ctx, council, {
      stopped: true,
      text: COUNCIL_TEXT.stopped,
      notes: [],
      tell: false,
    });
    return { ...ended, council };
  },
});

/** A council nobody moved on for this long ends by itself (a plan whose go-ahead never came, an agent that went quiet). */
export const COUNCIL_QUIET_DAYS = 7;

export const expireCouncil = defineCommand({
  name: 'council.expire',
  schema: z.object({
    councilId: Id,
    /**
     * `retired`: its plan waited for a Go ahead, which a council no longer asks for (CNL-60). `legacy`: it was started
     * before councils ran in one lead thread, and nothing moves it on any more.
     */
    why: z.enum(['quiet', 'retired', 'legacy']).default('quiet'),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent ends a quiet council.');
    const council = await loadCouncil(tx, ctx.burrow.id, input.councilId);
    if (council?.state !== 'active') return null;
    // Only a plan from before the checklist waits for a Go ahead with no checklist of its own.
    if (input.why === 'retired' && (council.stage !== 'approve' || (await councilDelegation(tx, council.id))))
      return null;
    if (input.why === 'legacy' && council.builderThreadId) return null;
    if (input.why !== 'legacy' && !roundIn(await loadMembers(tx, council.id))) return null;
    return endCouncil(ctx, council, {
      stopped: true,
      text:
        input.why === 'retired'
          ? COUNCIL_TEXT.retired
          : input.why === 'legacy'
            ? COUNCIL_TEXT.legacy
            : COUNCIL_TEXT.quiet,
      notes: [],
      tell: false,
    });
  },
});
