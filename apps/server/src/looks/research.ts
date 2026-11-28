/**
 * The assistant looks first (docs/decisions/look-research.md LR-01…LR-11): what it found out about each look, kept in
 * `look_researches`, and the signed commands that move it along.
 *
 * - **`look.research_start`** (the watcher, as the agent; `watch.ts`): the assistant's own line in the thing's thread of
 *   the person's Chat (“Home Assistant needs a look. I’m looking into it.”), a new thread the first time and a reply in
 *   it after that, quiet: no push, no inbox row (LR-04), and the agent is woken there for the person (trigger `look`,
 *   its own turn). The row starts `looking`.
 * - **`look.report`** (`look_report`, the agent in a `look` or `look_fix` turn): its title, summary, whether it fixed it
 *   and the one step it offers (LR-05…LR-07). A fixed look goes to Done today, as `report_done` would put it.
 * - **`look.fix`** (`looks.fix`, the desk's `look/fix`; the person): the person's “Go ahead: restart Zigbee.” in the
 *   look's thread and the agent woken to take exactly that step (trigger `look_fix`, LR-08). The row is `fixing`.
 * - **`look.settle`** (the watcher): rows whose look went or became a new problem end (`gone_at`) and their thread
 *   settles when nobody needs it; a look that came back as it was gets its finding back; a turn that ended without a
 *   report leaves its research `failed`, or its step offered again.
 * - **`look.handle`** (`looks.handle`; the person, docs/decisions/handle-it.md): *Ask {assistant} to handle these* —
 *   their ask in the thing's thread and a `look` turn on everything that needs a look there, now.
 *
 * A research covers every line of its thing (its problems and only-you lines); a report may offer a plan of several
 * steps instead of one, posted as one `look_plan` card in the thread that *Go ahead* (`looks.fix`) lets it take at
 * once, and a finding with a step for the person is pushed to them once, in plain words.
 *
 * Every change publishes `home.changed` so the desk, Home and the thing's page read again. The events carry ids only.
 */
import {
  CareStepId,
  careKey,
  carePushText,
  careThingKey,
  DESK_WORDS,
  deskText,
  fillDeskWords,
  LOOK_CHANGES_MAX,
  LOOK_FIX_LABEL_MAX,
  LOOK_FIX_STEP_MAX,
  LOOK_LINES_MAX,
  LOOK_PLAN_STEP_MAX,
  LOOK_PLAN_STEPS_MAX,
  LOOK_SUMMARY_MAX,
  LOOK_TITLE_MAX,
  type LookDispatchContext,
  type LookPlanView,
  LookReportInput,
  type LookResearch,
  type LookResearchState,
  newId,
  parseThingId,
  topics,
} from '@whombat/core';
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, notLike, or } from 'drizzle-orm';
import { z } from 'zod';
import { turnOnCareAutomations } from '../care/automations';
import { changesSince } from '../changes/store';
import { changeWords } from '../changes/words';
import { settleResolvedThreads } from '../chats/settle';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import {
  catalogConnections,
  dispatches,
  incidents,
  type LookCareRow,
  type LookPlanStepRow,
  type LookResearchRow,
  lookResearches,
  messages,
  notifications,
} from '../db/schema/index';
import { linkOfMessage } from '../domain/links';
import { postMessage } from '../domain/messages';
import { notifyInCommit } from '../domain/notify';
import { ensurePersonalDm } from '../domain/personal-dm';
import { threadPushGroup } from '../domain/push-preview';
import { wakeQuietly } from '../domain/wake';
import { reportDoneCommand } from '../home/done';
import { homeAudience, publishHomeChanged } from '../home/notify';
import { forbidden, notAllowed, notFound } from '../lib/errors';
import { type ConversationRow, loadConversationRow } from '../read/conversations';
import { loadMessageRow, loadMessages } from '../read/messages';
import { loadAgentRow, loadPrincipalRow } from '../read/principals';
import type { DispatchRow } from '../runtime/context';
import { onlyCareLines } from './lines';

/** How bad a look is, as kept: 0 down, 1 in trouble, 2 to look at (worse is lower). */
export const LOOK_RANK = { down: 0, bad: 1, look: 2 } as const;
export type LookRank = (typeof LOOK_RANK)[keyof typeof LOOK_RANK];
const RANK_STATE = ['down', 'bad', 'look'] as const;

/** History is kept a month (the thread stays in Chat). */
export const RESEARCH_KEEP_MS = 30 * 24 * 60 * 60_000;

/** What `look_report` hears outside a look's turn. */
export const NOT_A_LOOK =
  'look_report only works in a turn where Whombat asks you to look into something that needs a look. Answer in the conversation instead.';

/** A line the research covers, as kept (`LookLine`). */
const ResearchLine = z.object({
  check: z.string().max(80).nullable(),
  subject: z.string().max(160),
  title: z.string().min(1).max(160),
  nature: z.enum(['problem', 'you']).nullable(),
});

/** A look as the watcher starts research on it: the desk's look, the line behind it and every line of the thing. */
export const ResearchLook = z.object({
  key: z.string().min(1).max(120),
  kind: z.enum(['server', 'connection', 'device']),
  name: z.string().min(1).max(120),
  rank: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  reason: z.string().max(300).nullable(),
  question: z.string().max(300).nullable(),
  check: z.string().max(80).nullable(),
  subject: z.string().max(160),
  since: z.date().nullable(),
  lines: z.array(ResearchLine).max(LOOK_LINES_MAX).default([]),
  /**
   * The care plan's steps for a server whose lines include missing backups, snapshots or updates (care-plan.md): the
   * turn may propose them by id. Read outside the commit with the look.
   */
  care: z.custom<LookCareRow>((v) => typeof v === 'object' && v !== null).nullish(),
});
export type ResearchLook = z.infer<typeof ResearchLook>;

/** The words as kept: one line a screen may draw, at most `max` code points. */
function oneLine(text: string, max: number): string {
  return deskText(text, max);
}

