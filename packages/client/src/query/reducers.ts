/**
 * Pure reducers over the response shapes the query cache holds. Each returns the input unchanged
 * (same reference) when the event does not concern it, and is idempotent: applying the same event
 * twice gives the same result. Ordering guards (stale versions, tombstones) live in `apply.ts`.
 */
import type { InfiniteData } from '@tanstack/query-core';
import {
  type AgentScheduleView,
  type Approval,
  type AuditEvent,
  type AuditKindFilter,
  type AuditPage,
  type CanvasComment,
  type CanvasDetail,
  type FindMyWatchView,
  type Grant,
  groupCommentThreads,
  INBOX_SECTIONS,
  type InboxFilter,
  type InboxItem,
  type InboxResponse,
  keysSummary,
  type Message,
  type MessageCard,
  type MessagePage,
  matchesKind,
  PINS_MAX,
  plainMessageText,
  type Reaction,
  type Run,
  type RunLogLine,
  type SearchResponse,
  type SearchResult,
  searchFilterOf,
  type ThreadView,
} from '@whombat/core';

/* Generic list helpers --------------------------------------------------------------------------- */

/** Replace the item with the same id (or insert it with `insert`); same array back when nothing changed. */
export function upsertBy<T>(
  list: readonly T[],
  item: T,
  same: (a: T) => boolean,
  insert?: (list: T[]) => T[],
) {
  const i = list.findIndex(same);
  if (i >= 0) {
    if (list[i] === item) return list as T[];
    const next = [...list];
    next[i] = item;
    return next;
  }
  return insert ? insert([...list]) : (list as T[]);
}

export function removeWhere<T>(list: readonly T[], pred: (a: T) => boolean): T[] {
  return list.some(pred) ? list.filter((x) => !pred(x)) : (list as T[]);
}

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NEGATIVE_INFINITY);

