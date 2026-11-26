/** Conversation-shaped read models: bootstrap (sidebar), conversation detail, message pages, threads. */
import {
  type Bootstrap,
  type BranchRoomSummary,
  type BurrowAiGateway,
  type ConversationDetail,
  conversationLabel,
  DEFAULT_PREFERENCES,
  type MessagePage,
  PR_STATUS_TONES,
  type ThreadView,
  topics,
} from '@whombat/core';
import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { AccountRow } from '../auth/service';
import type { BurrowRow } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { canvases, conversations, messages, pullRequests } from '../db/schema/index';
import { aiGatewayView } from '../gateway/store';
import { notFound } from '../lib/errors';
import { iso } from '../lib/time';
import { localModelView } from '../local-model/store';
import { placeOfBurrow } from '../place/store';
import { webSearchView } from '../web-search/store';
import {
  type ConversationRow,
  conversationSummaries,
  lastReadMessageId,
  loadConversationRow,
  toConversation,
} from './conversations';
import { afterClear, loadMessageRow, loadMessages } from './messages';
import { loadPrincipalRows, type PrincipalRow, toPerson, toPrincipal } from './principals';
import { branchRoomPullRequests, loadPullRequests } from './work';

/**
 * The burrow as clients see it. `aiGateway` (docs/decisions/ai-gateway.md AIG-05): its gateway connection and switches,
 * null without one (`burrowView` reads it). `localModel`: the model on the person's network without its key;
 * `webSearch`: web search without its key.
 */
export function toBurrow(row: BurrowRow, aiGateway: BurrowAiGateway | null = null) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    timeZone: row.timeZone,
    createdAt: iso(row.createdAt),
    // Link previews under messages; absent in the database = on (CT-174, EC-21).
    linkPreviews: row.linkPreviews !== false,
    // “Agents may reach your local network”; absent in the database = on (resourceful-agents.md RA-41).
    agentsReachLan: row.agentsReachLan !== false,
    aiGateway,
    // The model on the person's network (CT-1170, hermes-engine.md HE-32): never its key, only whether there is one.
    localModel: localModelView(row),
    // Web search with a Brave Search key (web-search.md): never the key.
    webSearch: webSearchView(row),
    // Where the Whombat is (weather-news.md): the person's place, else the time zone's guess.
    place: placeOfBurrow(row),
  };
}

/** `toBurrow` with the burrow's AI gateway read (AIG-05). */
export async function burrowView(db: Db | Tx, row: BurrowRow) {
  return toBurrow(row, await aiGatewayView(db, row));
}

/**
 * The viewer's conversations, by kind, in sidebar order: their own Chat with the agent and every branch room of the
 * burrow. A Chat of someone who was on the box before it was one person's is history, not listed.
 */
async function listedConversations(
  db: Db,
  burrowId: string,
  viewerId: string,
  kind?: ConversationRow['kind'],
) {
  // Task chats are listed by `chats.list` only (one-whombat-assistant.md ONE-DW16): never as more DMs in the sidebar.
  const where = [
    eq(conversations.burrowId, burrowId),
    isNull(conversations.taskKey),
    or(eq(conversations.kind, 'branch'), eq(conversations.dmPersonId, viewerId)),
  ];
  if (kind) where.push(eq(conversations.kind, kind));
  return db
    .select()
    .from(conversations)
    .where(and(...where))
    .orderBy(asc(conversations.position), asc(conversations.createdAt));
}

export async function listConversations(
  db: Db,
  burrowId: string,
  viewerId: string,
  kind?: ConversationRow['kind'],
) {
  return conversationSummaries(db, viewerId, await listedConversations(db, burrowId, viewerId, kind));
}