/** “Restart Zigbee” → “restart Zigbee” (an all-capitals word stays as it is: “UPS”). */
function lowerFirst(text: string): string {
  return /^\p{Lu}\p{Ll}/u.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/** The assistant's first line in the look's thread (LR-04): what Whombat saw, and that it is looking into it. */
export function researchOpening(look: Pick<ResearchLook, 'kind' | 'name' | 'rank'>): string {
  const first =
    look.rank === LOOK_RANK.down
      ? look.kind === 'server'
        ? `${look.name} isn’t answering.`
        : fillDeskWords(DESK_WORDS.status.down, { server: look.name })
      : fillDeskWords(DESK_WORDS.status.look, { server: look.name });
  return `${first} ${DESK_WORDS.looks.looking}`;
}

/** The person's words when they press the step (LR-08): “Go ahead: restart Zigbee.” */
export function goAheadText(label: string): string {
  return `Go ahead: ${lowerFirst(label.replace(/[.!?…]+$/, ''))}.`;
}

/** The person's words on *Go ahead* under a plan: the card above says which steps. */
export const GO_AHEAD_PLAN = 'Go ahead.';

/** The person's words when they hand a thing's lines to the assistant (*Ask {assistant} to handle these*). */
export function handleText(name: string): string {
  return `Please take care of what needs a look on ${name}.`;
}

/** The plan card's message: what the assistant found, as one sentence above the steps. */
export function planMessageText(title: string): string {
  return /[.!?…]$/.test(title) ? title : `${title}.`;
}

/**
 * The finding as a push (handle-it.md): what is wrong and what the assistant can do, in the assistant's words —
 * “pve-02’s disk is full of old backups. I can remove the 3 oldest.” — or, for a plan, how many steps wait for a yes.
 */
export function findingPushText(
  row: Pick<LookResearchRow, 'title' | 'fixLabel' | 'plan'> & Partial<Pick<LookResearchRow, 'care' | 'name'>>,
): string | null {
  // A new server's care plan says what it is (care-plan.md): how the assistant would look after it.
  if (row.care?.new && row.plan?.length && row.name) return carePushText(row.name, row.plan.length);
  if (!row.title) return null;
  const head = planMessageText(row.title);
  const steps = row.plan?.length ?? 0;
  if (steps > 1) return `${head} I have ${steps} steps ready for your OK.`;
  const one = steps === 1 ? row.plan?.[0]?.text : row.fixLabel;
  if (!one) return null;
  return `${head} I can ${lowerFirst(one.replace(/[.!?…]+$/, ''))}.`;
}

/** The post's client id: one opening per research. */
export const openingClientId = (id: string) => `look:${id}`;
/** The press's client id: one per research and moment. */
const goAheadClientId = (id: string, at: Date) => `look-fix:${id}:${at.getTime().toString(36)}`;

/**
 * A row as the screens read it (`LookResearch`): the step only while it is offered; a plan while it waits, while it is
 * taken and once done (never with the step, so a screen that doesn't know plans offers nothing it doesn't show).
 */
export function lookResearchOf(row: LookResearchRow): LookResearch {
  const plan = row.plan?.length && row.state !== 'looking' && row.state !== 'failed' ? row.plan : null;
  return {
    key: row.lookKey,
    state: row.state,
    ...(row.title ? { title: row.title } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.state === 'found' && row.fixLabel && !plan ? { fix: row.fixLabel } : {}),
    ...(plan ? { plan: plan.map((p) => oneLine(p.text, LOOK_PLAN_STEP_MAX)) } : {}),
    ...(row.conversationId ? { conversationId: row.conversationId } : {}),
    ...(row.threadRootId ? { threadRootId: row.threadRootId } : {}),
    at: row.stateAt.toISOString(),
  };
}

/**
 * A plan's card as it is now (`look_plan`), from its research: waiting while found, doing while the steps are taken,
 * done once fixed, gone when the problem went first or a later finding has no plan. Null without a plan.
 */
export function lookPlanViewOf(row: LookResearchRow): LookPlanView | null {
  if (!row.plan?.length) return null;
  const live = row.goneAt === null;
  const state =
    row.state === 'fixed'
      ? 'done'
      : !live
        ? 'gone'
        : row.state === 'found'
          ? 'waiting'
          : row.state === 'fixing'
            ? 'doing'
            : 'gone';
  return {
    name: row.name.slice(0, 120),
    state,
    steps: row.plan.map((p) => oneLine(p.text, LOOK_PLAN_STEP_MAX)),
    title: row.title,
    summary: row.summary,
    research: live ? lookResearchOf(row) : null,
    at: row.stateAt.toISOString(),
    ...(row.care?.new ? { care: true } : {}),
  };
}

/** The plan cards of these researches, by research id (`read/messages.ts`). */
export async function lookPlanCards(
  db: Db | Tx,
  researchIds: readonly string[],
): Promise<Map<string, LookPlanView | null>> {
  if (!researchIds.length) return new Map();
  const rows = await db
    .select()
    .from(lookResearches)
    .where(inArray(lookResearches.id, [...new Set(researchIds)]));
  return new Map(rows.map((r) => [r.id, lookPlanViewOf(r)]));
}

/** Re-sends a research's plan card when it moved: the card resolves on read, so the frame carries it as it is now. */
async function republishPlanCard(
  ctx: ApplyContext,
  row: Pick<LookResearchRow, 'planMessageId'>,
): Promise<void> {
  if (!row.planMessageId) return;
  const message = await loadMessageRow(ctx.tx, row.planMessageId);
  if (!message) return;
  const [loaded] = await loadMessages(ctx.tx, [message], null);
  if (loaded)
    ctx.publish(topics.conversation(message.conversationId), { type: 'message.updated', message: loaded });
}

/**
 * Pushes a finding the person has to say yes to, once per research (handle-it.md): a found step or plan. A fixed
 * problem never pushes (it is in Done today); the thread itself stays quiet. Opens the plan's card, else the thread.
 * When the thing's outage was pushed already, the finding waits in the Inbox without a second buzz, and only a finding
 * that buzzed is marked pushed: a held one mustn't keep a later outage of the thing from pushing.
 */
async function pushFinding(ctx: ApplyContext, row: LookResearchRow): Promise<void> {
  if (row.pushedAt || row.state !== 'found' || !row.personId || !row.conversationId) return;
  const text = findingPushText(row);
  const messageId = row.planMessageId ?? row.threadRootId;
  const conversation = await loadConversationRow(ctx.tx, row.conversationId);
  if (!text || !messageId || !conversation) return;
  const dedupKey = `look-finding:${row.id}`;
  // Held on an earlier report: its Inbox row stands, and a later report neither buzzes nor counts as a buzz. The row is
  // saved with the report that decided it, so a later report always sees it.
  const [had] = await ctx.tx
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.principalId, row.personId), eq(notifications.dedupKey, dedupKey)))
    .limit(1);
  if (had) return;
  const quiet = await outagePushed(ctx.tx, ctx.burrow.id, row.lookKey, row.startedAt);
  if (!quiet)
    await ctx.tx.update(lookResearches).set({ pushedAt: ctx.now }).where(eq(lookResearches.id, row.id));
  const link = await linkOfMessage(ctx.tx, conversation, messageId, row.threadRootId);
  await notifyInCommit(ctx, {
    burrowId: ctx.burrow.id,
    burrowSlug: ctx.burrow.slug,
    principalId: row.personId,
    kind: 'needs_you' as const,
    actorId: row.agentId,
    where: 'Chat',
    text,
    link,
    createdAt: ctx.now,
    dedupKey,
    messageId,
    group: threadPushGroup(row.conversationId, row.threadRootId),
    ...(quiet ? { pushHeld: true } : {}),
  });
}

