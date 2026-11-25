/**
 * Home and Watch for one person (docs/decisions/one-whombat.md ONE-05, ONE-07; one-whombat-assistant.md ONE-DW25…).
 *
 * Built in here: Needs you from the approvals the person may decide (Yes, do it · Tonight · No), their
 * assistant's open questions in their chats, and connections that need connecting again; Working on from the
 * assistant's newest open plan in their chats; Chats with the assistant (home-redesign.md HR-21, HR-40…HR-42: the
 * chats `chats.list` reads, ordered by `chats.ts`); Your things from the connections they may see (the health poller's
 * glance, the last call that worked); Automations today; their widgets; Done recently. The registry adds what other
 * parts know (servers, devices, enrollments, alerts). Watch: the connections that stopped working and the automations
 * that failed today, plus the registry's (server alerts, hints). A person's snoozes and acknowledgements apply to both.
 * The one Needs you list puts both together, each item in its group, and its `you` group is the count every place shows
 * (needs-you-list.md NYL-01…NYL-04); `needsYou` and `watch.list` stay as they were for an older app.
 */

import {
  type AutomationToday,
  catalogEntry,
  chatHref,
  chatThreadHref,
  DONE_RECENTLY_MAX,
  type HomeOverview,
  type HomeRef,
  isAgentConnection,
  isGatewayConnection,
  type LookResearch,
  NEEDS_YOU_FIRST_KINDS,
  type NeedsYouItem,
  needsYouCount,
  needsYouGroupOf,
  type ThingSummary,
  thingHref,
  thingId,
  type WatchItem,
  type WorkingTask,
} from '@whombat/core';
import { APPROVAL_ASK_WORDS } from '@whombat/core/approvals';
import { and, desc, eq, gt, gte, inArray, isNull, ne, or, type SQL, sql } from 'drizzle-orm';
import { windowStartOf } from '../care/window';
import { chatListTitle, chatRowsOf } from '../chats/read';
import { type ChatRoom, roomByKey } from '../chats/rooms';
import type { BurrowRow } from '../commit/types';
import { logoOf } from '../connections/look';
import type { Db } from '../db/client';
import {
  automationRuns,
  automations,
  catalogConnections,
  conversations,
  dispatches,
  messages,
  needsYouSnoozes,
  plans,
} from '../db/schema/index';
import { liveResearches } from '../looks/research';
import type { PrincipalRow } from '../read/principals';
import { loadAgentRow } from '../read/principals';
import type { Services } from '../services';
import { feedbackThing } from '../things/accounts/feedback';
import { displayName, partOfMap } from '../things/part-of';
import { connectionVerdict, withNotice } from '../things/quiet/connection';
import { NO_QUIET, type QuietBook, quietBook, type ThingQuiet } from '../things/quiet/store';
import { activeWindow, thingCause } from '../things/quiet/windows';
import { causeHref } from '../things/quiet/wire';
import { featureRequestItems } from '../trackers/features';
import { arrangedOf } from './arrange';
import { assistantCalled } from './assistant-name';
import { doneRecently } from './changes';
import {
  type ChatLine,
  type HomeChat,
  homeChats,
  type PlanProgress,
  planIsOpen,
  planProgress,
  workingStepsOf,
} from './chats';
import { doneToday } from './done';
import { githubThing } from './github-thing';
import { mailThings } from './mail-glance';
import { needsYouList, thingNames, withResearch } from './needs-you-list';
import { collectNeedsYou, collectThings, collectWatch, type SourceCtx, sourceReads } from './registry';
import { nextLocalTime, startOfLocalDay } from './time';
import type { ConnectionGlance } from './types';
import { listWidgets } from './widgets';

/** When “Remind me tomorrow” and “Not now” bring an item back: tomorrow at this local time (`home/time.ts`). */
export { SNOOZE_HOUR } from './time';

const SEVERITY_ORDER = { bad: 0, warn: 1, info: 2 } as const;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The viewer's assistant and their chats with it (its default DM and task chats not archived); with `rooms` (the
 * assistant shell, chat-channel.md CHT-08) their Chat and Feedback room marked as the threaded rooms they are.
 */
interface ViewerChats {
  agentId: string | null;
  name: string | null;
  ids: string[];
  lines: ChatLine[];
  /** The threaded rooms among `ids` (Chat, Feedback); a task chat isn't one. */
  rooms: Map<string, ChatRoom>;
}

async function viewerChats(
  db: Db,
  viewer: PrincipalRow,
  rooms = true,
  agentRow: Promise<PrincipalRow | undefined> = loadAgentRow(db, viewer.burrowId),
): Promise<ViewerChats> {
  const agent = await agentRow;
  if (!agent) return { agentId: null, name: null, ids: [], lines: [], rooms: new Map() };
  const rows = await chatRowsOf(db, viewer, agent.id);
  return {
    agentId: agent.id,
    name: agent.name,
    ids: rows.map((r) => r.id),
    rooms: new Map(
      rooms ? rows.flatMap((r) => (roomByKey(r) ? [[r.id, roomByKey(r) as ChatRoom] as const] : [])) : [],
    ),
    lines: rows.map((r) => ({
      id: r.id,
      title: chatListTitle(r, agent.name),
      lastAt: r.lastMessageAt ?? r.createdAt,
      default: r.taskKey === null,
    })),
  };
}