export async function bootstrap(
  db: Db,
  burrow: BurrowRow,
  viewer: PrincipalRow,
  account: AccountRow | null,
  now: Date,
): Promise<Bootstrap> {
  const [allPrincipals, rows] = await Promise.all([
    loadPrincipalRows(db, burrow.id),
    listedConversations(db, burrow.id, viewer.id),
  ]);
  const summaries = await conversationSummaries(db, viewer.id, rows);
  const byId = new Map(summaries.map((s) => [s.id, s]));
  // The viewer's own rooms with the agent: their Chat and Feedback room (one-agent.md OA-04).
  const dms = rows
    .filter((r) => r.kind === 'dm' && r.dmPersonId === viewer.id)
    .map((r) => byId.get(r.id))
    .filter((s) => !!s);

  // What the dots need, not each pull request's files, commits and diff (server-efficiency.md SV-06).
  const prs = await branchRoomPullRequests(
    db,
    rows.filter((r) => r.kind === 'branch').map((r) => r.id),
  );
  const branchRooms: BranchRoomSummary[] = [];
  for (const r of rows.filter((row) => row.kind === 'branch')) {
    const s = byId.get(r.id);
    const pr = prs.find((p) => p.conversationId === r.id);
    if (!s) continue;
    const status = pr ? pr.status : 'in_review';
    branchRooms.push({
      ...s,
      branch: pr?.branch ?? r.title,
      prNumber: pr?.number ?? r.prNumber ?? 1,
      prStatus: status,
      dot: PR_STATUS_TONES[status],
      // Two repositories may both have a PR #1 (CT-170, EC-24).
      ...(s.link.type === 'pr' && s.link.repo ? { repo: s.link.repo } : {}),
    });
  }
  const open = (b: BranchRoomSummary) => (b.prStatus === 'merged' || b.prStatus === 'closed' ? 1 : 0);
  branchRooms.sort((a, b) => open(a) - open(b));

  const [{ n: canvasCount } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(canvases)
    .where(eq(canvases.burrowId, burrow.id));

  return {
    burrow: await burrowView(db, burrow),
    me: toPerson(viewer),
    principals: allPrincipals.map(toPrincipal),
    sidebar: {
      branchRooms,
      dms,
      counts: {
        canvases: canvasCount,
        // No screen shows it: what needs the person is counted by `work.needsYou` where it is read. The contract
        // still has the field, so it stays, without a count on every load.
        needsYou: 0,
      },
    },
    preferences: account?.preferences ?? DEFAULT_PREFERENCES,
    serverTime: iso(now),
    // The session's event log carries the topics; there is no WebSocket path (contracts 1.0.0 still has the field).
    realtime: {
      path: '',
      topics: [topics.burrow(burrow.id), topics.me(viewer.id)],
    },
  };
}

/** The conversation, if it is one of the viewer's burrow: every one is the person's. */
export async function readableConversation(db: Db, burrowId: string, id: string) {
  const row = await loadConversationRow(db, id);
  if (!row || row.burrowId !== burrowId) throw notFound('Conversation');
  return row;
}

export async function conversationDetail(
  db: Db,
  viewerId: string,
  row: ConversationRow,
): Promise<ConversationDetail> {
  const [summary] = await conversationSummaries(db, viewerId, [row]);
  let pr: ConversationDetail['pr'] = null;
  if (row.kind === 'branch') {
    const [prRow] = await db.select().from(pullRequests).where(eq(pullRequests.conversationId, row.id));
    if (prRow) [pr = null] = await loadPullRequests(db, [prRow]);
  }
  return {
    conversation: toConversation(row),
    summary: summary as ConversationDetail['summary'],
    pr,
    lastReadMessageId: await lastReadMessageId(db, row.id, viewerId),
    // The viewer's level in effect here (essentials-people.md EP-10).
    ...(summary?.notify ? { notify: summary.notify } : {}),
  };
}

/* Message pages ---------------------------------------------------------------------------------- */

interface CursorPos {
  createdAt: string;
  ord: number;
}

export function encodeCursor(pos: CursorPos): string {
  return Buffer.from(`${pos.createdAt}|${pos.ord}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPos | null {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const m = /^(.+)\|(\d+)$/.exec(text);
  if (!m || Number.isNaN(Date.parse(m[1] as string))) return null;
  return { createdAt: m[1] as string, ord: Number(m[2]) };
}

/**
 * Top-level messages, newest page first; each page oldest first. `before` pages backwards. A cleared room's start after
 * its clear (`clearedAt`, chat-clear.md CHC-03).
 */
export async function messagePage(
  db: Db,
  viewerId: string,
  conversationId: string,
  options: { before?: string; limit: number; clearedAt?: Date | null },
): Promise<MessagePage> {
  const where = [eq(messages.conversationId, conversationId), sql`${messages.threadRootId} is null`];
  const cleared = afterClear(options.clearedAt);
  if (cleared) where.push(cleared);
  const pos = options.before ? decodeCursor(options.before) : null;
  if (options.before && !pos) throw notFound('Cursor');
  if (pos) {
    const at = new Date(pos.createdAt);
    const older = or(lt(messages.createdAt, at), and(eq(messages.createdAt, at), lt(messages.ord, pos.ord)));
    if (older) where.push(older);
  }
  const rows = await db
    .select()
    .from(messages)
    .where(and(...where))
    .orderBy(desc(messages.createdAt), desc(messages.ord))
    .limit(options.limit + 1);
  const hasMore = rows.length > options.limit;
  const page = rows.slice(0, options.limit).reverse();
  const oldest = page[0];
  return {
    messages: await loadMessages(db, page, viewerId),
    before: hasMore && oldest ? encodeCursor({ createdAt: iso(oldest.createdAt), ord: oldest.ord }) : null,
    hasMore,
  };
}

/** The message, if it is one of the viewer's burrow. */
export async function readableMessage(db: Db, burrowId: string, messageId: string) {
  const row = await loadMessageRow(db, messageId);
  if (!row || row.burrowId !== burrowId) throw notFound('Message');
  return row;
}

/**
 * A thread: its root and its replies, oldest first. With `page.limit` the newest `limit` replies before `page.before`
 * and `more` while earlier ones exist, read through the reply index; without it every reply and `more` null.
 */
export async function threadView(
  db: Db,
  viewerId: string,
  rootId: string,
  page: { before?: string | undefined; limit?: number | undefined } = {},
): Promise<ThreadView> {
  const root = await loadMessageRow(db, rootId);
  if (!root) throw notFound('Thread');
  const actualRoot = root.threadRootId ? await loadMessageRow(db, root.threadRootId) : root;
  if (!actualRoot) throw notFound('Thread');
  const inOrder = [asc(messages.createdAt), asc(messages.ord)];
  let replies: (typeof messages.$inferSelect)[];
  let more: ThreadView['more'] = null;
  if (page.limit === undefined) {
    replies = await db
      .select()
      .from(messages)
      .where(eq(messages.threadRootId, actualRoot.id))
      .orderBy(...inOrder);
  } else {
    // Keep the database's full timestamp precision: a JavaScript Date loses microseconds from older imports.
    const [before] = page.before
      ? await db
          .select({ at: sql<string>`${messages.createdAt}::text`, ord: messages.ord })
          .from(messages)
          .where(and(eq(messages.id, page.before), eq(messages.threadRootId, actualRoot.id)))
      : [];
    // A missing or foreign cursor starts at the newest page, just as the contracts' reference does.
    const found = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.threadRootId, actualRoot.id),
          before
            ? sql`(${messages.createdAt}, ${messages.ord}) < (${before.at}::timestamptz, ${before.ord})`
            : undefined,
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.ord))
      .limit(page.limit + 1);
    replies = found.slice(0, page.limit).reverse();
    more = found.length > page.limit && replies[0] ? { before: replies[0].id } : null;
  }
  const [loadedRoot, ...loadedReplies] = await loadMessages(db, [actualRoot, ...replies], viewerId);
  const conversation = await loadConversationRow(db, actualRoot.conversationId);
  const card = actualRoot.card;
  const topic =
    card?.kind === 'research'
      ? card.topic
      : card?.kind === 'digest'
        ? card.title
        : card?.kind === 'plan' || card?.kind === 'run' || card?.kind === 'approval'
          ? loadedRoot?.card?.kind === 'plan'
            ? loadedRoot.card.plan.title
            : loadedRoot?.card && 'run' in loadedRoot.card
              ? loadedRoot.card.run.title
              : loadedRoot?.card && 'approval' in loadedRoot.card
                ? loadedRoot.card.approval.title
                : null
          : null;
  return {
    root: loadedRoot as ThreadView['root'],
    replies: loadedReplies,
    conversationId: actualRoot.conversationId,
    where: conversation ? conversationLabel(conversation) : '',
    topic,
    more,
  };
}