/**
 * Whether an outage of the thing buzzed already during the research (one Whombat found bad before it watched never
 * did): one still open, or one that ended after the research began, as the thing came back while it looked. Not while
 * an open outage of the thing hasn't buzzed: the finding's buzz stands in for that one's push.
 */
async function outagePushed(tx: Tx, burrowId: string, thing: string, researchFrom: Date): Promise<boolean> {
  const rows = await tx
    .select({ endedAt: incidents.endedAt, pushedAt: incidents.pushedAt, group: incidents.pushGroup })
    .from(incidents)
    .where(
      and(
        eq(incidents.burrowId, burrowId),
        eq(incidents.thingId, thing),
        or(isNull(incidents.endedAt), gt(incidents.endedAt, researchFrom)),
      ),
    );
  if (rows.some((r) => !r.endedAt && !r.pushedAt)) return false;
  return rows.some((r) => r.group !== null);
}

/** The burrow's research of every look that is still there, by the look's key. */
export async function liveResearches(db: Db | Tx, burrowId: string): Promise<Map<string, LookResearch>> {
  const rows = await liveRows(db, burrowId);
  return new Map(rows.map((r) => [r.lookKey, lookResearchOf(r)]));
}

/** The burrow's rows of looks that are still there. */
export function liveRows(db: Db | Tx, burrowId: string): Promise<LookResearchRow[]> {
  return db
    .select()
    .from(lookResearches)
    .where(and(eq(lookResearches.burrowId, burrowId), isNull(lookResearches.goneAt)));
}

/**
 * How many researches of each look began since `from` (the day's budget and each thing's, LR-03); the ones the person
 * asked for (*Ask {assistant} to handle these*) aren't the watcher's and don't count.
 */
export async function researchesSince(
  db: Db | Tx,
  burrowId: string,
  from: Date,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ key: lookResearches.lookKey })
    .from(lookResearches)
    .where(
      and(
        eq(lookResearches.burrowId, burrowId),
        gte(lookResearches.startedAt, from),
        isNull(lookResearches.askedById),
        // A new server's care plan isn't a look: it never counts against the day's.
        notLike(lookResearches.lookKey, 'care:%'),
      ),
    );
  const out = new Map<string, number>();
  for (const { key } of rows) out.set(key, (out.get(key) ?? 0) + 1);
  return out;
}

/**
 * The latest research of each look that went since `from`, by the look's key: what the assistant last said about it,
 * for a look that comes back (LR-02).
 */
export async function endedRows(
  db: Db | Tx,
  burrowId: string,
  from: Date,
): Promise<Map<string, LookResearchRow>> {
  const rows = await db
    .select()
    .from(lookResearches)
    .where(
      and(
        eq(lookResearches.burrowId, burrowId),
        isNotNull(lookResearches.goneAt),
        gte(lookResearches.goneAt, from),
      ),
    )
    .orderBy(desc(lookResearches.startedAt));
  const out = new Map<string, LookResearchRow>();
  for (const r of rows) if (!out.has(r.lookKey)) out.set(r.lookKey, r);
  return out;
}

/** Tells the person's screens that a research moved: the desk, Home and the thing's page read again. */
async function changed(ctx: ApplyContext): Promise<void> {
  publishHomeChanged(ctx, await homeAudience(ctx, ctx.burrow.id), ['needsYou', 'things']);
}

/* Starting (LR-01…LR-04) ------------------------------------------------------------------------------------------ */

/**
 * The thread of the thing's latest research in the person's Chat, while the room still shows it (its first message is
 * there and not from before the person cleared the room), else null: a thing has one thread, and a look of it that
 * comes back or gets worse is looked into there again (LR-04). A server's care plan (care-plan.md) is in it too.
 */
export async function thingThread(
  tx: Tx,
  burrowId: string,
  key: string,
  chat: ConversationRow,
): Promise<string | null> {
  const [row] = await tx
    .select({ root: messages.id })
    .from(lookResearches)
    .innerJoin(messages, eq(messages.id, lookResearches.threadRootId))
    .where(
      and(
        eq(lookResearches.burrowId, burrowId),
        inArray(lookResearches.lookKey, [key, careKey(key)]),
        eq(messages.conversationId, chat.id),
        isNull(messages.threadRootId),
        isNull(messages.deletedAt),
        chat.roomClearedAt ? gt(messages.createdAt, chat.roomClearedAt) : undefined,
      ),
    )
    .orderBy(desc(lookResearches.startedAt))
    .limit(1);
  return row?.root ?? null;
}