/** Oldest first by createdAt, then id (a total order, so inserts are deterministic). */
export function compareMessages(a: Message, b: Message): number {
  return time(a.createdAt) - time(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Pages hold newest first by a timestamp. */
function insertNewestFirst<T>(list: T[], item: T, at: (x: T) => string): T[] {
  const t = time(at(item));
  const i = list.findIndex((x) => time(at(x)) < t);
  if (i < 0) list.push(item);
  else list.splice(i, 0, item);
  return list;
}

/** Insert into an oldest-first list after every item that is not newer (stable for equal times). */
export function insertOldestFirst<T>(list: readonly T[], item: T, at: (x: T) => string): T[] {
  const t = time(at(item));
  const i = list.findIndex((x) => time(at(x)) > t);
  const next = [...list];
  if (i < 0) next.push(item);
  else next.splice(i, 0, item);
  return next;
}

/* Messages --------------------------------------------------------------------------------------- */

/** An optimistic copy and the server's message share `clientId`. */
function sameMessage(m: Message) {
  return (x: Message) => x.id === m.id || (m.clientId !== null && x.clientId === m.clientId);
}

/** Upsert into an oldest-first list; inserts keep the order. */
export function upsertMessage(list: readonly Message[], m: Message, insert = true): Message[] {
  const i = list.findIndex(sameMessage(m));
  if (i >= 0) {
    const next = removeWhere(list, sameMessage(m));
    return sortedInsert(next === list ? [...list] : next, m);
  }
  return insert ? sortedInsert([...list], m) : (list as Message[]);
}

function sortedInsert(list: Message[], m: Message): Message[] {
  const i = list.findIndex((x) => compareMessages(x, m) > 0);
  if (i < 0) list.push(m);
  else list.splice(i, 0, m);
  return list;
}

/** Is `m` inside the loaded window (not older than the oldest loaded message while more exist)? */
function inWindow(messages: readonly Message[], hasMore: boolean, m: Message): boolean {
  if (!hasMore) return true;
  const oldest = messages[0];
  return !oldest || compareMessages(m, oldest) >= 0;
}

/** `messages.list` page: top-level messages of one conversation, oldest first. */
export function reduceMessagePage(page: MessagePage, m: Message): MessagePage {
  if (m.threadRootId !== null) return page;
  const present = page.messages.some(sameMessage(m));
  if (!present && !inWindow(page.messages, page.hasMore, m)) return page;
  const messages = upsertMessage(page.messages, m);
  return messages === page.messages ? page : { ...page, messages };
}

/** Infinite `messages.list`: pages[0] is the newest page, each page oldest first. */
export function reduceMessagePages(data: InfiniteData<MessagePage>, m: Message): InfiniteData<MessagePage> {
  if (m.threadRootId !== null) return data;
  const hit = data.pages.findIndex((p) => p.messages.some(sameMessage(m)));
  if (hit >= 0) return replacePage(data, hit, reduceMessagePage(data.pages[hit] as MessagePage, m));
  // Newest page that starts at or before the message; beyond the last loaded page only if it is the end.
  for (let i = 0; i < data.pages.length; i++) {
    const page = data.pages[i] as MessagePage;
    const oldest = page.messages[0];
    const last = i === data.pages.length - 1;
    if ((oldest && compareMessages(m, oldest) >= 0) || (last && !page.hasMore)) {
      return replacePage(data, i, { ...page, messages: upsertMessage(page.messages, m) });
    }
  }
  return data;
}

function replacePage<P>(data: InfiniteData<P>, i: number, page: P): InfiniteData<P> {
  if (data.pages[i] === page) return data;
  const pages = [...data.pages];
  pages[i] = page;
  return { ...data, pages };
}

export function mapPages<P>(data: InfiniteData<P>, fn: (page: P, index: number) => P): InfiniteData<P> {
  let changed = false;
  const pages = data.pages.map((p, i) => {
    const next = fn(p, i);
    if (next !== p) changed = true;
    return next;
  });
  return changed ? { ...data, pages } : data;
}

export function removeMessageFromPage(page: MessagePage, messageId: string): MessagePage {
  const messages = removeWhere(page.messages, (x) => x.id === messageId);
  return messages === page.messages ? page : { ...page, messages };
}

/** Thread pane: the root and its replies. */
export function reduceThread(view: ThreadView, m: Message): ThreadView {
  if (m.id === view.root.id) return m === view.root ? view : { ...view, root: m };
  if (m.threadRootId !== view.root.id) return view;
  const replies = upsertMessage(view.replies, m);
  return replies === view.replies ? view : { ...view, replies };
}

export function removeFromThread(view: ThreadView, messageId: string): ThreadView {
  const replies = removeWhere(view.replies, (x) => x.id === messageId);
  return replies === view.replies ? view : { ...view, replies };
}

/**
 * `conversations.pins` (contracts CT-174): a conversation's pinned messages, newest pin first, at most `PINS_MAX`. A
 * message of that conversation joins when it carries `pinnedAt`, leaves when it doesn't (unpinned, or a tombstone),
 * and is replaced in place otherwise (an edit, a reaction, a preview).
 */
export function reducePins(
  data: { messages: Message[] },
  m: Message,
  conversationId: unknown,
): { messages: Message[] } {
  if (m.conversationId !== conversationId) return data;
  const pinned = !!m.pinnedAt && !m.deletedAt;
  const present = data.messages.some((x) => x.id === m.id);
  if (!pinned) {
    if (!present) return data;
    return { ...data, messages: data.messages.filter((x) => x.id !== m.id) };
  }
  const rest = data.messages.filter((x) => x.id !== m.id);
  const messages = insertNewestFirst(rest, m, (x) => x.pinnedAt ?? '').slice(0, PINS_MAX);
  const same =
    present && messages.length === data.messages.length && messages.every((x, i) => x === data.messages[i]);
  return same ? data : { ...data, messages };
}

/** A message that is gone leaves its conversation's pins. */
export function removeFromPins(data: { messages: Message[] }, messageId: string): { messages: Message[] } {
  const messages = removeWhere(data.messages, (x) => x.id === messageId);
  return messages === data.messages ? data : { ...data, messages };
}

/** Search results show a message's plain text (the runtime's snippet is its first 1000 characters). */
export const SEARCH_SNIPPET_MAX = 1000;

/**
 * A message's search result (`MESSAGE` or `THREAD` with the message's id) after it changed: an edit shows its new
 * words at once; a tombstone leaves the results (and the chip counts), like a deleted message
 * (`removeSearchResult`).
 */
export function reduceSearchResults(data: SearchResponse, m: Message): SearchResponse {
  const hit = data.results.find((r) => r.id === m.id && (r.type === 'MESSAGE' || r.type === 'THREAD'));
  if (!hit) return data;
  if (m.deletedAt) return removeSearchResult(data, m.id);
  const snippet = plainMessageText(m.text).replace(/\s+/g, ' ').trim().slice(0, SEARCH_SNIPPET_MAX);
  if (!snippet || snippet === hit.snippet) return data;
  return { ...data, results: data.results.map((r) => (r === hit ? { ...r, snippet } : r)) };
}

/** A message's result on a search page (`MESSAGE` or `THREAD` with the message's id). */
export function searchResultOf(data: SearchResponse, messageId: string): SearchResult | undefined {
  return data.results.find((r) => r.id === messageId && (r.type === 'MESSAGE' || r.type === 'THREAD'));
}

/**
 * A page of a search that showed `hit` somewhere (this page or another of the same search): the result leaves this
 * page if it is here, and the chip counts — the whole search's, the same on every page — go down by one.
 */
export function withoutSearchResult(data: SearchResponse, hit: SearchResult): SearchResponse {
  const filter = searchFilterOf(hit.type);
  const counts = {
    ...data.counts,
    all: Math.max(0, data.counts.all - 1),
    [filter]: Math.max(0, data.counts[filter] - 1),
  };
  return { ...data, results: data.results.filter((r) => r.id !== hit.id), counts };
}

/** A deleted message's result leaves the list, and its chip counts go down by one. */
export function removeSearchResult(data: SearchResponse, messageId: string): SearchResponse {
  const hit = searchResultOf(data, messageId);
  return hit ? withoutSearchResult(data, hit) : data;
}

/** Swap the live object embedded in a message card (run, approval or plan cards). */
export function patchCard(m: Message, patch: (card: MessageCard) => MessageCard): Message {
  if (!m.card) return m;
  const card = patch(m.card);
  return card === m.card ? m : { ...m, card };
}

export const cardPatchers = {
  run:
    (run: Run) =>
    (c: MessageCard): MessageCard =>
      c.kind === 'run' && c.run.id === run.id ? { ...c, run } : c,
  approval:
    (approval: Approval) =>
    (c: MessageCard): MessageCard =>
      c.kind === 'approval' && c.approval.id === approval.id ? { ...c, approval } : c,
  plan:
    (plan: Extract<MessageCard, { kind: 'plan' }>['plan']) =>
    (c: MessageCard): MessageCard =>
      c.kind === 'plan' && c.plan.id === plan.id ? { ...c, plan } : c,
  /**
   * A schedule as it is now on its room card (Whombat resourceful-agents.md RA-30): paused, resumed, cancelled. A card
   * the viewer can't see (`schedule: null`) stays as it is; `prompt` keeps what the card had when the answer has none.
   */
  schedule:
    (schedule: AgentScheduleView) =>
    (c: MessageCard): MessageCard =>
      c.kind === 'schedule' && c.scheduleId === schedule.id && c.schedule
        ? { ...c, schedule: { ...schedule, prompt: schedule.prompt ?? c.schedule.prompt } }
        : c,
  /** A Find My watch as it is now on its card (findmy-watch.md): cancelled from its card, before `message.updated`. */
  findMyWatch:
    (watch: FindMyWatchView) =>
    (c: MessageCard): MessageCard =>
      c.kind === 'findmy_watch' && c.watchId === watch.id ? { ...c, watch } : c,
};

/** Map every message inside a messages container (page, infinite pages, thread, single message). */
export function mapMessagesIn<T>(data: T, fn: (m: Message) => Message): T {
  const d = data as unknown as Record<string, unknown>;
  if (Array.isArray(d.pages)) {
    return mapPages(data as unknown as InfiniteData<MessagePage>, (p) => mapMessagesIn(p, fn)) as T;
  }
  if (Array.isArray(d.messages)) {
    const page = data as unknown as MessagePage;
    const messages = mapList(page.messages, fn);
    return (messages === page.messages ? data : { ...page, messages }) as T;
  }
  if (d.root && Array.isArray(d.replies)) {
    const view = data as unknown as ThreadView;
    const root = fn(view.root);
    const replies = mapList(view.replies, fn);
    return (root === view.root && replies === view.replies ? data : { ...view, root, replies }) as T;
  }
  if (d.message && typeof d.message === 'object') {
    const one = data as unknown as { message: Message };
    const message = fn(one.message);
    return (message === one.message ? data : { ...one, message }) as T;
  }
  return data;
}

export function mapList<T>(list: readonly T[], fn: (x: T) => T): T[] {
  let changed = false;
  const next = list.map((x) => {
    const y = fn(x);
    if (y !== x) changed = true;
    return y;
  });
  return changed ? next : (list as T[]);
}

/** The viewer's reaction toggled (optimistic). */
export function toggleReaction(
  reactions: readonly Reaction[],
  value: string,
  on: boolean,
  me: string,
): Reaction[] {
  const existing = reactions.find((r) => r.value === value);
  if (on) {
    if (existing?.mine) return reactions as Reaction[];
    if (existing) {
      return reactions.map((r) =>
        r === existing ? { ...r, count: r.count + 1, mine: true, principalIds: [...r.principalIds, me] } : r,
      );
    }
    return [...reactions, { value, count: 1, mine: true, principalIds: [me] }];
  }
  if (!existing?.mine) return reactions as Reaction[];
  if (existing.count <= 1) return reactions.filter((r) => r !== existing);
  return reactions.map((r) =>
    r === existing
      ? { ...r, count: r.count - 1, mine: false, principalIds: r.principalIds.filter((p) => p !== me) }
      : r,
  );
}

/* Runs ------------------------------------------------------------------------------------------- */

/** Log lines merged by seq (idempotent), oldest first, capped to the newest `cap`. */
export function mergeLogLines(
  lines: readonly RunLogLine[],
  incoming: readonly RunLogLine[],
  cap = 500,
): RunLogLine[] {
  const known = new Set(lines.map((l) => l.seq));
  const fresh = incoming.filter((l) => !known.has(l.seq));
  if (!fresh.length) return lines as RunLogLine[];
  const merged = [...lines, ...fresh].sort((a, b) => a.seq - b.seq);
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/** `runs.list` (newest first by start), honouring the query's status / agent filters. */
export function reduceRunList(
  runs: readonly Run[],
  run: Run,
  filter: { status?: unknown; agentId?: string | null },
): Run[] {
  const matches =
    (filter.status === undefined || filter.status === run.status) &&
    (!filter.agentId || filter.agentId === run.agentId);
  if (!matches) return removeWhere(runs, (r) => r.id === run.id);
  return upsertBy(
    runs,
    run,
    (r) => r.id === run.id,
    (list) => insertNewestFirst(list, run, (r) => r.startedAt),
  );
}

export type CurrentRunRef = { number: number; status: Run['status']; title: string } | null;

/** Current run shown on the roster / profile: live or paused runs only. */
export function currentRunAfter(current: CurrentRunRef, run: Run): CurrentRunRef {
  if (run.status === 'live' || run.status === 'paused') {
    if (current?.number === run.number && current.status === run.status && current.title === run.title) {
      return current;
    }
    return { number: run.number, status: run.status, title: run.title };
  }
  return current?.number === run.number ? null : current;
}

/** Keys summary after a grants change, keeping the channel count. */
export function summaryAfterGrants(grants: readonly Grant[]) {
  return keysSummary(grants);
}

/* Approvals -------------------------------------------------------------------------------------- */

export function reduceApprovalList(
  list: readonly Approval[],
  approval: Approval,
  state: unknown,
): Approval[] {
  if (state !== undefined && state !== approval.state) return removeWhere(list, (a) => a.id === approval.id);
  return upsertBy(
    list,
    approval,
    (a) => a.id === approval.id,
    (l) => insertNewestFirst(l, approval, (a) => a.createdAt),
  );
}

/** The approval's live state as the audit log joins it onto Asks events. */
export function auditApprovalState(a: Approval): NonNullable<AuditEvent['approval']> {
  return {
    number: a.number,
    state: a.state,
    decidedById: a.decidedById,
    decidedAt: a.decidedAt,
    executedAt: a.executedAt,
  };
}

export function patchAuditApproval(event: AuditEvent, a: Approval): AuditEvent {
  if (event.approvalId !== a.id || (event.approval === null && event.type !== 'approval.requested'))
    return event;
  const next = auditApprovalState(a);
  const cur = event.approval;
  if (
    cur &&
    cur.state === next.state &&
    cur.decidedById === next.decidedById &&
    cur.decidedAt === next.decidedAt &&
    cur.executedAt === next.executedAt &&
    cur.number === next.number
  ) {
    return event;
  }
  return { ...event, approval: next };
}

/* Audit ------------------------------------------------------------------------------------------ */

export interface AuditListFilter {
  actor: 'everyone' | 'people' | 'agents';
  kind: AuditKindFilter;
  whoId: string | null;
}

/** Is the event in the actor/who base the chip counts are computed over? */
export function inAuditBase(
  event: AuditEvent,
  filter: AuditListFilter,
  isAgent: (id: string) => boolean,
): boolean {
  return (
    event.text !== null &&
    (filter.actor === 'everyone' || (filter.actor === 'agents') === isAgent(event.actorId)) &&
    (!filter.whoId || event.actorId === filter.whoId || event.aboutId === filter.whoId)
  );
}

const KIND_COUNT: Record<AuditEvent['kind'], keyof AuditPage['counts'] | null> = {
  Code: 'code',
  Asks: 'asks',
  Keys: 'keys',
  Vault: 'vault',
  Messages: 'messages',
  Blocked: 'blocked',
  System: null,
};

/** New event on the newest audit page: counts +1 when in the base, row inserted when the kind matches. */
export function reduceAuditPage(
  page: AuditPage,
  event: AuditEvent,
  filter: AuditListFilter,
  isAgent: (id: string) => boolean,
): AuditPage {
  if (page.events.some((e) => e.id === event.id) || !inAuditBase(event, filter, isAgent)) return page;
  const counts = { ...page.counts, all: page.counts.all + 1 };
  const k = KIND_COUNT[event.kind];
  if (k) counts[k] += 1;
  const events = matchesKind(event, filter.kind)
    ? insertNewestFirst([...page.events], event, (e) => e.createdAt)
    : page.events;
  return { ...page, counts, events };
}

/* Inbox ------------------------------------------------------------------------------------------ */

const INBOX_COUNT: Record<InboxItem['kind'], Exclude<keyof InboxResponse['counts'], 'all'>> = {
  needs_you: 'needs_you',
  mention: 'mentions',
  agent_update: 'agents',
  // Thread replies sit under the Mentions chip (contracts CT-179 INBOX_SECTIONS).
  reply: 'mentions',
};

/** New inbox row: counts always move; the row shows when the filter chip includes it. */
export function reduceInbox(
  inbox: InboxResponse,
  item: InboxItem,
  filter: InboxFilter,
  countsAlreadyApplied: boolean,
): InboxResponse {
  if (inbox.sections.some((s) => s.items.some((i) => i.id === item.id))) return inbox;
  const section = INBOX_SECTIONS.find((s) => s.kind === item.kind);
  let sections = inbox.sections;
  if (section && (filter === 'all' || filter === section.filter)) {
    const existing = sections.find((s) => s.kind === item.kind);
    if (existing) {
      sections = sections.map((s) =>
        s === existing ? { ...s, items: insertNewestFirst([...s.items], item, (x) => x.createdAt) } : s,
      );
    } else {
      const order = (kind: string) => INBOX_SECTIONS.findIndex((s) => s.kind === kind);
      sections = [...sections, { kind: section.kind, title: section.title, items: [item] }].sort(
        (a, b) => order(a.kind) - order(b.kind),
      );
    }
  }
  if (countsAlreadyApplied) return sections === inbox.sections ? inbox : { ...inbox, sections };
  const key = INBOX_COUNT[item.kind];
  return {
    ...inbox,
    sections,
    counts: { ...inbox.counts, all: inbox.counts.all + 1, [key]: inbox.counts[key] + 1 },
    unread: item.readAt === null ? inbox.unread + 1 : inbox.unread,
  };
}

/**
 * Rows opened (or all of them): `readAt` is set and the unread count drops. `unread` is the server's count
 * when known (after `notifications.markRead`); otherwise it drops by the rows that changed.
 */
export function markInboxRead(
  inbox: InboxResponse,
  ids: readonly string[] | 'all',
  at: string,
  unread?: number,
): InboxResponse {
  const wanted = ids === 'all' ? null : new Set(ids);
  let marked = 0;
  const sections = inbox.sections.map((s) => {
    const items = mapList(s.items, (i) => {
      if (i.readAt !== null || (wanted && !wanted.has(i.id))) return i;
      marked += 1;
      return { ...i, readAt: at };
    });
    return items === s.items ? s : { ...s, items };
  });
  const nextUnread = unread ?? Math.max(0, inbox.unread - marked);
  if (marked === 0 && nextUnread === inbox.unread) return inbox;
  return { ...inbox, sections: marked ? sections : inbox.sections, unread: nextUnread };
}

/** What a `notification.read` event says (contracts CT-300). */
export interface NotificationRead {
  /** The rows read; null: every row up to `before` (all of them without it). */
  ids: readonly string[] | null;
  before?: string;
  /** The viewer's unread count after it. */
  unread?: number;
}

/**
 * Rows read on this device or another (`notification.read`, CT-300; web-efficiency.md WE-11, shared with mobile MN-03).
 * A row's `readAt` becomes the earliest time an event read it; the unread count drops by the rows that turned read, or
 * becomes the server's count when the event carries one and is the `latest` read event seen (an older one arriving late
 * doesn't put a stale count back). Duplicates and any order end in the same inbox.
 */
export function reduceNotificationRead(
  inbox: InboxResponse,
  read: NotificationRead,
  at: string,
  latest = true,
): InboxResponse {
  const wanted = read.ids ? new Set(read.ids) : null;
  const cutoff = read.ids === null && read.before !== undefined ? Date.parse(read.before) : null;
  const atMs = Date.parse(at);
  let turned = 0;
  const sections = inbox.sections.map((s) => {
    const items = mapList(s.items, (i) => {
      const hit = wanted ? wanted.has(i.id) : cutoff === null || Date.parse(i.createdAt) <= cutoff;
      if (!hit) return i;
      if (i.readAt === null) {
        turned += 1;
        return { ...i, readAt: at };
      }
      return Date.parse(i.readAt) > atMs ? { ...i, readAt: at } : i;
    });
    return items === s.items ? s : { ...s, items };
  });
  const unread = latest && read.unread !== undefined ? read.unread : Math.max(0, inbox.unread - turned);
  const changed = sections.some((s, i) => s !== inbox.sections[i]);
  if (!changed && unread === inbox.unread) return inbox;
  return { ...inbox, sections: changed ? sections : inbox.sections, unread };
}

export function patchInboxApproval(inbox: InboxResponse, approval: Approval): InboxResponse {
  let changed = false;
  const sections = inbox.sections.map((s) => {
    const items = mapList(s.items, (i) =>
      i.approvalId === approval.id && i.approval !== approval ? { ...i, approval } : i,
    );
    if (items === s.items) return s;
    changed = true;
    return { ...s, items };
  });
  return changed ? { ...inbox, sections } : inbox;
}

/* Canvas ----------------------------------------------------------------------------------------- */

export function reduceCanvasComments(detail: CanvasDetail, comment: CanvasComment): CanvasDetail {
  if (detail.canvas.id !== comment.canvasId) return detail;
  const flat = detail.comments.flatMap((t) => t.comments);
  const next = upsertBy(
    flat,
    comment,
    (c) => c.id === comment.id,
    (l) => [...l, comment],
  );
  if (next === flat) return detail;
  return { ...detail, comments: groupCommentThreads(next) };
}