/** A Needs you item and the chat with the assistant it waits in, if any (a chat's `waiting`, HR-41). */
interface Sourced {
  item: NeedsYouItem;
  conversationId: string | null;
}

/* Needs you ------------------------------------------------------------------------------------- */

/**
 * The pending approvals the viewer may decide (the rule of `decidablePendingCount`), newest first. A retired agent's
 * requests are left out (assistant-name.md AN-08): retiring withdraws them (EP-08), and one an older binary left
 * pending asks for something nobody will do.
 */
async function decidableApprovals(db: Db, burrowId: string, viewer: PrincipalRow) {
  if (viewer.kind !== 'person') return [];
  // The person decides every approval (one-person.md OP-S62).
  return db.execute<{
    id: string;
    number: number;
    title: string;
    question: string;
    explainer: string;
    summary: string;
    conversation_id: string;
    created_at: string;
  }>(sql`
    select a.id, a.number, a.title, a.question, a.explainer, a.summary, a.conversation_id, a.created_at
      from approvals a
     where a.burrow_id = ${burrowId} and a.state = 'pending'
     order by a.created_at desc
     limit 30`);
}

/**
 * An approval's buttons in Needs you, in the words and order of the card in its thread: Yes, now · Yes, tonight · No.
 * Yes, tonight runs it when the quiet hours for changes next start (care-plan.md; 03:00 unless the person moved them).
 */
export const APPROVAL_WORDS = {
  yes: APPROVAL_ASK_WORDS.now,
  tonight: APPROVAL_ASK_WORDS.later,
  no: APPROVAL_ASK_WORDS.no,
} as const;

async function approvalItems(ctx: SourceCtx, viewer: PrincipalRow, burrow: BurrowRow): Promise<Sourced[]> {
  const rows = await decidableApprovals(ctx.db, burrow.id, viewer);
  const start = windowStartOf(burrow);
  const later = nextLocalTime(ctx.now, burrow.timeZone, start.hour, start.minute);
  return rows.map((r) => ({
    conversationId: r.conversation_id,
    item: {
      id: `approval:${r.number}`,
      ref: { kind: 'approval', id: String(r.number) },
      kind: 'approval',
      severity: 'warn',
      title: clip(r.question || r.title, 200),
      body: clip(r.explainer || r.summary || '', 600),
      at: new Date(r.created_at).toISOString(),
      approvalNumber: r.number,
      // The approval's words everywhere (needs-you-list.md NYL-08): a yes, a yes for tonight, a no.
      actions: [
        { id: 'approve', label: APPROVAL_WORDS.yes, style: 'primary', kind: 'approve' },
        {
          id: 'later',
          label: APPROVAL_WORDS.tonight,
          style: 'secondary',
          kind: 'approve_later',
          at: later.toISOString(),
        },
        { id: 'decline', label: APPROVAL_WORDS.no, style: 'secondary', kind: 'decline' },
      ],
    },
  }));
}

/**
 * The assistant's questions in the viewer's chats they haven't answered yet: in a task chat a later message of theirs
 * answers; in a threaded room (Chat, Feedback; CHT-08) a later message of theirs in that thread, and Answer opens it.
 */