export const startResearch = defineCommand({
  name: 'look.research_start',
  // A new turn: a lapsed appliance refuses it up front (LC-10).
  licence: 'agentTurn',
  schema: z.object({ look: ResearchLook, personId: z.string().min(1).max(64) }),
  async apply(tx, ctx, input): Promise<{ researchId: string; dispatchId: string } | null> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant looks into things by itself.');
    const { look } = input;
    const [live] = await tx
      .select({ id: lookResearches.id })
      .from(lookResearches)
      .where(
        and(
          eq(lookResearches.burrowId, ctx.burrow.id),
          eq(lookResearches.lookKey, look.key),
          isNull(lookResearches.goneAt),
        ),
      )
      .for('update');
    // Looked into already while it stays (LR-02).
    if (live) return null;
    const agent = await loadPrincipalRow(tx, ctx.actor.id);
    const person = await loadPrincipalRow(tx, input.personId);
    if (!agent || person?.kind !== 'person' || person.burrowId !== ctx.burrow.id || !person.accountId)
      return null;
    const chatId = await ensurePersonalDm(ctx, agent, person);
    const chat = await loadConversationRow(tx, chatId);
    if (!chat) return null;
    const id = newId('lookResearch');
    const thing = parseThingId(look.key);
    const earlier = await thingThread(tx, ctx.burrow.id, look.key, chat);
    const posted = await postMessage(ctx, {
      conversation: chat,
      text: researchOpening(look),
      threadRootId: earlier,
      clientId: openingClientId(id),
      // What the thread is about, for the turn and for the apps (CHT-05).
      subject: thing ? { kind: look.kind, id: thing.id.slice(0, 200), name: look.name.slice(0, 120) } : null,
      // The look itself tells the person: the thread never pushes or lands in the inbox (LR-04).
      mentions: [],
      dispatch: false,
      notifyMentions: false,
      notifyDmPerson: false,
    });
    const threadRootId = earlier ?? posted.id;
    const woken = await wakeQuietly(ctx, {
      agentId: agent.id,
      conversationId: chat.id,
      threadRootId,
      person: person.accountId,
      trigger: 'look',
      coalesce: false,
      own: true,
      messageId: posted.id,
      background: true,
    });
    // Nobody to look into it for here: nothing is posted either (the commit rolls back).
    if (!woken) throw notFound('Chat');
    await tx.insert(lookResearches).values({
      id,
      burrowId: ctx.burrow.id,
      agentId: agent.id,
      personId: person.id,
      lookKey: look.key,
      kind: look.kind,
      name: oneLine(look.name, 120),
      checkId: look.check,
      subject: look.subject,
      rank: look.rank,
      reason: look.reason,
      question: look.question,
      since: look.since,
      lines: look.lines,
      care: look.care ?? null,
      state: 'looking',
      conversationId: chat.id,
      threadRootId,
      dispatchId: woken.dispatchId,
      startedAt: ctx.now,
      stateAt: ctx.now,
    });
    await ctx.emit({
      type: 'look.research_started',
      kind: 'System',
      text: null,
      where: null,
      payload: { lookResearchId: id, conversationId: chat.id, dispatchId: woken.dispatchId },
    });
    await changed(ctx);
    return { researchId: id, dispatchId: woken.dispatchId };
  },
});

/* What it found (LR-05…LR-07) ------------------------------------------------------------------------------------- */

/** The person's own turns in a thread: their reply there may change a plan that waits (handle-it.md). */
const REPLY_TRIGGERS: ReadonlySet<string> = new Set(['dm', 'mention']);

/**
 * The research a `look` or `look_fix` turn works on; for the person's own reply in a thread where a plan or a step
 * waits for them, that research (they may change it); null in any other turn.
 */
export async function researchOfTurn(
  db: Db | Tx,
  dispatch: Pick<DispatchRow, 'id' | 'trigger' | 'burrowId'> &
    Partial<Pick<DispatchRow, 'threadRootId' | 'onBehalfOfAccountId'>>,
): Promise<LookResearchRow | null> {
  if (dispatch.trigger === 'look' || dispatch.trigger === 'look_fix') {
    const [row] = await db
      .select()
      .from(lookResearches)
      .where(and(eq(lookResearches.burrowId, dispatch.burrowId), eq(lookResearches.dispatchId, dispatch.id)))
      .orderBy(desc(lookResearches.startedAt))
      .limit(1);
    return row ?? null;
  }
  if (!REPLY_TRIGGERS.has(dispatch.trigger) || !dispatch.threadRootId || !dispatch.onBehalfOfAccountId)
    return null;
  const [row] = await db
    .select()
    .from(lookResearches)
    .where(
      and(
        eq(lookResearches.burrowId, dispatch.burrowId),
        eq(lookResearches.threadRootId, dispatch.threadRootId),
        eq(lookResearches.state, 'found'),
        isNull(lookResearches.goneAt),
      ),
    )
    .orderBy(desc(lookResearches.startedAt))
    .limit(1);
  return row && (row.plan?.length || row.fixLabel) ? row : null;
}

/** Whether `look_report` is this agent's in this turn (it is listed only then; LR-05). */
export async function looksInTurn(db: Db, agentId: string, dispatchId: string | undefined): Promise<boolean> {
  if (!dispatchId) return false;
  const [row] = await db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (!row || row.agentId !== agentId) return false;
  return (await researchOfTurn(db, row)) !== null;
}

/** Whether a connection look is Look only (LR-07): no step is offered or taken there. */
async function lookOnly(tx: Db | Tx, row: Pick<LookResearchRow, 'kind' | 'lookKey' | 'burrowId'>) {
  if (row.kind !== 'connection') return false;
  const id = parseThingId(row.lookKey)?.id;
  if (!id) return false;
  const [c] = await tx
    .select({ access: catalogConnections.access, burrowId: catalogConnections.burrowId })
    .from(catalogConnections)
    .where(eq(catalogConnections.id, id));
  return c?.burrowId === row.burrowId && c.access === 'read';
}

export const reportLook = defineCommand({
  name: 'look.report',
  schema: z.object({ dispatchId: z.string().min(1).max(64), report: LookReportInput }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant says what it found.');
    const [dispatch] = await tx.select().from(dispatches).where(eq(dispatches.id, input.dispatchId));
    const turnRow = dispatch?.burrowId === ctx.burrow.id ? await researchOfTurn(tx, dispatch) : null;
    const [row] = turnRow
      ? await tx.select().from(lookResearches).where(eq(lookResearches.id, turnRow.id)).for('update')
      : [];
    if (!row || row.agentId !== ctx.actor.id) throw forbidden(NOT_A_LOOK);
    const { report } = input;
    // No step where it may change nothing (LR-07), and none once it is fixed.
    const may = !report.fixed && !(await lookOnly(tx, row));
    // The care plan's steps it named (care-plan.md), in Whombat's words and in its order; only those it was offered.
    const offered = row.care?.steps ?? [];
    const careSteps = [...new Set(report.care ?? [])].flatMap((id) =>
      offered.filter((c) => c.care === id).slice(0, 1),
    );
    // A plan (handle-it.md): its steps, the one step first when it gave both. Once fixed the plan stays, for its card.
    const steps: LookPlanStepRow[] | null =
      may && (report.steps?.length || careSteps.length)
        ? [
            ...(report.fix ? [{ text: report.fix.label, step: report.fix.step }] : []),
            ...careSteps,
            ...(report.steps ?? []),
          ]
            .slice(0, LOOK_PLAN_STEPS_MAX)
            .map((p) => ({
              ...p,
              text: oneLine(p.text, LOOK_PLAN_STEP_MAX),
              step: p.step.trim().slice(0, LOOK_FIX_STEP_MAX),
            }))
        : null;
    const step = may && !steps && report.fix ? report.fix : null;
    const plan = report.fixed ? row.plan : steps;
    const state: LookResearchState = report.fixed ? 'fixed' : 'found';
    const title = oneLine(report.title, LOOK_TITLE_MAX);
    const [updated] = await tx
      .update(lookResearches)
      .set({
        state,
        title,
        summary: oneLine(report.summary, LOOK_SUMMARY_MAX),
        fixLabel: step ? oneLine(step.label, LOOK_FIX_LABEL_MAX) : null,
        fixStep: step ? step.step.trim().slice(0, LOOK_FIX_STEP_MAX) : null,
        plan,
        stateAt: ctx.now,
        reportedAt: ctx.now,
      })
      .where(eq(lookResearches.id, row.id))
      .returning();
    // The plan's card in the thread, once: a later report changes what it shows (it resolves on read).
    if (updated && steps && !row.planMessageId && row.conversationId) {
      const conversation = await loadConversationRow(tx, row.conversationId);
      if (conversation) {
        const posted = await postMessage(ctx, {
          conversation,
          text: planMessageText(title),
          card: { kind: 'look_plan', researchId: row.id },
          threadRootId: row.threadRootId,
          mentions: [],
          dispatch: false,
          notifyMentions: false,
          notifyDmPerson: false,
        });
        await tx
          .update(lookResearches)
          .set({ planMessageId: posted.id })
          .where(eq(lookResearches.id, row.id));
        updated.planMessageId = posted.id;
      }
    } else if (updated) await republishPlanCard(ctx, updated);
    // A step or a plan the person has to say yes to reaches them once; the thread itself stays quiet.
    if (updated && (steps || step)) await pushFinding(ctx, updated);
    // Fixed is something it finished: Done today says so in its words (LR-06; done-today.md DN-01).
    if (report.fixed && row.conversationId)
      await reportDoneCommand.apply(tx, ctx, {
        summary: oneLine(title, 60),
        conversationId: row.conversationId,
        threadRootId: row.threadRootId,
        personId: row.personId,
        dispatchId: input.dispatchId,
      });
    await ctx.emit({
      type: 'look.reported',
      kind: 'System',
      text: null,
      where: null,
      payload: { lookResearchId: row.id, state, step: step !== null },
    });
    await changed(ctx);
    return { lookResearchId: row.id, state };
  },
});

/* The step the person lets it take (LR-08) ------------------------------------------------------------------------ */

export const fixLook = defineCommand({
  name: 'look.fix',
  // The step is a new turn: a lapsed appliance refuses it up front (LC-10).
  licence: 'agentTurn',
  schema: z.object({ key: z.string().min(1).max(120) }),
  async apply(tx, ctx, input): Promise<{ research: LookResearch }> {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can let the assistant take a step.');
    const [row] = await tx
      .select()
      .from(lookResearches)
      .where(
        and(
          eq(lookResearches.burrowId, ctx.burrow.id),
          eq(lookResearches.lookKey, input.key),
          isNull(lookResearches.goneAt),
        ),
      )
      .for('update');
    const plan = row?.plan?.length ? row.plan : null;
    if (row?.state !== 'found' || (!plan && (!row.fixLabel || !row.fixStep))) throw notFound('Step');
    if (await lookOnly(tx, row)) throw notAllowed('This connection is Look only.');
    const person = await loadPrincipalRow(tx, ctx.actor.id);
    const conversation = row.conversationId ? await loadConversationRow(tx, row.conversationId) : null;
    if (!person?.accountId || !conversation) throw notFound('Step');
    // A care plan's automations are Whombat's to turn on, now, as the person's yes (care-plan.md); the turn after it
    // reads that they are on.
    const taken = plan ? await turnOnCareAutomations(ctx, conversation.id, plan) : null;
    // The look's thread while it is there; else the words start a thread of their own.
    const [root] = row.threadRootId
      ? await tx
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.id, row.threadRootId), eq(messages.conversationId, conversation.id)))
      : [];
    const posted = await postMessage(ctx, {
      conversation,
      text: plan ? GO_AHEAD_PLAN : goAheadText(row.fixLabel ?? ''),
      threadRootId: root?.id ?? null,
      clientId: goAheadClientId(row.id, ctx.now),
      dispatch: false,
    });
    const threadRootId = root?.id ?? posted.id;
    const woken = await wakeQuietly(ctx, {
      agentId: row.agentId,
      conversationId: conversation.id,
      threadRootId,
      person: person.accountId,
      trigger: 'look_fix',
      coalesce: false,
      own: true,
      messageId: posted.id,
    });
    if (!woken) throw notFound('Step');
    const [updated] = await tx
      .update(lookResearches)
      .set({
        state: 'fixing',
        dispatchId: woken.dispatchId,
        threadRootId,
        stateAt: ctx.now,
        ...(taken ? { plan: taken } : {}),
      })
      .where(eq(lookResearches.id, row.id))
      .returning();
    await ctx.emit({
      type: 'look.fix_asked',
      kind: 'System',
      text: null,
      where: null,
      payload: { lookResearchId: row.id, dispatchId: woken.dispatchId, messageId: posted.id, plan: !!plan },
    });
    await republishPlanCard(ctx, row);
    await changed(ctx);
    return { research: lookResearchOf(updated ?? row) };
  },
});