async function questionItems(ctx: SourceCtx, viewer: PrincipalRow, chats: ViewerChats): Promise<Sourced[]> {
  const { agentId, name, ids, rooms } = chats;
  if (!agentId || !ids.length) return [];
  const later = sql`r.conversation_id = ${messages.conversationId} and r.author_id = ${viewer.id}
    and r.ord > ${messages.ord} and r.deleted_at is null`;
  const questionsIn = (chatIds: string[], unanswered: SQL) =>
    ctx.db
      .select({
        id: messages.id,
        text: messages.text,
        createdAt: messages.createdAt,
        conversationId: messages.conversationId,
        threadRootId: messages.threadRootId,
        chatTitle: conversations.chatTitle,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          inArray(messages.conversationId, chatIds),
          eq(messages.authorId, agentId),
          eq(messages.asks, true),
          eq(messages.outsidersRun, false),
          isNull(messages.provenance),
          isNull(messages.deletedAt),
          unanswered,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(10);
  // Each kind of chat on its own, so each check uses an index: in a threaded room the thread's few replies by its root,
  // in a task chat only the task chats' messages, instead of every message of the room once per question.
  const threaded = ids.filter((id) => rooms.has(id));
  const others = ids.filter((id) => !rooms.has(id));
  const inThreads = threaded.length
    ? questionsIn(
        threaded,
        sql`not exists (select 1 from messages r
          where r.thread_root_id = coalesce(${messages.threadRootId}, ${messages.id}) and ${later})`,
      )
    : null;
  const inTasks = others.length
    ? questionsIn(
        others,
        sql`not exists (select 1 from messages r where ${later} and r.conversation_id in (${sql.join(
          others.map((id) => sql`${id}`),
          sql`, `,
        )}))`,
      )
    : null;
  const rows = await (inThreads && inTasks
    ? inThreads.unionAll(inTasks).orderBy(desc(messages.createdAt)).limit(10)
    : (inThreads ?? inTasks ?? []));
  return rows.map((r) => {
    const first =
      r.text
        .split('\n')
        .find((l) => l.trim())
        ?.trim() ?? `${assistantCalled(name)} asked you something.`;
    const room = rooms.get(r.conversationId);
    return {
      conversationId: r.conversationId,
      item: {
        id: `question:${r.id}`,
        ref: { kind: 'question', id: r.id },
        kind: 'question',
        severity: 'info',
        title: clip(first.replace(/[*_`#>]/g, ''), 200),
        body:
          room === 'feedback'
            ? 'In Feedback'
            : r.chatTitle && !room
              ? clip(`In “${r.chatTitle}”`, 600)
              : `In your chat with ${assistantCalled(name, false)}`,
        at: r.createdAt.toISOString(),
        actions: [
          {
            id: 'answer',
            label: 'Answer',
            style: 'primary',
            kind: 'open',
            // The thread it asks in (CHT-08); a task chat from before Chat opens as itself.
            href: room ? chatThreadHref(room, r.threadRootId ?? r.id) : chatHref(r.conversationId),
          },
        ],
      } satisfies NeedsYouItem,
    };
  });
}

/**
 * The burrow's connections: the agent's and the AI gateways (fusebox-page.md FP-01), not those only automations use.
 */
async function visibleConnections(db: Db, viewer: PrincipalRow) {
  const rows = await db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.burrowId, viewer.burrowId));
  return rows.filter((r) => homeShowsConnection(r.catalogId));
}

/** Home shows a connection of this catalog id among its things (the desk's calm glance reads the same ones). */
export function homeShowsConnection(catalogId: string): boolean {
  const entry = catalogEntry(catalogId);
  // The Servers connection and devices are shown by their own parts (SH, SD); trackers only automations use.
  return !!entry && entry.transport !== 'builtin' && (isAgentConnection(entry) || isGatewayConnection(entry));
}

/**
 * Connections that need connecting again; not when the person ignored it, snoozed it or Whombat doesn't watch its sign-in
 * (quiet-notices.md QN-21, QN-22).
 */
async function connectionItems(reads: HomeReads, now: Date): Promise<NeedsYouItem[]> {
  const [all, book] = await Promise.all([reads.connections(), reads.quiet()]);
  const rows = all.filter(
    (r) =>
      r.status === 'needs_reauth' &&
      connectionVerdict(r, book.of(thingId('connection', r.id)), now)?.status !== 'ok',
  );
  if (!rows.length) return [];
  const assistant = assistantCalled(await reads.assistantName());
  return rows.map((r) => ({
    id: `connection:${r.id}`,
    ref: { kind: 'connection', id: r.id },
    kind: 'connection',
    severity: 'bad',
    // Only a person can sign in again (QN-01).
    nature: 'you',
    title: clip(`${r.label} needs you to sign in again`, 200),
    // A gateway carries turns with Whombat's own key; what stops is reading its limits (FP-01).
    body: isGatewayConnection(r.catalogId)
      ? 'Whombat can’t read its limits until then.'
      : `${assistant} can’t use it until then.`,
    at: (r.checkedAt ?? r.updatedAt).toISOString(),
    subject: { kind: 'connection', id: r.id, name: clip(r.label, 120) },
    actions: [
      {
        id: 'reconnect',
        label: 'Sign in again',
        style: 'primary',
        kind: 'open',
        href: thingHref('connection', r.id),
      },
    ],
  }));
}

/**
 * The line behind a connection's Needs you or Watch item, as `things.quiet` takes it (QN-21, QN-S18): signed out is
 * `conn.signin`; otherwise the worst active line of its glance. Null when it has none (an older glance, or nothing).
 */
export async function connectionNoticeRef(
  services: Services,
  viewer: PrincipalRow,
  connectionId: string,
  now: Date,
): Promise<{ check: string; subject?: string } | null> {
  const [row] = await services.db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.id, connectionId));
  if (!row) return null;
  if (row.status === 'needs_reauth') return { check: 'conn.signin' };
  const book = await quietBook(services.db, [viewer.burrowId]);
  const worst = connectionVerdict(row, book.of(thingId('connection', row.id)), now)?.worst;
  if (!worst?.check) return null;
  return { check: worst.check, ...(worst.subject ? { subject: worst.subject.id } : {}) };
}

/* Your things ----------------------------------------------------------------------------------- */

/** “08:12” in the burrow's zone. */
function localTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}

/**
 * A connection as a thing: the health poller's glance, or its state when there is none yet. `partOf`: the server a
 * Proxmox or Unraid connection is part of (connection-pages.md CP-10); the sidebar and Home's tiles leave it out.
 * `usedAt`: the last call that worked (home-redesign.md HR-45, CT-404), for “Connected · used today” when it has no
 * figures; absent before the first.
 */
export function connectionThing(
  row: Pick<
    typeof catalogConnections.$inferSelect,
    'id' | 'catalogId' | 'label' | 'status' | 'glance' | 'glanceAt' | 'fields' | 'lastWorkedAt' | 'logo'
  >,
  timeZone: string,
  partOf?: string | null,
  quiet: { of: ThingQuiet; now: Date } = { of: NO_QUIET, now: new Date() },
): ThingSummary {
  const glance = row.glance as ConnectionGlance | null;
  // The dot from the lines that aren't quiet (quiet-notices.md QN-14, QN-S07); the line on the card stays true.
  const v = connectionVerdict(row, quiet.of, quiet.now);
  const base = {
    id: thingId('connection', row.id),
    kind: 'connection' as const,
    ...(/^[a-z][a-z0-9_]{1,30}$/.test(row.catalogId) ? { catalogId: row.catalogId } : {}),
    name: clip(displayName(row), 120),
    icon: row.catalogId.slice(0, 40),
    ...(logoOf(row) ? { logo: logoOf(row) } : {}),
    href: thingHref('connection', row.id),
    ...(partOf ? { partOf } : {}),
    ...(row.lastWorkedAt ? { usedAt: row.lastWorkedAt.toISOString() } : {}),
  };
  // Kept quiet says so whatever else the thing shows, signing in again included.
  const window = activeWindow(quiet.of.windows, quiet.now);
  const quietUntil = window ? { quietUntil: window.endsAt.toISOString() } : {};
  if (row.status === 'needs_reauth') {
    const status = v?.status ?? 'bad';
    return withNotice(
      {
        ...base,
        status,
        line: 'Needs you to sign in again',
        ...(status !== 'ok' ? { reason: 'Needs you to sign in again' } : {}),
        facts: [],
        ...quietUntil,
      },
      v?.notice,
      v?.asking,
    );
  }
  if (glance) {
    // Down because of something else: grey, its line saying why, no reason of its own; quiet
    // with a server kept quiet keeps its dot and line.
    const cause =
      v?.held?.kind === 'cause' && v.held.cause
        ? thingCause(v.held.cause, causeHref(v.held.cause.causeThing))
        : null;
    const down = cause && cause.kind !== 'quiet' ? cause : null;
    const status = down ? 'unknown' : (v?.status ?? glance.status);
    const reason = v ? v.reason : glance.reason;
    return withNotice(
      {
        ...base,
        status,
        // Why it isn't fine (sidebar.md SB-03), for the sidebar's dot.
        ...(status !== 'ok' && !down && reason ? { reason: clip(reason, 160) } : {}),
        ...(down
          ? { line: clip(down.words, 160) }
          : glance.line
            ? { line: clip(glance.line, 160) }
            : row.glanceAt
              ? { line: `Last checked ${localTime(row.glanceAt, timeZone)}` }
              : {}),
        facts: glance.facts.slice(0, 8),
        ...(cause ? { causedBy: cause } : {}),
        ...quietUntil,
      },
      v?.notice,
      v?.asking,
    );
  }
  return { ...base, status: 'unknown', line: 'Not checked yet', facts: [], ...quietUntil };
}

const KIND_ORDER = { server: 0, connection: 1, device: 2 } as const;

function sortThings(things: ThingSummary[]): ThingSummary[] {
  return things.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
}

/* Working on, Automations today ----------------------------------------------------------------- */

interface WorkingOn {
  task: WorkingTask | null;
  count: number;
  /** The newest unfinished plan's chat and when it last changed (a chat's `working`, HR-40). */
  planChat: { conversationId: string; at: Date } | null;
  /** Each chat's newest unfinished plan, for its row's progress and step. */
  progress: Map<string, PlanProgress>;
}

/** The assistant's newest plan in the viewer's chats that still has steps to do, as steps with a progress bar. */
async function workingOn(db: Db, chats: ViewerChats): Promise<WorkingOn> {
  const none: WorkingOn = { task: null, count: 0, planChat: null, progress: new Map() };
  if (!chats.ids.length) return none;
  const rows = await db
    .select()
    .from(plans)
    .where(inArray(plans.conversationId, chats.ids))
    .orderBy(desc(plans.updatedAt))
    .limit(20);
  const open = rows.filter((p) => planIsOpen(p.steps));
  const plan = open[0];
  if (!plan) return none;
  const progress = new Map<string, PlanProgress>();
  for (const p of open)
    if (!progress.has(p.conversationId)) progress.set(p.conversationId, planProgress(p.steps));
  const steps = workingStepsOf(plan.steps);
  return {
    count: open.length,
    planChat: { conversationId: plan.conversationId, at: plan.updatedAt },
    progress,
    task: {
      conversationId: plan.conversationId,
      title: clip(plan.title, 160),
      startedAt: (plan.createdAt ?? plan.updatedAt).toISOString(),
      progress: { done: steps.filter((s) => s.state === 'done').length, total: steps.length },
      steps,
    },
  };
}

/**
 * The viewer's chats a turn of their assistant is claimed or running in (its status `working`, agent-status.md AS-03),
 * with when the newest started. One indexed read of the assistant's live turns (`dispatches_agent_idx`).
 */
async function chatTurns(db: Db, chats: ViewerChats): Promise<Map<string, Date>> {
  const turns = new Map<string, Date>();
  if (!chats.agentId || !chats.ids.length) return turns;
  const rows = await db
    .select({
      conversationId: dispatches.conversationId,
      claimedAt: dispatches.claimedAt,
      createdAt: dispatches.createdAt,
    })
    .from(dispatches)
    .where(
      and(
        eq(dispatches.agentId, chats.agentId),
        inArray(dispatches.state, ['claimed', 'running']),
        // A Looks ahead check is quiet: no chat shows as being worked on for it (looks-ahead.md).
        ne(dispatches.trigger, 'ahead'),
      ),
    )
    .limit(50);
  const mine = new Set(chats.ids);
  for (const r of rows) {
    if (!mine.has(r.conversationId)) continue;
    const at = r.claimedAt ?? r.createdAt;
    const seen = turns.get(r.conversationId);
    if (!seen || seen.getTime() < at.getTime()) turns.set(r.conversationId, at);
  }
  return turns;
}

/**
 * The viewer's automations today: those they made, and those whose runs post where they are; the newest run of each
 * today (ran or failed), and the ones still to run today (`scheduled`).
 */
async function automationsToday(db: Db, viewer: PrincipalRow, burrow: BurrowRow, now: Date) {
  const since = startOfLocalDay(now, burrow.timeZone);
  const until = new Date(since.getTime() + 36 * 3600_000);
  const tomorrow = startOfLocalDay(until, burrow.timeZone);
  const mine = await db
    .select({
      id: automations.id,
      name: automations.name,
      nextFireAt: automations.nextFireAt,
      status: automations.status,
    })
    .from(automations)
    .where(
      and(
        eq(automations.burrowId, burrow.id),
        isNull(automations.deletedAt),
        // Theirs, or one that ran lately: its rooms are all the person's.
        or(
          eq(automations.createdById, viewer.id),
          sql`exists (select 1 from ${automationRuns} r
                where r.automation_id = ${automations.id}
                  and r.created_at >= ${since.toISOString()}::timestamptz)`,
        ),
      ),
    );
  if (!mine.length) return [];
  const runs = await db
    .select({
      automationId: automationRuns.automationId,
      status: automationRuns.status,
      at: automationRuns.createdAt,
      finishedAt: automationRuns.finishedAt,
    })
    .from(automationRuns)
    .where(
      and(
        inArray(
          automationRuns.automationId,
          mine.map((a) => a.id),
        ),
        gte(automationRuns.createdAt, since),
        eq(automationRuns.test, false),
      ),
    )
    .orderBy(desc(automationRuns.createdAt));
  const out: AutomationToday[] = [];
  for (const a of mine) {
    const last = runs.find((r) => r.automationId === a.id);
    if (last && ['succeeded', 'failed', 'cancelled'].includes(last.status))
      out.push({
        id: a.id,
        name: clip(a.name, 80),
        state: last.status === 'succeeded' ? 'ran' : 'failed',
        at: (last.finishedAt ?? last.at).toISOString(),
      });
    else if (
      a.status === 'published' &&
      a.nextFireAt &&
      a.nextFireAt.getTime() > now.getTime() &&
      a.nextFireAt.getTime() < tomorrow.getTime()
    )
      out.push({ id: a.id, name: clip(a.name, 80), state: 'scheduled', at: a.nextFireAt.toISOString() });
  }
  return out.sort((x, y) => x.at.localeCompare(y.at)).slice(0, 50);
}

/* Snoozes --------------------------------------------------------------------------------------- */

/** A person's own mark on an item: snoozed until a time, acknowledged for a week, or ignored for good (no end). */
type Mark = { state: 'snoozed' | 'acknowledged' | 'ignored'; until: Date | null };

async function marksOf(db: Db, viewer: PrincipalRow, now: Date): Promise<Map<string, Mark>> {
  const rows = await db
    .select()
    .from(needsYouSnoozes)
    .where(
      and(
        eq(needsYouSnoozes.personId, viewer.id),
        or(isNull(needsYouSnoozes.until), gt(needsYouSnoozes.until, now)),
      ),
    );
  return new Map(rows.map((r) => [`${r.refKind}:${r.refId}`, { state: r.state, until: r.until }]));
}

const refKey = (ref: HomeRef) => `${ref.kind}:${ref.id}`;

/* The overview ---------------------------------------------------------------------------------- */

export interface HomeViewer {
  burrow: BurrowRow;
  principal: PrincipalRow;
}

/**
 * The reads one Home read shares among its sections and the registry's sources (an overview, a desk glance): each made
 * at most once and dropped with the read, so the next read never sees an old answer. A standalone section starts its own
 * and reads only what it needs. `known.agent`: the burrow's agent, when the caller has its row already (the desk's place).
 */
export function homeReads(
  services: Services,
  viewer: HomeViewer,
  now: Date,
  known: { agent?: PrincipalRow } = {},
) {
  const db = services.db;
  const person = viewer.principal;
  let connections: ReturnType<typeof visibleConnections> | undefined;
  let marks: ReturnType<typeof marksOf> | undefined;
  let agent: Promise<PrincipalRow | undefined> | undefined;
  let quiet: Promise<QuietBook> | undefined;
  let chats: Promise<ViewerChats> | undefined;
  let research: Promise<Map<string, LookResearch>> | undefined;
  const agentRow = () =>
    (agent ??= known.agent ? Promise.resolve(known.agent) : loadAgentRow(db, person.burrowId));
  const quietRows = () => (quiet ??= quietBook(db, [person.burrowId]));
  const shared = sourceReads(person, quietRows);
  const ctx: SourceCtx = {
    db,
    burrowId: viewer.burrow.id,
    personId: person.id,
    now,
    services,
    reads: shared,
  };
  return {
    /** What the registry's sources read with, sharing these reads. */
    ctx,
    /** The reads a part outside Home shares (the desk's fleet). */
    shared,
    connections: () => (connections ??= visibleConnections(db, person)),
    marks: () => (marks ??= marksOf(db, person, now)),
    /** The burrow's one agent (one-agent.md OA-01): its chats with the viewer and the name Whombat's words use. */
    agent: agentRow,
    assistantName: () => agentRow().then((row) => row?.name ?? null),
    /** What is quiet for the burrow's things (QN-14). */
    quiet: quietRows,
    /** The viewer's chats with the agent, for Needs you, Working on and Chats. */
    chats: () => (chats ??= viewerChats(db, person, true, agentRow())),
    /** What the assistant found out about each look; none when it can't be read. */
    research: () =>
      (research ??= liveResearches(db, viewer.burrow.id).catch(() => new Map<string, LookResearch>())),
  };
}

export type HomeReads = ReturnType<typeof homeReads>;

/**
 * Every Needs you item of the viewer, snoozed ones left out, worst first then newest; the ones they snoozed or ignored,
 * marked so (for the list's foot); and the chats with the assistant those items wait in, with the newest item's time (a
 * chat's `waiting`, HR-41).
 */
async function needsYouOf(
  services: Services,
  viewer: HomeViewer,
  now: Date,
  reads: HomeReads,
): Promise<{
  items: NeedsYouItem[];
  quiet: NeedsYouItem[];
  waiting: Map<string, Date>;
  research: Map<string, LookResearch>;
}> {
  const ctx = reads.ctx;
  const chats = reads.chats();
  const [approvals, asked, features, reconnect, others, marks, mine, name] = await Promise.all([
    approvalItems(ctx, viewer.principal, viewer.burrow),
    chats.then((c) => questionItems(ctx, viewer.principal, c)),
    // Tracker feature requests waiting for the person's answer (report-trackers.md TA-44).
    featureRequestItems(services.db, viewer.burrow.id),
    connectionItems(reads, now),
    collectNeedsYou(ctx),
    reads.marks(),
    chats,
    reads.assistantName(),
  ]);
  const questions = [...asked, ...features];
  const chatIds = new Set(mine.ids);
  const waiting = new Map<string, Date>();
  for (const { item, conversationId } of [...approvals, ...questions]) {
    if (!conversationId || !chatIds.has(conversationId) || marks.has(refKey(item.ref))) continue;
    const at = new Date(item.at);
    const seen = waiting.get(conversationId);
    if (!seen || seen.getTime() < at.getTime()) waiting.set(conversationId, at);
  }
  const research = await reads.research();
  const ask = askWord(name);
  const all = [
    ...approvals.map((a) => a.item),
    ...questions.map((q) => q.item),
    ...reconnect,
    ...others.items,
  ]
    .map((i) => withAskWord(i, ask))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.at.localeCompare(a.at));
  const items = all
    .filter((i) => !marks.has(refKey(i.ref)))
    .slice(0, 50)
    .map((i) => withResearch(i, research))
    .map((i) => ({ ...i, group: needsYouGroupOf(i) }));
  const quiet = all.flatMap((i): NeedsYouItem[] => {
    const mark = marks.get(refKey(i.ref));
    if (!mark) return [];
    return [
      mark.state === 'snoozed'
        ? { ...i, state: 'snoozed', ...(mark.until ? { snoozedUntil: mark.until.toISOString() } : {}) }
        : { ...i, state: 'acknowledged' },
    ];
  });
  return { items, quiet, waiting, research };
}

/** *Ask {assistant}* (needs-you-list.md NYL-07): the word the apps and an older app's *Look into it* button say. */
function askWord(name: string | null): string {
  return `Ask ${assistantCalled(name, false)}`.slice(0, 60);
}

/** An item's *Look into it* says *Ask {assistant}*: it asks in the thing's own thread now. */
function withAskWord(item: NeedsYouItem, ask: string): NeedsYouItem {
  if (!item.actions.some((a) => a.kind === 'investigate')) return item;
  return { ...item, actions: item.actions.map((a) => (a.kind === 'investigate' ? { ...a, label: ask } : a)) };
}

/**
 * Every Needs you item of the viewer, snoozed ones left out, worst first then newest. `reads`: the ones the caller's
 * whole read shares (the desk's glance), else its own.
 */
export async function needsYou(
  services: Services,
  viewer: HomeViewer,
  now = services.clock(),
  reads = homeReads(services, viewer, now),
) {
  return (await needsYouOf(services, viewer, now, reads)).items;
}

/**
 * What the viewer's assistant works on for them (Working on, mock 1): its newest open plan in their chats, or null. The
 * desk screen's glance reads it (docs/decisions/desk-display-server.md DK-S08), sharing its reads.
 */
export async function workingTask(
  services: Services,
  viewer: HomeViewer,
  reads = homeReads(services, viewer, services.clock()),
): Promise<WorkingTask | null> {
  return (await workingOn(services.db, await reads.chats())).task;
}

/** The viewer's things: connections here, servers and devices from the registry. `reads` as for `needsYou`. */
export async function things(
  services: Services,
  viewer: HomeViewer,
  now = services.clock(),
  reads = homeReads(services, viewer, now),
) {
  return thingsOf(services, viewer, now, reads);
}

async function thingsOf(services: Services, viewer: HomeViewer, now: Date, reads: HomeReads) {
  const [connections, book, others] = await Promise.all([
    reads.connections(),
    reads.quiet(),
    collectThings(reads.ctx),
  ]);
  const [partOf, mail, github, feedback] = await Promise.all([
    partOfMap(services, viewer.burrow.id, connections).catch(() => new Map<string, string>()),
    mailThings(services, services.db, viewer.principal, { book, now }),
    githubThing(services, viewer.burrow.id).catch(() => null),
    feedbackThing(services, { burrowId: viewer.burrow.id, principal: viewer.principal }).catch(() => null),
  ]);
  // The accounts (mail, GitHub, Website feedback) say they are kept quiet as any connection does.
  const kept = (thing: ThingSummary): ThingSummary => {
    const window = activeWindow(book.of(thing.id).windows, now);
    return window ? { ...thing, quietUntil: window.endsAt.toISOString() } : thing;
  };
  return sortThings([
    ...connections.map((r) =>
      connectionThing(r, viewer.burrow.timeZone, partOf.get(r.id), {
        of: book.of(thingId('connection', r.id)),
        now,
      }),
    ),
    ...mail.map(kept),
    ...(github ? [kept(github)] : []),
    ...(feedback ? [kept(feedback)] : []),
    ...others.items,
  ]).slice(0, 200);
}

/**
 * What needs attention but isn't a decision (`watch.list`, which an older app still reads). `open`: without snoozed and
 * acknowledged items. Heads-ups never: only the Needs you list shows them.
 */
export async function watchList(
  services: Services,
  viewer: HomeViewer,
  options: { state?: 'open' | 'all' } = {},
  now = services.clock(),
): Promise<WatchItem[]> {
  const items = await watchListOf(services, viewer, options, now, homeReads(services, viewer, now));
  return items.filter((i) => i.nature !== 'fyi');
}

/** Watch's items, heads-ups among them (`nature: fyi`). */
async function watchListOf(
  services: Services,
  viewer: HomeViewer,
  options: { state?: 'open' | 'all' },
  now: Date,
  reads: HomeReads,
): Promise<WatchItem[]> {
  const since = new Date(now.getTime() - 24 * 3600_000);
  const [connections, failedRuns, others, marks, assistantName, book] = await Promise.all([
    reads.connections(),
    services.db
      .select({
        runId: automationRuns.id,
        number: automationRuns.number,
        automationId: automationRuns.automationId,
        name: automations.name,
        error: automationRuns.error,
        at: automationRuns.finishedAt,
        createdAt: automationRuns.createdAt,
      })
      .from(automationRuns)
      .innerJoin(automations, eq(automations.id, automationRuns.automationId))
      .where(
        and(
          eq(automationRuns.burrowId, viewer.burrow.id),
          eq(automationRuns.status, 'failed'),
          gte(automationRuns.createdAt, since),
          eq(automationRuns.test, false),
          isNull(automations.deletedAt),
        ),
      )
      .orderBy(desc(automationRuns.createdAt))
      .limit(20),
    collectWatch(reads.ctx),
    reads.marks(),
    reads.assistantName(),
    reads.quiet(),
  ]);
  const items: WatchItem[] = [];
  for (const r of connections) {
    const glance = r.glance as ConnectionGlance | null;
    // What is ignored, snoozed or not watched stays out (quiet-notices.md QN-22).
    const v = connectionVerdict(r, book.of(thingId('connection', r.id)), now);
    const status = v?.status ?? (r.status === 'needs_reauth' ? 'bad' : glance?.status);
    // A watched problem at warn (a part of it down, “Fitness is offline”) needs the person as it does on the desk
    // screen; a connection's heads-ups stay on its page (NYL-12).
    const warn = status === 'warn' && !!v?.worst && v.worst.nature !== 'fyi';
    if (status !== 'bad' && status !== 'offline' && !warn) continue;
    const gateway = isGatewayConnection(r.catalogId);
    const reason = v ? v.reason : glance?.reason;
    // A line of its own says why (“Claude used up until Thu 09:00”, fusebox-page.md FP-05; “Internet down”): a check
    // that got no answer says it isn't answering.
    const said =
      r.status !== 'needs_reauth' &&
      (status === 'bad' || warn) &&
      (v ? v.worst?.check !== 'conn.answers' : gateway)
        ? (reason ?? v?.worst?.title)
        : undefined;
    items.push({
      id: `connection:${r.id}`,
      ref: { kind: 'connection', id: r.id },
      source: 'connection',
      severity: warn ? 'warn' : 'bad',
      nature: v?.worst?.nature === 'you' || (!v && r.status === 'needs_reauth') ? 'you' : 'problem',
      title: clip(
        r.status === 'needs_reauth'
          ? `${r.label} needs you to sign in again`
          : said
            ? `${r.label}: ${said}`
            : `${r.label} isn’t answering`,
        200,
      ),
      body: clip(
        r.status === 'needs_reauth'
          ? gateway
            ? 'Whombat can’t read its limits until then.'
            : `${assistantCalled(assistantName)} can’t use it until then.`
          : said
            ? gateway
              ? 'Its page says what is left and when it comes back.'
              : 'Its page says more.'
            : (glance?.line ?? 'The last check got no answer.'),
        600,
      ),
      at: (r.glanceAt ?? r.checkedAt ?? r.updatedAt).toISOString(),
      state: 'open',
      href: thingHref('connection', r.id),
      // Stop watching this (on-purpose.md): the line behind it, as `things.setWatch` takes it; signing in again isn't.
      ...(r.status !== 'needs_reauth' && v?.worst?.check
        ? {
            watch: {
              thing: thingId('connection', r.id),
              check: v.worst.check,
              ...(v.worst.subject ? { subject: v.worst.subject } : {}),
              name: (v.worst.subject?.name ?? `“${v.worst.title}”`).slice(0, 220),
            },
          }
        : {}),
    });
  }
  for (const run of failedRuns)
    items.push({
      id: `automation_run:${run.runId}`,
      ref: { kind: 'automation_run', id: run.runId },
      source: 'automation',
      severity: 'warn',
      nature: 'problem',
      title: clip(`“${run.name}” didn’t finish`, 200),
      body: clip(run.error ? (run.error.split('\n')[0] ?? '') : 'Its run stopped before the end.', 600),
      at: (run.at ?? run.createdAt).toISOString(),
      state: 'open',
      href: `/automations/${run.automationId}`,
    });
  items.push(...others.items);
  const marked = items.map((i): WatchItem => {
    const mark = marks.get(refKey(i.ref));
    if (!mark) return i;
    // Ignored in Needs you: seen, for Watch.
    return mark.state === 'acknowledged' || mark.state === 'ignored'
      ? { ...i, state: 'acknowledged' }
      : { ...i, state: 'snoozed', ...(mark.until ? { snoozedUntil: mark.until.toISOString() } : {}) };
  });
  return marked
    .filter((i) => options.state === 'all' || i.state === 'open')
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.at.localeCompare(a.at))
    .slice(0, 200);
}

/** `home.overview`: every section of Home for the viewer (mock 1; home-redesign.md HR-20). */
export async function homeOverview(
  services: Services,
  viewer: HomeViewer,
): Promise<HomeOverview & { chats: HomeChat[] }> {
  const now = services.clock();
  // Every section's common reads once (the chats with the agent for Needs you, Working on and Chats among them).
  const reads = homeReads(services, viewer, now);
  const chats = reads.chats();
  const [needs, mine, working, turns, thingList, today, widgetList, done, watchAll, finished] =
    await Promise.all([
      needsYouOf(services, viewer, now, reads),
      chats,
      chats.then((c) => workingOn(services.db, c)),
      chats.then((c) => chatTurns(services.db, c)),
      thingsOf(services, viewer, now, reads),
      automationsToday(services.db, viewer.principal, viewer.burrow, now),
      listWidgets(services.db, viewer.principal, now),
      doneRecently(services.db, viewer.principal, now, DONE_RECENTLY_MAX),
      watchListOf(services, viewer, { state: 'all' }, now, reads),
      doneToday(services.db, viewer.principal, now, viewer.burrow.timeZone),
    ]);
  // An older app's Watch badge: the open items that aren't heads-ups, worst first.
  const watch = watchAll.filter((i) => i.state === 'open' && i.nature !== 'fyi');
  const list = needsYouList({
    open: needs.items,
    quiet: needs.quiet,
    watch: watchAll,
    names: thingNames(thingList),
    research: needs.research,
  });
  return {
    summary: {
      // The one count (NYL-04): what the list's first group holds.
      needsYou: needsYouCount(list),
      working: working.count,
      // Watch is sorted worst first: its first item's severity colours an older app's badge (sidebar.md SB-02).
      problems: watch.length,
      ...(watch[0] ? { worst: watch[0].severity } : {}),
    },
    // An older app's Needs you: only the kinds it knows (the newer ones are in the list alone, NYL-11).
    needsYou: needs.items.filter((i) => NEEDS_YOU_FIRST_KINDS.includes(i.kind)),
    needsYouList: list,
    chats: homeChats(mine.lines, {
      turns,
      planChat: working.planChat,
      progress: working.progress,
      waiting: needs.waiting,
    }),
    things: thingList,
    automationsToday: today,
    widgets: widgetList.slice(0, 24),
    doneRecently: done,
    doneToday: finished,
    arranged: arrangedOf(viewer.burrow),
    generatedAt: now.toISOString(),
  };
}