/* Settling (LR-02) ------------------------------------------------------------------------------------------------ */

/**
 * The threads of researches that ended which nobody needs any more: no research of a look still there is in it, and
 * the person didn't write in it since that research began. They settle as `resolved` (LR-04).
 */
async function settleEnded(
  ctx: ApplyContext,
  ended: readonly Pick<LookResearchRow, 'conversationId' | 'threadRootId' | 'personId' | 'startedAt'>[],
): Promise<void> {
  const byChat = new Map<string, string[]>();
  for (const r of ended) {
    if (!r.conversationId || !r.threadRootId) continue;
    const [live] = await ctx.tx
      .select({ id: lookResearches.id })
      .from(lookResearches)
      .where(and(eq(lookResearches.threadRootId, r.threadRootId), isNull(lookResearches.goneAt)))
      .limit(1);
    const [said] = r.personId
      ? await ctx.tx
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              or(eq(messages.id, r.threadRootId), eq(messages.threadRootId, r.threadRootId)),
              eq(messages.authorId, r.personId),
              gte(messages.createdAt, r.startedAt),
            ),
          )
          .limit(1)
      : [];
    if (live || said) continue;
    byChat.set(r.conversationId, [...(byChat.get(r.conversationId) ?? []), r.threadRootId]);
  }
  for (const [conversationId, roots] of byChat) await settleResolvedThreads(ctx, conversationId, roots);
}

export const settleResearch = defineCommand({
  name: 'look.settle',
  schema: z.object({
    /** Rows whose look went, or became a new problem. */
    gone: z.array(z.string().min(1).max(64)).max(100),
    /** Rows whose turn ended without a report. */
    unreported: z.array(z.string().min(1).max(64)).max(100),
    /** Findings whose look came back as it was: live again, nothing posted, no turn (LR-02). */
    revive: z.array(z.string().min(1).max(64)).max(100).default([]),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant settles what it looked into.');
    const mine = and(eq(lookResearches.burrowId, ctx.burrow.id), isNull(lookResearches.goneAt));
    let moved = 0;
    const ended = input.gone.length
      ? await tx
          .update(lookResearches)
          .set({ goneAt: ctx.now })
          .where(and(mine, inArray(lookResearches.id, input.gone)))
          .returning()
      : [];
    moved += ended.length;
    for (const r of ended) await republishPlanCard(ctx, r);
    for (const id of input.revive) {
      const [row] = await tx
        .select()
        .from(lookResearches)
        .where(
          and(
            eq(lookResearches.id, id),
            eq(lookResearches.burrowId, ctx.burrow.id),
            isNotNull(lookResearches.goneAt),
          ),
        )
        .for('update');
      if (row?.state !== 'found') continue;
      // One live research per look: one that began in between wins.
      const [live] = await tx
        .select({ id: lookResearches.id })
        .from(lookResearches)
        .where(and(mine, eq(lookResearches.lookKey, row.lookKey)));
      if (live) continue;
      await tx.update(lookResearches).set({ goneAt: null }).where(eq(lookResearches.id, row.id));
      moved += 1;
    }
    await settleEnded(ctx, ended);
    for (const id of input.unreported) {
      const [row] = await tx
        .select()
        .from(lookResearches)
        .where(and(mine, eq(lookResearches.id, id)))
        .for('update');
      if (!row || (row.state !== 'looking' && row.state !== 'fixing')) continue;
      // A research that never said what it found failed (the card says what it said before); a step that wasn't
      // reported on is offered again.
      const back = row.state === 'fixing' && ((row.fixLabel && row.fixStep) || row.plan?.length);
      await tx
        .update(lookResearches)
        .set({ state: back ? 'found' : 'failed', stateAt: ctx.now })
        .where(eq(lookResearches.id, row.id));
      await republishPlanCard(ctx, row);
      moved += 1;
    }
    // History older than a month goes; its thread stays in Chat.
    await tx
      .delete(lookResearches)
      .where(
        and(
          eq(lookResearches.burrowId, ctx.burrow.id),
          lt(lookResearches.goneAt, new Date(ctx.now.getTime() - RESEARCH_KEEP_MS)),
        ),
      );
    if (moved > 0) {
      await ctx.emit({
        type: 'look.settled',
        kind: 'System',
        text: null,
        where: null,
        payload: { gone: input.gone, unreported: input.unreported, revive: input.revive },
      });
      await changed(ctx);
    }
    return { moved };
  },
});

/**
 * Looks into a failed research once more, in its own thread (the watcher, `RETRY_AFTER_MS`): the same look, a new
 * `look` turn on its opening message, `looking` again. Nothing new is posted: the thread already says it is being
 * looked into. Null when the research went, isn't failed any more, or nobody can be woken there.
 */
export const retryResearch = defineCommand({
  name: 'look.research_retry',
  licence: 'agentTurn',
  schema: z.object({ researchId: z.string().min(1).max(64) }),
  async apply(tx, ctx, input): Promise<{ dispatchId: string } | null> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant looks into things by itself.');
    const [row] = await tx
      .select()
      .from(lookResearches)
      .where(
        and(
          eq(lookResearches.id, input.researchId),
          eq(lookResearches.burrowId, ctx.burrow.id),
          isNull(lookResearches.goneAt),
        ),
      )
      .for('update');
    if (row?.state !== 'failed' || !row.conversationId || !row.threadRootId || !row.personId) return null;
    const person = await loadPrincipalRow(tx, row.personId);
    if (!person?.accountId) return null;
    // Its own opening: a reply when it carries on the thing's earlier thread.
    const [opening] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, row.conversationId),
          eq(messages.authorId, row.agentId),
          eq(messages.clientId, openingClientId(row.id)),
        ),
      );
    const woken = await wakeQuietly(ctx, {
      agentId: row.agentId,
      conversationId: row.conversationId,
      threadRootId: row.threadRootId,
      person: person.accountId,
      trigger: 'look',
      coalesce: false,
      own: true,
      messageId: opening?.id ?? row.threadRootId,
      background: !row.askedById,
    });
    if (!woken) return null;
    await tx
      .update(lookResearches)
      .set({ state: 'looking', stateAt: ctx.now, dispatchId: woken.dispatchId })
      .where(eq(lookResearches.id, row.id));
    await ctx.emit({
      type: 'look.research_retried',
      kind: 'System',
      text: null,
      where: null,
      payload: { lookResearchId: row.id, dispatchId: woken.dispatchId },
    });
    await changed(ctx);
    return { dispatchId: woken.dispatchId };
  },
});

/* The person hands a thing to the assistant (handle-it.md) -------------------------------------------------------- */

/**
 * *Ask {assistant} to handle these* (`looks.handle`, as the person): their ask in the thing's thread and a `look` turn
 * on everything that needs a look there now, without waiting for the watcher's passes. While it looks or a step or plan
 * waits for them, the same research. Else a research that said what it found without a step, fixed what was there
 * then or failed goes to history and a new one begins (its old card says it is no longer needed). The person's ask
 * isn't the watcher's: it never counts against the day's researches. 404 when nothing needs a look there.
 */
export const handleLook = defineCommand({
  name: 'look.handle',
  // A new turn: a lapsed appliance refuses it up front (LC-10).
  licence: 'agentTurn',
  schema: z.object({ key: z.string().min(1).max(120), look: ResearchLook.nullable() }),
  async apply(tx, ctx, input): Promise<{ research: LookResearch }> {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can hand things to the assistant.');
    const [live] = await tx
      .select()
      .from(lookResearches)
      .where(
        and(
          eq(lookResearches.burrowId, ctx.burrow.id),
          eq(lookResearches.lookKey, input.key),
          isNull(lookResearches.goneAt),
        ),
      )
      .for('update');
    const waits = live?.state === 'found' && (live.plan?.length || live.fixLabel);
    if (live && (live.state === 'looking' || live.state === 'fixing' || waits))
      return { research: lookResearchOf(live) };
    // The server's care plan, while it is worked out, waits or is carried out, answers its missing backups, snapshots
    // and updates (care-plan.md): the same card, not a second plan.
    if (!live && input.look && onlyCareLines(input.look)) {
      const [care] = await tx
        .select()
        .from(lookResearches)
        .where(
          and(
            eq(lookResearches.burrowId, ctx.burrow.id),
            eq(lookResearches.lookKey, careKey(input.key)),
            isNull(lookResearches.goneAt),
          ),
        );
      const busy = care?.state === 'looking' || care?.state === 'fixing';
      if (care && (busy || (care.state === 'found' && care.plan?.length)))
        return { research: lookResearchOf(care) };
    }
    const look = input.look;
    if (!look || look.key !== input.key) throw notFound('Nothing needs a look there');
    const person = await loadPrincipalRow(tx, ctx.actor.id);
    const agent = await loadAgentRow(tx, ctx.burrow.id);
    if (!person?.accountId || !agent) throw notFound('Chat');
    const chatId = await ensurePersonalDm(ctx, agent, person);
    const chat = await loadConversationRow(tx, chatId);
    if (!chat) throw notFound('Chat');
    if (live) {
      await tx.update(lookResearches).set({ goneAt: ctx.now }).where(eq(lookResearches.id, live.id));
      await republishPlanCard(ctx, live);
    }
    const id = newId('lookResearch');
    const thing = parseThingId(look.key);
    const earlier = await thingThread(tx, ctx.burrow.id, look.key, chat);
    const posted = await postMessage(ctx, {
      conversation: chat,
      text: handleText(look.name),
      threadRootId: earlier,
      clientId: openingClientId(id),
      subject: thing ? { kind: look.kind, id: thing.id.slice(0, 200), name: look.name.slice(0, 120) } : null,
      dispatch: false,
    });
    const threadRootId = earlier ?? posted.id;
    const woken = await wakeQuietly(ctx, {
      agentId: agent.id,
      conversationId: chat.id,
      threadRootId,
      person: person.accountId,
      trigger: 'look',
      coalesce: false,
      own: true,
      messageId: posted.id,
    });
    if (!woken) throw notFound('Chat');
    const [row] = await tx
      .insert(lookResearches)
      .values({
        id,
        burrowId: ctx.burrow.id,
        agentId: agent.id,
        personId: person.id,
        lookKey: look.key,
        kind: look.kind,
        name: oneLine(look.name, 120),
        checkId: look.check,
        subject: look.subject,
        rank: Math.min(look.rank, live?.rank ?? look.rank),
        reason: look.reason,
        question: look.question,
        since: look.since,
        lines: look.lines,
        care: look.care ?? null,
        state: 'looking',
        conversationId: chat.id,
        threadRootId,
        dispatchId: woken.dispatchId,
        askedById: person.id,
        startedAt: ctx.now,
        stateAt: ctx.now,
      })
      .returning();
    await ctx.emit({
      type: 'look.handle_asked',
      kind: 'System',
      text: null,
      where: null,
      payload: {
        lookResearchId: id,
        conversationId: chat.id,
        dispatchId: woken.dispatchId,
        messageId: posted.id,
      },
    });
    await changed(ctx);
    if (!row) throw notFound('Chat');
    return { research: lookResearchOf(row) };
  },
});

export const LOOK_COMMANDS = [startResearch, reportLook, fixLook, settleResearch, retryResearch, handleLook];

/* The turn's context (LR-05, LR-08) ------------------------------------------------------------------------------- */

/**
 * `DispatchContext.look` of a `look` or `look_fix` turn, and of the person's reply in a thread where a step or plan
 * waits for them (`waiting`); null for any other turn.
 */
export async function lookContextOf(
  db: Db,
  row: Pick<DispatchRow, 'id' | 'trigger' | 'burrowId'> &
    Partial<Pick<DispatchRow, 'threadRootId' | 'onBehalfOfAccountId'>>,
): Promise<LookDispatchContext | null> {
  const r = await researchOfTurn(db, row);
  if (!r) return null;
  const reply = row.trigger !== 'look' && row.trigger !== 'look_fix';
  // A server's care plan is about the server (care-plan.md).
  const thing = parseThingId(careThingKey(r.lookKey) ?? r.lookKey);
  let connection: { handle: string; access: 'read' | 'manage' } | null = null;
  let runsOn: string | null = null;
  if (r.kind === 'connection' && thing) {
    const [c] = await db
      .select({
        handle: catalogConnections.handle,
        access: catalogConnections.access,
        burrowId: catalogConnections.burrowId,
        glance: catalogConnections.glance,
      })
      .from(catalogConnections)
      .where(eq(catalogConnections.id, thing.id));
    if (c?.burrowId === r.burrowId) {
      connection = { handle: c.handle, access: c.access };
      runsOn = c.glance?.machine?.serverId ?? null;
    }
  }
  const changes = thing ? await lookChanges(db, r.burrowId, thing, r.name, runsOn, r.since) : [];
  const acting = row.trigger === 'look_fix' || reply;
  const step = acting && r.fixLabel && r.fixStep ? { label: r.fixLabel, step: r.fixStep } : null;
  const plan = acting && r.plan?.length ? r.plan : null;
  // Whombat's care plan steps the turn may name (care-plan.md): while it looks and while the person may change its plan.
  // A step of a kind this release doesn't know (written by a newer one before a rollback) is left out.
  const offered = (r.care?.steps ?? []).flatMap((c) => {
    const id = CareStepId.safeParse(c.care);
    return id.success ? [{ ...c, care: id.data }] : [];
  });
  const care =
    offered.length && row.trigger !== 'look_fix'
      ? {
          new: r.care?.new === true,
          steps: offered.slice(0, LOOK_PLAN_STEPS_MAX).map((c) => ({
            id: c.care,
            text: c.text.slice(0, LOOK_PLAN_STEP_MAX),
            step: c.step.slice(0, LOOK_FIX_STEP_MAX),
          })),
        }
      : null;
  const lines = r.lines.slice(0, LOOK_LINES_MAX).map((l) => ({
    title: l.title.slice(0, 160),
    ...(l.check ? { check: l.check.slice(0, 80) } : {}),
    ...(l.subject ? { subject: l.subject.slice(0, 160) } : {}),
    ...(l.nature ? { nature: l.nature } : {}),
  }));
  return {
    key: r.lookKey,
    kind: r.kind,
    name: r.name.slice(0, 120),
    state: RANK_STATE[r.rank] ?? 'look',
    ...(r.reason ? { reason: r.reason.slice(0, 300) } : {}),
    ...(r.question ? { question: r.question.slice(0, 300) } : {}),
    ...(r.checkId ? { check: r.checkId.slice(0, 80) } : {}),
    ...(r.subject ? { subject: r.subject.slice(0, 160) } : {}),
    ...(r.since ? { since: r.since.toISOString() } : {}),
    ...(connection ? { connection: connection.handle, access: connection.access } : {}),
    ...(r.kind === 'server' && thing ? { server: thing.id.slice(0, 200) } : {}),
    ...(acting && r.title ? { found: { title: r.title, summary: r.summary ?? '' } } : {}),
    ...(step ? { step } : {}),
    ...(lines.length ? { lines } : {}),
    ...(r.askedById ? { asked: true } : {}),
    ...(plan
      ? {
          plan: plan.map((p) => ({
            text: p.text.slice(0, LOOK_PLAN_STEP_MAX),
            step: p.step.slice(0, LOOK_FIX_STEP_MAX),
          })),
        }
      : {}),
    ...(reply ? { waiting: true } : {}),
    ...(care ? { care } : {}),
    ...(changes.length ? { changes } : {}),
  };
}

/** How far before it went wrong a look reads what changed. */
const LOOK_CHANGES_BEFORE_MS = 48 * 60 * 60_000;

/**
 * What changed on the thing a look is about, and on the server it runs on, in the 48 hours before it went wrong (or
 * before now), newest first: the look may say what “changed just before”, never that it caused it.
 */
async function lookChanges(
  db: Db,
  burrowId: string,
  thing: { kind: string; id: string },
  name: string,
  runsOn: string | null,
  since: Date | null,
): Promise<NonNullable<LookDispatchContext['changes']>> {
  const own = `${thing.kind}:${thing.id}`;
  const server = runsOn ? `server:${runsOn}` : null;
  const from = new Date((since ?? new Date()).getTime() - LOOK_CHANGES_BEFORE_MS);
  const rows = await changesSince(db, burrowId, from, server ? [own, server] : [own], LOOK_CHANGES_MAX).catch(
    () => [],
  );
  return rows.map((c) => ({
    at: c.seenAt.toISOString(),
    words: changeWords(c.fact),
    on: (c.thingId === own ? name : (runsOn ?? name)).slice(0, 120),
    by: c.by,
  }));
}
