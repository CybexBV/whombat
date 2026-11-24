/**
 * `applyRealtimeEvent()` — applies one `RealtimeEvent` to every cached response it affects, so screens
 * update without refetching. Safe under duplicates and out-of-order delivery:
 *
 * - Entity events (message, run, approval, plan, agent, grants, conversation, unread, PR, canvas,
 *   comment, answer, burrow, typing) carry the whole new state. A per-entity version (the
 *   frame's `at`) is remembered; an older frame than the last applied one is ignored.
 * - Append events (audit entries, inbox rows, new principals, log lines) are keyed by id / seq and
 *   applied once.
 * - Deleted messages leave a tombstone so a late `message.created` / `message.updated` cannot revive them.
 */
import type { InfiniteData, QueryClient } from '@tanstack/query-core';
import {
  type Activity,
  type AgentProfile,
  type Approval,
  type ApprovalResponse,
  type AuditEvent,
  type AuditPage,
  type Automation,
  type AutomationDetail,
  type AutomationRun,
  type AutomationRunDetail,
  type Bootstrap,
  type CanvasDetail,
  type CanvasSummary,
  type ChatRoom,
  type ChatRuntime,
  type ChatRuntimeView,
  type ChatSummary,
  type ChatThread,
  type ChatThreadsResponse,
  type ChatUnreadResponse,
  type Conversation,
  type ConversationDetail,
  type ConversationHandoffs,
  type ConversationSummary,
  chatRuntimeEquals,
  chatSummaryRoom,
  conversationLabel,
  conversationLink,
  type HomeOverview,
  type InboxFilter,
  type InboxResponse,
  type MeResponse,
  type Message,
  type MessagePage,
  mergeBlock,
  type NotifyLevel,
  PR_STATUS_TONES,
  type PullRequest,
  type PullRequestDetail,
  prStatus,
  type RealtimeEvent,
  type RealtimeEventOf,
  type Run,
  type RunDetail,
  type RunLogLine,
  type SearchResponse,
  type SearchResult,
  type ThreadSettle,
  type ThreadView,
  TYPING_TTL_MS,
} from '@whombat/core';
import { sameThreadSettle, threadAbout, threadPagesSettled, withSettledCount } from '../chat/settle';
import { threadOfMessage, threadPagesWithMessage, threadPagesWithout } from '../chat/threads';
import { sidebarSummaries, withNotify } from '../conversations';
import { withChat } from '../home/chats';
import { HOSTS_APPLIERS } from '../hosts/apply';
import {
  cachedData,
  cachedPrincipals,
  endpointQueries,
  patchEndpoint,
  putQueryData,
  sameBurrow,
} from './cache';
import { type CalmRefetches, createCalmRefetches, invalidateCalmly } from './calm';
import { markInboxReadAt } from './inboxRead';
import { type AgentNowEntry, parseKey, QUERY_ROOT, queryKeys, type TypingEntry } from './keys';
import {
  type AuditListFilter,
  cardPatchers,
  currentRunAfter,
  insertOldestFirst,
  mapList,
  mapMessagesIn,
  mapPages,
  mergeLogLines,
  patchAuditApproval,
  patchCard,
  patchInboxApproval,
  reduceApprovalList,
  reduceAuditPage,
  reduceCanvasComments,
  reduceInbox,
  reduceMessagePage,
  reduceMessagePages,
  reduceNotificationRead,
  reducePins,
  reduceRunList,
  reduceSearchResults,
  reduceThread,
  removeFromPins,
  removeFromThread,
  removeMessageFromPage,
  removeWhere,
  searchResultOf,
  summaryAfterGrants,
  upsertBy,
  withoutSearchResult,
} from './reducers';
import { applyActivity, applyPlan, invalidateWork } from './supervision';

export interface EventMeta {
  /** Server time of the change (`at` of the frame). Versions entities; defaults to now. */
  at?: string;
  topic?: string;
  seq?: number;
  /** Burrow of the socket the event came from (from `hello`). Scopes inserts into lists. */
  burrowId?: string | null;
}

/** Ordering state shared by every event applied to one QueryClient. */
export interface CacheSyncState {
  versions: Map<string, number>;
  tombstones: Set<string>;
  applied: Set<string>;
  now: () => number;
  /** Reads refetched at most once a window, however many frames ask (`calm.ts`); on the wall clock. */
  calm: CalmRefetches;
}

export function createCacheSyncState(
  now: () => number = Date.now,
  calm: CalmRefetches = createCalmRefetches(),
): CacheSyncState {
  return { versions: new Map(), tombstones: new Set(), applied: new Set(), now, calm };
}

const states = new WeakMap<QueryClient, CacheSyncState>();

/** The sync state used for a QueryClient when none is passed explicitly. */
export function cacheSyncState(qc: QueryClient): CacheSyncState {
  let s = states.get(qc);
  if (!s) {
    s = createCacheSyncState();
    states.set(qc, s);
  }
  return s;
}

interface Ctx {
  qc: QueryClient;
  at: number;
  atIso: string;
  burrowId: string | null;
  state: CacheSyncState;
}

/** Record `at` for an entity; false when a newer version was already applied. */
function fresh(ctx: Ctx, entity: string): boolean {
  const prev = ctx.state.versions.get(entity);
  if (prev !== undefined && ctx.at < prev) return false;
  ctx.state.versions.set(entity, ctx.at);
  return true;
}

/** The automation list without `id` (the same object when it isn't there). */
function dropAutomation(d: { automations: Automation[] }, id: string): { automations: Automation[] } {
  return d.automations.some((a) => a.id === id)
    ? { automations: d.automations.filter((a) => a.id !== id) }
    : d;
}

/** True the first time an append event is seen. */
function once(ctx: Ctx, id: string): boolean {
  if (ctx.state.applied.has(id)) return false;
  ctx.state.applied.add(id);
  return true;
}

/**
 * Apply an event to the cache. Returns false when the event was ignored as stale or a duplicate.
 */
export function applyRealtimeEvent(
  qc: QueryClient,
  event: RealtimeEvent,
  meta: EventMeta = {},
  state: CacheSyncState = cacheSyncState(qc),
): boolean {
  const atIso = meta.at ?? new Date(state.now()).toISOString();
  const parsed = Date.parse(atIso);
  const ctx: Ctx = {
    qc,
    at: Number.isNaN(parsed) ? state.now() : parsed,
    atIso,
    burrowId: meta.burrowId ?? null,
    state,
  };
  const handler = handlers[event.type] as (ctx: Ctx, e: RealtimeEvent) => boolean;
  return handler(ctx, event);
}

/** The AI provider's readiness and the AI clients and sign-ins (the shell's “agents can't reply” notice). */
const AI_STATUS_ENDPOINTS = ['host.agents', 'clients.list', 'signins.list'] as const;

type Handlers = { [T in RealtimeEvent['type']]: (ctx: Ctx, e: RealtimeEventOf<T>) => boolean };

const handlers: Handlers = {
  'message.created': (ctx, e) => applyMessage(ctx, e.message, true),
  'message.updated': (ctx, e) => applyMessage(ctx, e.message, false),

  'message.deleted': ({ qc, state }, e) => {
    state.tombstones.add(e.messageId);
    removeMessageEverywhere(qc, e.conversationId, e.messageId);
    return true;
  },

  typing: (ctx, e) => {
    if (!fresh(ctx, `typing:${e.conversationId}:${e.threadRootId ?? ''}:${e.principalId}`)) return false;
    const serverTtl = Date.parse(e.expiresAt) - ctx.at;
    const ttl =
      Number.isFinite(serverTtl) && serverTtl > 0 ? Math.min(serverTtl, TYPING_TTL_MS) : TYPING_TTL_MS;
    const entry: TypingEntry = {
      principalId: e.principalId,
      threadRootId: e.threadRootId,
      expiresAt: ctx.state.now() + ttl,
      ...(e.dispatchId ? { dispatchId: e.dispatchId } : {}),
    };
    setTyping(ctx, e.conversationId, e.principalId, e.threadRootId, e.active ? entry : null);
    return true;
  },

  'run.updated': (ctx, { run }) => {
    if (!fresh(ctx, `run:${run.id}`)) return false;
    const { qc } = ctx;
    patchEndpoint<RunDetail>(qc, 'runs.get', (d) => (d.run.id === run.id ? { ...d, run } : d));
    const principals = cachedPrincipals(qc);
    patchEndpoint<{ runs: Run[] }>(qc, 'runs.list', (d, key) => {
      if (!sameBurrow(qc, key, run.burrowId)) return d;
      const handle = key.query.agent;
      const agentId =
        typeof handle === 'string'
          ? ([...principals.values()].find((p) => p.handle === handle)?.id ?? '?')
          : null;
      const runs = reduceRunList(d.runs, run, { status: key.query.status, agentId });
      return runs === d.runs ? d : { ...d, runs };
    });
    patchMessages(ctx, (m) => patchCard(m, cardPatchers.run(run)));
    patchEndpoint<AgentProfile>(qc, 'agent.get', (d) => {
      if (d.agent.id !== run.agentId) return d;
      const currentRun = currentRunAfter(d.currentRun, run);
      return currentRun === d.currentRun ? d : { ...d, currentRun };
    });
    invalidateWork(qc);
    return true;
  },

  'run.log': (ctx, e) => {
    const { qc } = ctx;
    const maxSeq = Math.max(-1, ...e.lines.map((l) => l.seq));
    patchEndpoint<RunDetail>(qc, 'runs.get', (d) => {
      if (d.run.id !== e.runId) return d;
      const log = mergeLogLines(d.log, e.lines);
      const logCount = Math.max(d.run.logCount, maxSeq + 1);
      if (log === d.log && logCount === d.run.logCount) return d;
      return { ...d, log, run: logCount === d.run.logCount ? d.run : { ...d.run, logCount } };
    });
    patchEndpoint<{ lines: RunLogLine[]; hasMore: boolean }>(qc, 'runs.log', (d, key) => {
      if (Number(key.params.number) !== e.runNumber || !sameBurrow(qc, key, ctx.burrowId)) return d;
      const after = typeof key.query.after === 'number' ? key.query.after : -1;
      const lines = mergeLogLines(
        d.lines,
        e.lines.filter((l) => l.seq > after),
        Number.POSITIVE_INFINITY,
      );
      return lines === d.lines ? d : { ...d, lines };
    });
    return true;
  },

  'approval.updated': (ctx, { approval }) => {
    if (!fresh(ctx, `approval:${approval.id}`)) return false;
    applyApproval(ctx.qc, approval);
    invalidateWork(ctx.qc);
    refreshNeedsYouCount(ctx.qc);
    return true;
  },

  'plan.updated': (ctx, { plan }) => {
    if (!fresh(ctx, `plan:${plan.id}`)) return false;
    applyPlan(ctx.qc, plan);
    invalidateWork(ctx.qc);
    refreshNeedsYouCount(ctx.qc);
    return true;
  },

  'agent.updated': (ctx, { agent }) => {
    if (!fresh(ctx, `principal:${agent.id}`)) return false;
    const { qc } = ctx;
    // The one agent (Whombat one-agent.md OA-01): its name, face and runtime everywhere it shows.
    patchEndpoint<Bootstrap>(qc, 'conversations.bootstrap', (d) => {
      const principals = upsertBy(d.principals, agent, (p) => p.id === agent.id);
      return principals === d.principals ? d : { ...d, principals };
    });
    patchEndpoint<AgentProfile>(qc, 'agent.get', (d) => (d.agent.id === agent.id ? { ...d, agent } : d));
    // The AI side's status isn't polled any more (web-efficiency.md WE-06): an agent changing reads it again, at most
    // once per its staleTime (only active, stale queries refetch).
    for (const id of AI_STATUS_ENDPOINTS)
      void qc.refetchQueries({ queryKey: queryKeys.scope(id), type: 'active', stale: true });
    return true;
  },

  'grants.updated': (ctx, e) => {
    if (!fresh(ctx, `grants:${e.agentId}`)) return false;
    const { qc } = ctx;
    patchEndpoint<AgentProfile>(qc, 'agent.get', (d) =>
      d.agent.id === e.agentId ? { ...d, grants: e.grants, keys: summaryAfterGrants(e.grants) } : d,
    );
    patchEndpoint<RunDetail>(qc, 'runs.get', (d) =>
      d.run.agentId === e.agentId ? { ...d, grants: e.grants } : d,
    );
    return true;
  },

  'principal.created': (ctx, { principal }) => {
    const { qc } = ctx;
    patchEndpoint<Bootstrap>(qc, 'conversations.bootstrap', (d) => {
      if (d.burrow.id !== principal.burrowId || d.principals.some((p) => p.id === principal.id)) return d;
      const principals = insertOldestFirst(d.principals, principal, (p) => p.createdAt);
      return { ...d, principals };
    });
    return true;
  },

  'person.updated': (ctx, { person }) => {
    if (!fresh(ctx, `person:${person.id}`)) return false;
    const { qc } = ctx;
    patchEndpoint<Bootstrap>(qc, 'conversations.bootstrap', (d) => {
      if (d.burrow.id !== person.burrowId) return d;
      const principals = mapList(d.principals, (p) => (p.id === person.id ? person : p));
      const me = d.me.id === person.id ? person : d.me;
      return principals === d.principals && me === d.me ? d : { ...d, principals, me };
    });
    return true;
  },

  'conversation.updated': (ctx, { conversation: c }) => {
    if (!fresh(ctx, `conversation:${c.id}`)) return false;
    const { qc } = ctx;
    const patchDetail = (d: ConversationDetail): ConversationDetail =>
      d.conversation.id === c.id
        ? {
            ...d,
            conversation: c,
            summary: patchSummary(d.summary, c),
          }
        : d;
    patchEndpoint(qc, 'conversations.get', patchDetail);

    // Every conversation is the person's (CT-1514): one new to the sidebar is added, never taken off.
    let needsRefetch = false;
    let joinedOrLeft = false;
    patchEndpoint<Bootstrap>(qc, 'conversations.bootstrap', (d) => {
      if (d.burrow.id !== c.burrowId) return d;
      const section = sidebarSection(c.kind);
      const list = d.sidebar[section] as ConversationSummary[];
      const present = list.some((s) => s.id === c.id);
      if (!present) joinedOrLeft = true;
      let next: ConversationSummary[] = list;
      if (present) next = mapList(list, (s) => (s.id === c.id ? patchSummary(s, c) : s));
      else if (c.kind !== 'branch') next = [...list, newSummary(c)];
      else needsRefetch = true; // branch rows need PR status from the server
      return next === list ? d : { ...d, sidebar: { ...d.sidebar, [section]: next } };
    });
    patchEndpoint<{ conversations: ConversationSummary[] }>(qc, 'conversations.list', (d, key) => {
      if (!sameBurrow(qc, key, c.burrowId)) return d;
      const matchesKind = key.query.kind === undefined || key.query.kind === c.kind;
      if (!matchesKind) {
        const conversations = removeWhere(d.conversations, (s) => s.id === c.id);
        return conversations === d.conversations ? d : { ...d, conversations };
      }
      const conversations = d.conversations.some((s) => s.id === c.id)
        ? mapList(d.conversations, (s) => (s.id === c.id ? patchSummary(s, c) : s))
        : [...d.conversations, newSummary(c)];
      return conversations === d.conversations ? d : { ...d, conversations };
    });
    if (needsRefetch) void qc.invalidateQueries({ queryKey: queryKeys.scope('conversations.bootstrap') });
    // A task chat renamed (`set_chat_title`) or archived: its row in the chats lists (CT-337, AP-1270).
    if (c.chat) {
      let listed = false;
      patchEndpoint<{ chats: ChatSummary[] }>(qc, 'chats.list', (d) => {
        if (!d.chats.some((x) => x.id === c.id)) return d;
        listed = true;
        return { ...d, chats: withChat(d.chats, c) };
      });
      if (!listed) void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.list') });
    }
    // The viewer joined or left: which conversations' Files they may see changed (FS-07, AP-776).
    if (joinedOrLeft) invalidateFiles(qc, c.id);
    return true;
  },

  'conversation.unread': (ctx, e) => {
    if (!fresh(ctx, `unread:${e.conversationId}`)) return false;
    setConversationUnread(ctx.qc, e.conversationId, e.unread, e.mentions);
    setChatRoomUnread(ctx.qc, e.conversationId, e.unread);
    // Read to the end (here or on another device): its mentions, direct messages and replies leave the inbox (AP-704).
    if (e.unread === 0) markInboxReadAt(ctx.qc, e.conversationId, null, ctx.atIso);
    // The room's badge moved: which of its threads have something new is asked again (Whombat thread-unread.md).
    invalidateThreadUnread(ctx.qc, e.conversationId);
    return true;
  },

  'audit.appended': (ctx, { event }) => {
    const { qc } = ctx;
    if (!once(ctx, `audit:${event.id}`)) return false;
    patchEndpoint<{ event: AuditEvent }>(qc, 'audit.get', (d) => (d.event.id === event.id ? { event } : d));
    if (event.text === null) return true;
    const principals = cachedPrincipals(qc);
    let refetch = false;
    patchEndpoint<AuditPage | InfiniteData<AuditPage>>(qc, 'audit.list', (d, key) => {
      if (!sameBurrow(qc, key, event.burrowId)) return d;
      const who = key.query.who;
      const whoId =
        typeof who === 'string' ? ([...principals.values()].find((p) => p.handle === who)?.id ?? null) : null;
      const actor = (key.query.actor ?? 'everyone') as AuditListFilter['actor'];
      const actorKnown = principals.has(event.actorId);
      if ((typeof who === 'string' && !whoId) || (actor !== 'everyone' && !actorKnown)) {
        refetch = true;
        return d;
      }
      const filter: AuditListFilter = {
        actor,
        kind: (key.query.kind ?? 'all') as AuditListFilter['kind'],
        whoId,
      };
      const isAgent = (id: string) => principals.get(id)?.kind === 'agent';
      if ('pages' in d) {
        if (d.pages.some((p) => p.events.some((x) => x.id === event.id))) return d;
        return mapPages(d, (p, i) => (i === 0 ? reduceAuditPage(p, event, filter, isAgent) : p));
      }
      return reduceAuditPage(d, event, filter, isAgent);
    });
    if (refetch) void qc.invalidateQueries({ queryKey: queryKeys.scope('audit.list') });
    return true;
  },

  'pr.updated': (ctx, { pr }) => {
    if (!fresh(ctx, `pr:${pr.id}`)) return false;
    const { qc } = ctx;
    const status = prStatus(pr);
    patchEndpoint<PullRequestDetail>(qc, 'prs.get', (d) =>
      d.pr.id === pr.id ? { ...d, pr, status, mergeBlock: mergeBlock(pr, 'person') } : d,
    );
    patchEndpoint<{ prs: PullRequest[] }>(qc, 'prs.list', (d, key) => {
      if (!sameBurrow(qc, key, ctx.burrowId)) return d;
      const matches = key.query.state === undefined || key.query.state === pr.state;
      const prs = matches
        ? upsertBy(
            d.prs,
            pr,
            (p) => p.id === pr.id,
            (l) => [pr, ...l],
          )
        : removeWhere(d.prs, (p) => p.id === pr.id);
      return prs === d.prs ? d : { ...d, prs };
    });
    patchEndpoint<Bootstrap>(qc, 'conversations.bootstrap', (d) => {
      const branchRooms = mapList(d.sidebar.branchRooms, (r) =>
        r.id === pr.conversationId && (r.prStatus !== status || r.dot !== PR_STATUS_TONES[status])
          ? { ...r, prStatus: status, dot: PR_STATUS_TONES[status] }
          : r,
      );
      return branchRooms === d.sidebar.branchRooms ? d : { ...d, sidebar: { ...d.sidebar, branchRooms } };
    });
    const patchDetail = (d: ConversationDetail): ConversationDetail =>
      d.pr?.id === pr.id ? { ...d, pr } : d;
    patchEndpoint(qc, 'conversations.get', patchDetail);
    return true;
  },

  'notification.created': (ctx, { item }) => {
    const { qc } = ctx;
    const first = once(ctx, `notification:${item.id}`);
    patchEndpoint<InboxResponse>(qc, 'notifications.inbox', (d, key) => {
      if (!sameBurrow(qc, key, item.burrowId)) return d;
      return reduceInbox(d, item, (key.query.filter ?? 'all') as InboxFilter, !first);
    });
    // Something new needs the viewer: the inbox's NEEDS YOU comes from `work.overview` (AP-703), the count from
    // `work.needsYou` (WE-07).
    if (first && item.kind === 'needs_you') {
      invalidateWork(qc);
      refreshNeedsYouCount(qc);
    }
    return first;
  },

  'search.answer': (ctx, { answer }) => {
    if (!fresh(ctx, `answer:${answer.id}`)) return false;
    const { qc } = ctx;
    patchEndpoint<{ answer: typeof answer }>(qc, 'search.getAnswer', (d) =>
      d.answer.id === answer.id ? { answer } : d,
    );
    patchEndpoint<SearchResponse>(qc, 'search.query', (d, key) => {
      if (!sameBurrow(qc, key, answer.burrowId)) return d;
      if (typeof key.query.q !== 'string' || key.query.q.trim() !== answer.query.trim()) return d;
      if (
        d.answer &&
        d.answer.id !== answer.id &&
        Date.parse(d.answer.createdAt) > Date.parse(answer.createdAt)
      ) {
        return d;
      }
      return { ...d, answer };
    });
    return true;
  },

  'canvas.updated': (ctx, { canvas }) => {
    if (!fresh(ctx, `canvas:${canvas.id}`)) return false;
    const { qc } = ctx;
    patchEndpoint<CanvasDetail>(qc, 'canvases.get', (d) =>
      d.canvas.id === canvas.id ? { ...d, canvas } : d,
    );
    patchEndpoint<{ canvases: CanvasSummary[] }>(qc, 'canvases.list', (d, key) => {
      if (!sameBurrow(qc, key, canvas.burrowId)) return d;
      const existing = d.canvases.find((c) => c.id === canvas.id);
      const summary: CanvasSummary = {
        ...canvas,
        conversationTitle: existing?.conversationTitle ?? conversationTitleOf(qc, canvas.conversationId),
      };
      const canvases = upsertBy(
        d.canvases,
        summary,
        (c) => c.id === canvas.id,
        (l) => [summary, ...l],
      );
      return canvases === d.canvases ? d : { ...d, canvases };
    });
    return true;
  },

  'canvas.comment': (ctx, { comment }) => {
    if (!fresh(ctx, `comment:${comment.id}`)) return false;
    patchEndpoint<CanvasDetail>(ctx.qc, 'canvases.get', (d) => reduceCanvasComments(d, comment));
    return true;
  },

  'burrow.updated': (ctx, { burrow }) => {
    if (!fresh(ctx, `burrow:${burrow.id}`)) return false;
    const { qc } = ctx;
    patchEndpoint<Bootstrap>(qc, 'conversations.bootstrap', (d) =>
      d.burrow.id === burrow.id ? { ...d, burrow } : d,
    );
    patchEndpoint<{ burrow: typeof burrow }>(qc, 'burrows.get', (d) =>
      d.burrow.id === burrow.id ? { burrow } : d,
    );
    const patchMemberships = (d: MeResponse): MeResponse => {
      const memberships = mapList(d.memberships, (m) =>
        m.burrowId === burrow.id && (m.burrowName !== burrow.name || m.burrowSlug !== burrow.slug)
          ? { ...m, burrowName: burrow.name, burrowSlug: burrow.slug }
          : m,
      );
      return memberships === d.memberships ? d : { ...d, memberships };
    };
    patchEndpoint<MeResponse>(qc, 'me.get', patchMemberships);
    return true;
  },

  // Supervised automations (docs/decisions/bp-automations.md): the list, the editor and run pages stay live.
  'automation.updated': (ctx, { automation }) => {
    if (!fresh(ctx, `automation:${automation.id}`)) return false;
    const { qc } = ctx;
    // A deleted automation (0.66, `automations.delete`) never comes back: a late frame doesn't put it back on the list,
    // and its pages keep saying it was deleted.
    const gone = !!automation.deletedAt || ctx.state.tombstones.has(`automation:${automation.id}`);
    patchEndpoint<{ automations: Automation[] }>(qc, 'automations.list', (d, key) => {
      if (!sameBurrow(qc, key, automation.burrowId)) return d;
      if (gone) return dropAutomation(d, automation.id);
      const known = d.automations.some((a) => a.id === automation.id);
      return {
        automations: known
          ? d.automations.map((a) => (a.id === automation.id ? automation : a))
          : [automation, ...d.automations],
      };
    });
    const patch = <T extends { automation: Automation }>(d: T): T =>
      d.automation.id === automation.id
        ? {
            ...d,
            automation: { ...automation, deletedAt: automation.deletedAt ?? d.automation.deletedAt ?? null },
          }
        : d;
    patchEndpoint<AutomationDetail>(qc, 'automations.get', patch);
    patchEndpoint<AutomationRunDetail>(qc, 'automations.run', patch);
    return true;
  },

  // Deleted (0.66, `automations.delete`): it leaves every list; an open automation or run page sees `deletedAt` and says
  // so. The tombstone keeps a late `automation.updated` from bringing it back.
  'automation.deleted': (ctx, { automationId }) => {
    const { qc, state, atIso } = ctx;
    state.tombstones.add(`automation:${automationId}`);
    patchEndpoint<{ automations: Automation[] }>(qc, 'automations.list', (d) =>
      dropAutomation(d, automationId),
    );
    const mark = <T extends { automation: Automation }>(d: T): T =>
      d.automation.id === automationId && !d.automation.deletedAt
        ? { ...d, automation: { ...d.automation, deletedAt: atIso } }
        : d;
    patchEndpoint<AutomationDetail>(qc, 'automations.get', mark);
    patchEndpoint<AutomationRunDetail>(qc, 'automations.run', mark);
    return true;
  },

  'automation.run.updated': (ctx, { run }) => {
    if (!fresh(ctx, `automation-run:${run.id}`)) return false;
    const { qc } = ctx;
    patchEndpoint<{ runs: AutomationRun[] }>(qc, 'automations.runs', (d, key) => {
      if (!sameBurrow(qc, key, run.burrowId)) return d;
      if (typeof key.query.automation === 'string' && key.query.automation !== run.automationId) return d;
      if (typeof key.query.status === 'string' && key.query.status !== run.status)
        return { runs: d.runs.filter((r) => r.id !== run.id) };
      const known = d.runs.some((r) => r.id === run.id);
      return { runs: known ? d.runs.map((r) => (r.id === run.id ? run : r)) : [run, ...d.runs] };
    });
    patchEndpoint<AutomationRunDetail>(qc, 'automations.run', (d) =>
      d.run.id === run.id ? { ...d, run } : d,
    );
    invalidateWork(qc);
    return true;
  },

  // Observed activity (WS-12): one row per action, upserted by id; older reports change nothing.
  'activity.updated': (ctx, { activity }) => {
    if (!fresh(ctx, `activity:${activity.id}`)) return false;
    applyActivity(ctx.qc, activity);
    setAgentNow(ctx.qc, activity);
    return true;
  },

  // A turn queued, started or finished (WS-19): the work overview's sections and health move with it.
  'dispatch.updated': (ctx, { dispatch }) => {
    if (!fresh(ctx, `dispatch:${dispatch.id}`)) return false;
    invalidateWork(ctx.qc);
    return true;
  },

  // One of the viewer's own Vault entries changed (docs/decisions/vault.md; topic `me`, only to its owner). The frame
  // carries no entry data: the Vault's reads refetch. `null` is the whole Vault, the home network list and the kept
  // websites included.
  'vault.updated': (ctx, { entryId }) => {
    invalidateVault(ctx.qc, entryId);
    // A 1Password pass that changed entries changes its connection's counts too (Whombat onepassword-sync.md).
    void ctx.qc.invalidateQueries({ queryKey: queryKeys.scope('connections.onePassword') });
    return true;
  },

  // A subscription's usage changed (contracts CT-155; topic `me`). The snapshot is small, so the list refetches
  // rather than being patched.
  'usage.updated': (ctx) => {
    void ctx.qc.invalidateQueries({ queryKey: queryKeys.scope('usage.list') });
    return true;
  },

  // One of the agent's services started, stopped, failed or came back (contracts 3.0, CT-1536; topic `burrow`): it
  // carries nothing, so `services.list` refetches (app one-person.md AP-5655).
  'services.changed': (ctx) => {
    void ctx.qc.invalidateQueries({ queryKey: queryKeys.scope('services.list') });
    return true;
  },

  // The burrow's AI gateway pool changed (contracts 0.76, CT-332; Whombat ai-gateway.md AIG-11; topic `burrow`): its
  // accounts, limits and whether it answers are in `usage.list`, which refetches (app AP-1122).
  'usage.gateway_updated': (ctx) => {
    void ctx.qc.invalidateQueries({ queryKey: queryKeys.scope('usage.list') });
    return true;
  },

  // A conversation's Files changed (contracts CT-275, files-space.md AP-776; topic `me` of its members): the frame carries
  // no file data, so the sidebar's summary and that conversation's list refetch.
  'files.changed': (ctx, { conversationId }) => {
    invalidateFiles(ctx.qc, conversationId);
    return true;
  },

  // Contracts 0.55 (CT-296): a deploy was recorded (topic `burrow`). Until Deploys keeps its own lists live (WE-17,
  // MQ-07), its reads refetch, and with them the sidebar's Deploys row (work-removal.md AP-850).
  'deployment.recorded': (ctx) => {
    for (const id of ['deployments.list', 'deployments.environments'])
      void ctx.qc.invalidateQueries({ queryKey: queryKeys.scope(id) });
    return true;
  },

  // Contracts 0.55 (CT-300): notifications were read on this device or another (topic `me`): the rows read and the
  // unread count, in every cached inbox of this burrow (web-efficiency.md WE-11, mobile MN-03).
  'notification.read': (ctx, e) => {
    const { qc } = ctx;
    // The newest read event's count is the server's word; an older one arriving late only marks rows.
    const latest = fresh(ctx, `notification-read:${ctx.burrowId ?? ''}`);
    patchEndpoint<InboxResponse>(qc, 'notifications.inbox', (d, key) =>
      sameBurrow(qc, key, ctx.burrowId) ? reduceNotificationRead(d, e, ctx.atIso, latest) : d,
    );
    return true;
  },

  // The viewer's notification level for a conversation changed, on this device or another (contracts CT-182; topic
  // `me`): the sidebar, the header's bell and lists show it at once (AP-469).
  'conversation.notify': (ctx, e) => {
    if (!fresh(ctx, `notify:${e.conversationId}`)) return false;
    setConversationNotify(ctx.qc, e.conversationId, e.notify);
    return true;
  },

  // One of the viewer's backup files or restores moved (contracts 0.79, CT-335; backup-file.md; topic `me`, its maker
  // only): the frame carries no content, so the list and that file's or restore's read refetch.
  'backups.changed': (ctx, e) => {
    invalidateBackups(ctx.qc, e);
    return true;
  },

  // One Whombat (contracts 0.80, CT-336, CT-339): the frames carry no content (or a row the lists refetch around), so
  // the reads behind them refetch. Streams WS and WT may patch the cache instead. Every turn of the assistant sends
  // `working`, so the overview refetches at most once a second however many come (`calm.ts`).
  'home.changed': (ctx, e) => {
    invalidateCalmly(ctx.qc, ctx.state.calm, 'home.overview');
    if (e.parts.includes('watch')) void ctx.qc.invalidateQueries({ queryKey: queryKeys.scope('watch.list') });
    // A thing changed, or what the assistant found out about one (look-research.md LR-S18): an open page reads again,
    // so its research card says “Zigbee works again” without waiting for its next minute.
    if (e.parts.includes('things')) {
      void ctx.qc.invalidateQueries({ queryKey: queryKeys.scope('things.page') });
      // A server's page reads its research on its own (handle-it.md).
      void ctx.qc.invalidateQueries({ queryKey: queryKeys.scope('looks.get') });
    }
    if (e.parts.includes('widgets'))
      void ctx.qc.invalidateQueries({ queryKey: queryKeys.scope('widgets.list') });
    return true;
  },
  // A widget got new points: its lists refetch, and the overview only when it shows that widget (Home's pinned ones);
  // a widget kept on a thing's page isn't in it.
  'widget.updated': (ctx, e) => {
    void ctx.qc.invalidateQueries({ queryKey: queryKeys.scope('widgets.list') });
    const shown = endpointQueries(ctx.qc, 'home.overview').some((q) =>
      (q.state.data as HomeOverview | undefined)?.widgets?.some((w) => w.id === e.widgetId),
    );
    if (shown) invalidateCalmly(ctx.qc, ctx.state.calm, 'home.overview');
    return true;
  },
  // Servers (stream WT, AP-1304): rows and guest states patch in place, the rest refetches (`hosts/apply.ts`).
  'hosts.server': (ctx, e) => HOSTS_APPLIERS['hosts.server'](ctx.qc, e),
  'hosts.guest': (ctx, e) => HOSTS_APPLIERS['hosts.guest'](ctx.qc, e),
  'hosts.alert': (ctx) => HOSTS_APPLIERS['hosts.alert'](ctx.qc),
  'hosts.task': (ctx) => HOSTS_APPLIERS['hosts.task'](ctx.qc),
  'hosts.enrollment': (ctx) => HOSTS_APPLIERS['hosts.enrollment'](ctx.qc),
  'hosts.resync': (ctx) => HOSTS_APPLIERS['hosts.resync'](ctx.qc),
  'hosts.install': (ctx) => HOSTS_APPLIERS['hosts.install'](ctx.qc),
  'hosts.repoint': (ctx) => HOSTS_APPLIERS['hosts.repoint'](ctx.qc),
  // A Chat thread's choice of what answers changed, on this device or another (contracts 0.96, CT-462; chat-runtime.md
  // CR-02; topic `me`; app chat-runtime.md AP-2682): the popover's read of that thread and the threads lists, which
  // carry the choice, change in place.
  // What the agent handed to T3 Code from a conversation moved on (Whombat t3code.md T3-25; topic `conv`): the frame
  // carries the conversation's whole list, which replaces the cached one (app t3code-handoff.md).
  'conversation.handoffs': (ctx, e) => {
    // Each frame is the whole list: an older one arriving late never replaces a newer one.
    if (!fresh(ctx, `handoffs:${e.conversationId}`)) return false;
    patchEndpoint<ConversationHandoffs>(ctx.qc, 'conversations.handoffs', (d) =>
      d.conversationId === e.conversationId ? { conversationId: e.conversationId, handoffs: e.handoffs } : d,
    );
    return true;
  },
  'chat.thread_runtime': (ctx, e) => {
    applyChatThreadRuntime(ctx.qc, e.rootId, e.runtime);
    return true;
  },
  // A Chat or Feedback room was cleared, on this device or another (contracts 0.119, CT-991; Whombat chat-clear.md
  // CHC-05; topic `me`): its timeline starts after the clear, so it is read again from its newest page. Clearing settled
  // what could settle (Whombat chat-inbox.md CIB-13), so the threads lists and what is new read again too.
  'chat.cleared': (ctx, e) => {
    void ctx.qc.resetQueries({
      queryKey: queryKeys.scope('messages.list', { conversationId: e.conversationId }),
    });
    void ctx.qc.invalidateQueries({ queryKey: queryKeys.scope('chats.threads') });
    void ctx.qc.invalidateQueries({ queryKey: queryKeys.scope('chats.unread') });
    return true;
  },
  // A box from before one Chat moved a thread to Code or back (Whombat one-chat.md; topic `me`): the lists read again.
  'chat.placed': (ctx) => {
    void ctx.qc.invalidateQueries({ queryKey: queryKeys.scope('chats.threads') });
    void ctx.qc.invalidateQueries({ queryKey: queryKeys.scope('chats.unread') });
    return true;
  },
  // A thread of Chat or Feedback settled or opened again, on any device, by itself or by a new message in it (3.8;
  // Whombat chat-settle.md CHS-04…CHS-06; topic `me`; app chat-settle.md AP-6158): its first message and every Threads list
  // change in place, as a settle here did at once. Several at once (`rootId` null): the room and its lists read again.
  'chat.settled': (ctx, e) => {
    if (e.rootId === null) {
      void ctx.qc.invalidateQueries({
        queryKey: queryKeys.scope('messages.list', { conversationId: e.conversationId }),
      });
      void ctx.qc.invalidateQueries({ queryKey: queryKeys.scope('messages.thread') });
      void ctx.qc.invalidateQueries({ queryKey: queryKeys.scope('chats.threads') });
      return true;
    }
    if (!fresh(ctx, `settled:${e.rootId}`)) return false;
    applyThreadSettle(ctx.qc, { room: e.room, rootId: e.rootId, settled: e.settled });
    return true;
  },
  // The screen on the desk changed (contracts 0.100, CT-517…CT-534; Whombat desk-display.md DK-12; topic `me`): the
  // frame carries no content, so the screen's read (`desk.get`, `desk/react.ts`) refetches.
  'desk.changed': (ctx) => {
    void ctx.qc.invalidateQueries({ queryKey: [QUERY_ROOT, 'desk.get'] });
    // Settings → Screen's preview (3.2, DK-123) follows what's saved.
    void ctx.qc.invalidateQueries({ queryKey: [QUERY_ROOT, 'desk.preview'] });
    // Settings → Screens (3.6, DK-128): the list and each screen's own read.
    void ctx.qc.invalidateQueries({ queryKey: [QUERY_ROOT, 'desk.screens'] });
    void ctx.qc.invalidateQueries({ queryKey: [QUERY_ROOT, 'desk.screen.get'] });
    return true;
  },
  // Voice typing changed (contracts 3.1; docs/decisions/dictation.md; topic `me`): its settings or a speech model's
  // download. The frame carries nothing, so `voice.get` (`voice/react.ts`) refetches: Settings and the composers' mic.
  'voice.changed': (ctx) => {
    void ctx.qc.invalidateQueries({ queryKey: [QUERY_ROOT, 'voice.get'] });
    return true;
  },
};

/** Refetch the backup files' reads after a change (backup-file.md): the list, and the one file's or restore's view. */
export function invalidateBackups(
  qc: QueryClient,
  changed: { kind: 'file' | 'restore'; id: string } | null = null,
): void {
  void qc.invalidateQueries({ queryKey: queryKeys.scope('backups.list') });
  if (!changed) return;
  if (changed.kind === 'file')
    void qc.invalidateQueries({ queryKey: queryKeys.scope('backups.get', { backupFileId: changed.id }) });
  else
    void qc.invalidateQueries({ queryKey: queryKeys.scope('backups.getRestore', { restoreId: changed.id }) });
}

/**
 * Refetch the Vault's reads after a change (AP-109): the list, the profile pane's keys, and the entry's detail and
 * RECENT USE (every entry's when `entryId` is null, with the home network list).
 */
export function invalidateVault(qc: QueryClient, entryId: string | null): void {
  const scope = entryId ? { entryId } : undefined;
  for (const id of ['vault.list', 'vault.agentKeys'])
    void qc.invalidateQueries({ queryKey: queryKeys.scope(id) });
  for (const id of ['vault.get', 'vault.uses'])
    void qc.invalidateQueries({ queryKey: queryKeys.scope(id, scope) });
  if (entryId) return;
  void qc.invalidateQueries({ queryKey: queryKeys.scope('vaultNetworks.list') });
  // The websites the agent keeps signed in (Whombat kept-sites.md) tell the person's apps through the same frame.
  void qc.invalidateQueries({ queryKey: queryKeys.scope('keptSites.list') });
}

/**
 * Refetch Files after a change (AP-776): the summary (the sidebar's row and `/files`) and, for a conversation, its list;
 * without one, every list.
 */
export function invalidateFiles(qc: QueryClient, conversationId: string | null): void {
  void qc.invalidateQueries({ queryKey: queryKeys.scope('files.summary') });
  void qc.invalidateQueries({
    queryKey: queryKeys.scope('files.list', conversationId ? { conversationId } : undefined),
  });
}

/* Shared pieces ---------------------------------------------------------------------------------- */

function applyMessage(ctx: Ctx, m: Message, created: boolean): boolean {
  if (ctx.state.tombstones.has(m.id)) return false;
  if (!fresh(ctx, `message:${m.id}`)) return false;
  const { qc } = ctx;
  upsertMessageEverywhere(qc, m);
  if (created) {
    // A message ends its author's typing indicator (the version guard drops an older typing frame).
    fresh(ctx, `typing:${m.conversationId}:${m.threadRootId ?? ''}:${m.authorId}`);
    setTyping(ctx, m.conversationId, m.authorId, m.threadRootId, null);
    const bump = <S extends ConversationSummary>(s: S): S =>
      s.id === m.conversationId &&
      (s.lastMessageAt === null || Date.parse(s.lastMessageAt) < Date.parse(m.createdAt))
        ? { ...s, lastMessageAt: m.createdAt }
        : s;
    patchEndpoint<Bootstrap>(qc, 'conversations.bootstrap', (d) => mapSidebar(d, bump));
    bumpChat(qc, m);
  }
  // A device skill card arriving or being decided changes Home's Needs you and things (one-whombat-shell.md AP-1274).
  if (m.card?.kind === 'device_skill')
    void qc.invalidateQueries({ queryKey: queryKeys.scope('home.overview') });
  // A council's or checklist's card moved on: its thread's row says how far it is.
  if (m.card?.kind === 'council' || m.card?.kind === 'delegation')
    void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.threads') });
  return true;
}

/**
 * A new message in a task chat (contracts 0.80, CT-337; app one-whombat-shell.md AP-1270): its row in the chats lists
 * moves to the top with the message's start; a top-level message the lists don't have yet (a chat started elsewhere)
 * reads them again.
 */
function bumpChat(qc: QueryClient, m: Message): void {
  if (m.threadRootId) return;
  let known = false;
  let cached = false;
  patchEndpoint<{ chats: ChatSummary[] }>(qc, 'chats.list', (d) => {
    cached = true;
    const at = d.chats.findIndex((c) => c.id === m.conversationId);
    if (at < 0) return d;
    known = true;
    const chat = d.chats[at] as ChatSummary;
    if (chat.lastAt && Date.parse(chat.lastAt) > Date.parse(m.createdAt)) return d;
    const next = { ...chat, lastAt: m.createdAt, lastText: m.text.slice(0, 200) };
    return { ...d, chats: [next, ...d.chats.filter((c) => c.id !== m.conversationId)] };
  });
  if (cached && !known && m.conversationId.startsWith('cnv_'))
    void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.list') });
}

/**
 * What needs the viewer changed (a decision leaves no frame that says so): read the count again — `work.needsYou`
 * where it is read (contracts CT-302; web-efficiency.md WE-07), not the whole bootstrap; the bootstrap only for a client
 * that reads the count from it (a Whombat without `work.needs_you_count`).
 */
export function invalidateNeedsYouCount(qc: QueryClient): void {
  const scope = queryKeys.scope('work.needsYou');
  if (endpointQueries(qc, 'work.needsYou').length > 0) void qc.invalidateQueries({ queryKey: scope });
  else void qc.invalidateQueries({ queryKey: queryKeys.scope('conversations.bootstrap') });
}

/** An approval, a plan step or a new needs-you notification may change the count: only the count reads again. */
function refreshNeedsYouCount(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: queryKeys.scope('work.needsYou') });
}

/** The viewer's unread badge of a conversation, wherever it shows (also used by mark-read). */
/** A room's badge in `chats.list` (Chat and Feedback in the sidebar and the phone's tabs). */
export function setChatRoomUnread(qc: QueryClient, conversationId: string, unread: number): void {
  patchEndpoint<{ chats: ChatSummary[] }>(qc, 'chats.list', (d) =>
    d.chats.some((c) => c.id === conversationId && c.unread !== unread)
      ? { ...d, chats: d.chats.map((c) => (c.id === conversationId ? { ...c, unread } : c)) }
      : d,
  );
}

/**
 * Asks `chats.unread` again for the room of this conversation (or a room not known yet): a reply, a read or a settle
 * there changed which threads have something new. Only lists on screen are fetched again.
 */
export function invalidateThreadUnread(qc: QueryClient, conversationId: string): void {
  void qc.invalidateQueries({
    queryKey: queryKeys.scope('chats.unread'),
    predicate: (q) => {
      const data = q.state.data as ChatUnreadResponse | undefined;
      return !data?.conversationId || data.conversationId === conversationId;
    },
  });
}

export function setConversationUnread(
  qc: QueryClient,
  conversationId: string,
  unread: number,
  mentions: number,
): void {
  const set = <S extends ConversationSummary>(s: S): S =>
    s.id === conversationId && (s.unread !== unread || s.mentions !== mentions)
      ? { ...s, unread, mentions }
      : s;
  patchSummariesEverywhere(qc, set);
}

/**
 * The viewer's notification level of a conversation, wherever it shows (the sidebar's muted look, the header's bell;
 * AP-469, AP-470). Also used optimistically by `useSetNotify`.
 */
export function setConversationNotify(qc: QueryClient, conversationId: string, notify: NotifyLevel): void {
  const set = <S extends ConversationSummary>(s: S): S =>
    s.id === conversationId ? withNotify(s, notify) : s;
  patchSummariesEverywhere(qc, set);
  const patchDetail = (d: ConversationDetail): ConversationDetail =>
    d.conversation.id === conversationId && d.notify !== notify ? { ...d, notify } : d;
  patchEndpoint(qc, 'conversations.get', patchDetail);
}

/** Apply `set` to a conversation's summary in the sidebar, in lists and in its detail. */
function patchSummariesEverywhere(qc: QueryClient, set: <S extends ConversationSummary>(s: S) => S): void {
  patchEndpoint<Bootstrap>(qc, 'conversations.bootstrap', (d) => mapSidebar(d, set));
  patchEndpoint<{ conversations: ConversationSummary[] }>(qc, 'conversations.list', (d) => {
    const conversations = mapList(d.conversations, set);
    return conversations === d.conversations ? d : { ...d, conversations };
  });
  const patchDetail = (d: ConversationDetail): ConversationDetail => {
    const summary = set(d.summary);
    return summary === d.summary ? d : { ...d, summary };
  };
  patchEndpoint(qc, 'conversations.get', patchDetail);
}

/** Map every summary of the bootstrap's sidebar (branch rooms and the person's rooms with the agent). */
function mapSidebar(d: Bootstrap, fn: <S extends ConversationSummary>(s: S) => S): Bootstrap {
  const { sidebar } = d;
  const branchRooms = mapList(sidebar.branchRooms, fn);
  const dms = mapList(sidebar.dms, fn);
  if (branchRooms === sidebar.branchRooms && dms === sidebar.dms) return d;
  return { ...d, sidebar: { ...sidebar, branchRooms, dms } };
}

/** The sidebar list a conversation of this kind belongs in. */
function sidebarSection(kind: Conversation['kind']): 'branchRooms' | 'dms' {
  return kind === 'dm' ? 'dms' : 'branchRooms';
}

/** The room (`chat`, `feedback`) of a conversation as the cached chats lists say, or null (a task chat, unknown). */
function cachedRoomOf(qc: QueryClient, conversationId: string): ChatRoom | null {
  for (const { data } of cachedData<{ chats: ChatSummary[] }>(qc, 'chats.list')) {
    const s = data.chats.find((c) => c.id === conversationId);
    if (!s) continue;
    const room = chatSummaryRoom(s);
    return room === 'task' ? null : room;
  }
  return null;
}

/**
 * A Chat thread's choice of what answers (contracts 0.96, CT-461/CT-462; Whombat chat-runtime.md CR-02; app
 * chat-runtime.md AP-2682) in every cached read that shows it: `chats.runtime` asked for that thread, and the thread's
 * row in the Threads lists. Null: it follows the assistant's own again. The same choice changes nothing.
 */
export function applyChatThreadRuntime(qc: QueryClient, rootId: string, runtime: ChatRuntime | null): void {
  patchEndpoint<ChatRuntimeView>(qc, 'chats.runtime', (d, key) =>
    key.query.thread === rootId && !chatRuntimeEquals(d.thread, runtime) ? { ...d, thread: runtime } : d,
  );
  patchEndpoint<InfiniteData<ChatThreadsResponse>>(qc, 'chats.threads', (d) => {
    if (!('pages' in d)) return d;
    const has = d.pages.some((p) =>
      p.threads.some((t) => t.rootId === rootId && !chatRuntimeEquals(t.runtime, runtime)),
    );
    if (!has) return d;
    return {
      ...d,
      pages: d.pages.map((p) => ({
        ...p,
        threads: p.threads.map((t) => (t.rootId === rootId ? { ...t, runtime } : t)),
      })),
    };
  });
}

/** The choice a cached `chats.runtime` holds for a thread (undefined: none cached), to put back after a refusal. */
export function cachedChatThreadRuntime(qc: QueryClient, rootId: string): ChatRuntime | null | undefined {
  for (const { data, key } of cachedData<ChatRuntimeView>(qc, 'chats.runtime')) {
    if (parseKey(key)?.query.thread === rootId && data.thread !== undefined) return data.thread;
  }
  for (const { data } of cachedData<InfiniteData<ChatThreadsResponse>>(qc, 'chats.threads')) {
    if (!('pages' in data)) continue;
    const t = data.pages.flatMap((p) => p.threads).find((x) => x.rootId === rootId);
    if (t && t.runtime !== undefined) return t.runtime;
  }
  return undefined;
}

/** A thread settling or opening again (`applyThreadSettle`): its room, its first message, how it is now. */
export interface ThreadSettleChange {
  room: ChatRoom;
  rootId: string;
  settled: ThreadSettle | null;
  /** The thread as the server answered it (`chats.settle`): what a list it joins shows. */
  thread?: ChatThread;
}

/**
 * A thread settled or opened again (Whombat chat-settle.md CHS-01, CHS-05; app chat-settle.md AP-6158) in every cached
 * read: its first message (the room folds it, the thread shows the settled line), and the room's Threads lists — in
 * place in a list of every thread, out of `open` and into `settled` or back (`threadPagesSettled`), the first page's
 * `settledCount` up or down once. The same change twice changes nothing, so a settle shown at once and its frame agree.
 * A list it belongs in but can't place reads again. Also used optimistically by `useSettleThread`.
 */
export function applyThreadSettle(qc: QueryClient, change: ThreadSettleChange): void {
  const { room, rootId, settled } = change;
  // How it was before, from the lists or its first message: the count moves only on a real change.
  let was: boolean | undefined;
  let known: ChatThread | undefined = change.thread;
  for (const { data } of cachedData<InfiniteData<ChatThreadsResponse>>(qc, 'chats.threads')) {
    if (!('pages' in data)) continue;
    const t = data.pages.flatMap((p) => p.threads).find((x) => x.rootId === rootId);
    if (!t) continue;
    was ??= !!t.settled;
    known ??= t;
  }
  let root: Message | undefined;
  for (const id of ['messages.list', 'messages.thread', 'messages.get']) {
    patchEndpoint<unknown>(qc, id, (d) =>
      mapMessagesIn(d, (m) => {
        if (m.id !== rootId) return m;
        root ??= m;
        return sameThreadSettle(m.settled, settled) ? m : { ...m, settled };
      }),
    );
  }
  if (was === undefined && root) was = !!root.settled;
  if (!known && root) known = { ...threadOfMessage(root, room), settled };
  const delta = was === undefined || was === !!settled ? 0 : settled ? 1 : -1;
  let stale = false;
  patchEndpoint<InfiniteData<ChatThreadsResponse>>(qc, 'chats.threads', (d, key) => {
    if (!key.infinite || !('pages' in d)) return d;
    if (((key.query.room as ChatRoom | undefined) ?? 'chat') !== room) return d;
    const scope = {
      room,
      subjectKind: (key.query.subjectKind as string | undefined) ?? null,
      subjectId: (key.query.subjectId as string | undefined) ?? null,
      state: (key.query.state as 'open' | 'settled' | undefined) ?? null,
    };
    const complete = d.pages.at(-1)?.next == null;
    const pages = threadPagesSettled(
      d.pages.map((p) => p.threads),
      { rootId, settled, thread: known ?? null },
      scope,
      complete,
    );
    if (pages === null || was === undefined) stale = true;
    // A list asked by subject counts only the settled threads about it: one about something else leaves it alone, and
    // one it can't tell reads the list again.
    let counted = delta;
    if (counted !== 0 && (scope.subjectKind || scope.subjectId)) {
      if (!known) {
        stale = true;
        counted = 0;
      } else if (!threadAbout(scope, known)) counted = 0;
    }
    const next = pages ?? d.pages.map((p) => p.threads);
    const same = next.every((p, i) => p === d.pages[i]?.threads);
    if (same && counted === 0) return d;
    return {
      ...d,
      pages: d.pages.map((p, i) => {
        const threads = next[i] ?? [];
        const page = threads === p.threads ? p : { ...p, threads };
        return i === 0 ? withSettledCount(page, counted) : page;
      }),
    };
  });
  if (stale) void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.threads') });
}

/**
 * A message in every cached Threads list (Whombat chat-channel.md CHT-07; app chat-channel.md AP-2408): a new top-level
 * message of a room starts its thread at the top, a reply moves its thread up (`threadPagesWithMessage`); a reply to a
 * thread the list hasn't loaded reads that list again.
 */
function patchChatThreads(qc: QueryClient, m: Message): void {
  let room: ChatRoom | null | undefined;
  // Read only when a list has the message's thread (a partial bootstrap in a test has no principals).
  let principals: Map<string, { kind: string }> | undefined;
  const agent = (id: string) => {
    principals ??= cachedPrincipals(qc);
    return principals.get(id)?.kind === 'agent';
  };
  patchEndpoint<InfiniteData<ChatThreadsResponse>>(qc, 'chats.threads', (d, key) => {
    if (!key.infinite || !('pages' in d)) return d;
    if (room === undefined) room = cachedRoomOf(qc, m.conversationId);
    const known = d.pages.some((p) =>
      p.threads.some((t: ChatThread) => t.conversationId === m.conversationId),
    );
    const scope = {
      room: (key.query.room as ChatRoom | undefined) ?? 'chat',
      subjectKind: (key.query.subjectKind as string | undefined) ?? null,
      subjectId: (key.query.subjectId as string | undefined) ?? null,
      state: (key.query.state as 'open' | 'settled' | undefined) ?? null,
    };
    const pages = threadPagesWithMessage(
      d.pages.map((p) => p.threads),
      m,
      scope,
      room ?? (known ? scope.room : null),
      agent,
      d.pages.at(-1)?.next == null,
    );
    if (pages === null) {
      void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.threads') });
      return d;
    }
    if (pages.every((p, i) => p === d.pages[i]?.threads)) return d;
    return {
      ...d,
      pages: d.pages.map((p, i) => (p.threads === pages[i] ? p : { ...p, threads: pages[i] ?? [] })),
    };
  });
}

/**
 * Upsert a message into lists, its thread and single-message queries (also used optimistically), its conversation's
 * pins (a pin, an unpin, an edit of a pinned message; CT-174) and search results that show it (an edit's new words,
 * a tombstone leaving; CT-173).
 */
export function upsertMessageEverywhere(qc: QueryClient, m: Message): void {
  patchEndpoint<MessagePage | InfiniteData<MessagePage>>(
    qc,
    'messages.list',
    (data) => ('pages' in data ? reduceMessagePages(data, m) : reduceMessagePage(data, m)),
    { conversationId: m.conversationId },
  );
  patchEndpoint<ThreadView>(qc, 'messages.thread', (v) => reduceThread(v, m));
  patchEndpoint<{ message: Message }>(qc, 'messages.get', (d) =>
    d.message.id === m.id || (m.clientId !== null && d.message.clientId === m.clientId) ? { message: m } : d,
  );
  if (m.id.startsWith('msg_local-')) return;
  patchChatThreads(qc, m);
  patchEndpoint<{ messages: Message[] }>(qc, 'conversations.pins', (d, key) =>
    reducePins(d, m, key.params.conversationId),
  );
  if (m.deletedAt) removeSearchResultEverywhere(qc, m.id);
  else patchEndpoint<SearchResponse>(qc, 'search.query', (d) => reduceSearchResults(d, m));
}

/**
 * A message that is gone (`message.deleted`, or the viewer's own delete answered without a tombstone; CT-173): out of
 * its conversation's lists, its thread, the pins and search results; its own reads (`messages.get`, its thread when
 * it was a root) are dropped.
 */
export function removeMessageEverywhere(qc: QueryClient, conversationId: string, messageId: string): void {
  patchEndpoint<MessagePage | InfiniteData<MessagePage>>(
    qc,
    'messages.list',
    (data) =>
      'pages' in data
        ? mapPages(data, (p) => removeMessageFromPage(p, messageId))
        : removeMessageFromPage(data, messageId),
    { conversationId },
  );
  patchEndpoint<ThreadView>(qc, 'messages.thread', (v) => removeFromThread(v, messageId));
  patchEndpoint<InfiniteData<ChatThreadsResponse>>(qc, 'chats.threads', (d) => {
    const pages = threadPagesWithout(
      d.pages.map((p) => p.threads),
      messageId,
    );
    return pages
      ? {
          ...d,
          pages: d.pages.map((p, i) => (p.threads === pages[i] ? p : { ...p, threads: pages[i] ?? [] })),
        }
      : d;
  });
  patchEndpoint<{ messages: Message[] }>(qc, 'conversations.pins', (d) => removeFromPins(d, messageId), {
    conversationId,
  });
  removeSearchResultEverywhere(qc, messageId);
  qc.removeQueries({ queryKey: queryKeys.scope('messages.get', { messageId }) });
  qc.removeQueries({ queryKey: queryKeys.scope('messages.thread', { messageId }) });
}

/**
 * A message's search result leaving every cached search that shows it (CT-173; whombat-app SRP-14). The pages of one
 * search — the same query but for `cursor` — share its chip counts (the apps show the first page's), so the counts go
 * down once, on every page of that search, whichever page held the result; a search that didn't show it is left alone.
 */
export function removeSearchResultEverywhere(qc: QueryClient, messageId: string): void {
  const pages = endpointQueries(qc, 'search.query').flatMap((query) => {
    const data = query.state.data as SearchResponse | undefined;
    const key = parseKey(query.queryKey);
    if (!data || !key) return [];
    const { cursor: _cursor, ...rest } = key.query;
    return [{ queryKey: query.queryKey, data, search: JSON.stringify([key.params, rest]) }];
  });
  const hits = new Map<string, SearchResult>();
  for (const p of pages) {
    const hit = searchResultOf(p.data, messageId);
    if (hit) hits.set(p.search, hit);
  }
  for (const p of pages) {
    const hit = hits.get(p.search);
    if (hit) putQueryData(qc, p.queryKey, withoutSearchResult(p.data, hit));
  }
}

/** Remove messages carrying a client id (except `keepId`, the confirmed server copy). */
export function removeOptimisticMessage(
  qc: QueryClient,
  conversationId: string,
  clientId: string,
  keepId?: string,
): void {
  const drop = (list: readonly Message[]) =>
    removeWhere(list, (m) => m.clientId === clientId && m.id !== keepId);
  patchEndpoint<MessagePage | InfiniteData<MessagePage>>(
    qc,
    'messages.list',
    (data) =>
      'pages' in data
        ? mapPages(data, (p) => {
            const messages = drop(p.messages);
            return messages === p.messages ? p : { ...p, messages };
          })
        : (() => {
            const messages = drop(data.messages);
            return messages === data.messages ? data : { ...data, messages };
          })(),
    { conversationId },
  );
  patchEndpoint<ThreadView>(qc, 'messages.thread', (v) => {
    const replies = drop(v.replies);
    return replies === v.replies ? v : { ...v, replies };
  });
}

/** Map every cached message (lists, threads, single messages). */
export function patchMessages(ctx: { qc: QueryClient }, fn: (m: Message) => Message): void {
  for (const id of ['messages.list', 'messages.thread', 'messages.get']) {
    patchEndpoint<unknown>(ctx.qc, id, (d) => mapMessagesIn(d, fn));
  }
}

/** Put an approval's new state everywhere it shows (also used optimistically). */
export function applyApproval(qc: QueryClient, approval: Approval): void {
  patchEndpoint<ApprovalResponse>(qc, 'approvals.get', (d) =>
    d.approval.id === approval.id ? { ...d, approval } : d,
  );
  patchEndpoint<{ approvals: Approval[] } | InfiniteData<{ approvals: Approval[] }>>(
    qc,
    'approvals.list',
    (d, key) => {
      if (!sameBurrow(qc, key, approval.burrowId)) return d;
      const reduce = <P extends { approvals: Approval[] }>(p: P): P => {
        const approvals = reduceApprovalList(p.approvals, approval, key.query.state);
        return approvals === p.approvals ? p : { ...p, approvals };
      };
      if ('pages' in d) {
        const hit = d.pages.findIndex((p) => p.approvals.some((a) => a.id === approval.id));
        return mapPages(d, (p, i) => (i === (hit >= 0 ? hit : 0) ? reduce(p) : p));
      }
      return reduce(d);
    },
  );
  patchMessages({ qc }, (m) => patchCard(m, cardPatchers.approval(approval)));
  patchEndpoint<PullRequestDetail>(qc, 'prs.get', (d) =>
    d.staging?.id === approval.id ? { ...d, staging: approval } : d,
  );
  patchEndpoint<InboxResponse>(qc, 'notifications.inbox', (d) => patchInboxApproval(d, approval));
  const patchEvents = (events: AuditEvent[]) => mapList(events, (e) => patchAuditApproval(e, approval));
  patchEndpoint<AuditPage | InfiniteData<AuditPage>>(qc, 'audit.list', (d) => {
    const patchPage = (p: AuditPage) => {
      const events = patchEvents(p.events);
      return events === p.events ? p : { ...p, events };
    };
    return 'pages' in d ? mapPages(d, patchPage) : patchPage(d);
  });
  patchEndpoint<{ event: AuditEvent }>(qc, 'audit.get', (d) => {
    const event = patchAuditApproval(d.event, approval);
    return event === d.event ? d : { event };
  });
}

/**
 * The agent's latest action in its conversation and thread (AP-734): one entry per agent and thread, replaced by a
 * newer action; a new turn (dispatch) starts the clock again.
 */
function setAgentNow(qc: QueryClient, activity: Activity): void {
  const key = queryKeys.agentNow(activity.conversationId);
  const prev = qc.getQueryData(key) ?? [];
  const at = Date.parse(activity.updatedAt);
  const started = Date.parse(activity.startedAt);
  if (!Number.isFinite(at) || !Number.isFinite(started)) return;
  const same = (e: AgentNowEntry) =>
    e.principalId === activity.agentId && e.threadRootId === activity.threadRootId;
  const old = prev.find(same);
  const sameTurn = old?.dispatchId === activity.dispatchId;
  // In any order of arrival the same entry: the newest action (by time, then sequence) says what it does, and the
  // turn's clock starts at its earliest action.
  const newer =
    !old ||
    at > old.at ||
    (at === old.at && (activity.seq > old.seq || (!sameTurn && activity.dispatchId > old.dispatchId)));
  const since = sameTurn ? Math.min(old.since, started) : started;
  let entry: AgentNowEntry;
  if (newer)
    entry = {
      principalId: activity.agentId,
      threadRootId: activity.threadRootId,
      dispatchId: activity.dispatchId,
      title: activity.title,
      status: activity.status,
      seq: activity.seq,
      since,
      at,
    };
  else if (sameTurn && since < old.since) entry = { ...old, since };
  else return;
  const order = (e: AgentNowEntry) => `${e.principalId}:${e.threadRootId ?? ''}`;
  qc.setQueryData(
    key,
    [...prev.filter((e) => !same(e)), entry].sort((a, b) => (order(a) < order(b) ? -1 : 1)),
  );
}

function setTyping(
  ctx: Ctx,
  conversationId: string,
  principalId: string,
  threadRootId: string | null,
  entry: TypingEntry | null,
): void {
  const key = queryKeys.typing(conversationId);
  const prev = ctx.qc.getQueryData(key);
  const now = ctx.state.now();
  const kept = (prev ?? []).filter(
    (t) => t.expiresAt > now && !(t.principalId === principalId && t.threadRootId === threadRootId),
  );
  const next = entry ? [...kept, entry] : kept;
  if (!prev && next.length === 0) return;
  ctx.qc.setQueryData(key, next);
}

function patchSummary<S extends ConversationSummary>(s: S, c: Conversation): S {
  if (s.title === c.title && s.slug === c.slug && s.lastMessageAt === c.lastMessageAt) {
    return s;
  }
  return {
    ...s,
    title: c.title,
    slug: c.slug,
    lastMessageAt: c.lastMessageAt,
  };
}

function newSummary(c: Conversation): ConversationSummary {
  return {
    id: c.id,
    kind: c.kind,
    slug: c.slug,
    title: c.title,
    link: conversationLink(c),
    unread: 0,
    mentions: 0,
    prNumber: c.prNumber,
    lastMessageAt: c.lastMessageAt,
  };
}

function conversationTitleOf(qc: QueryClient, conversationId: string | null): string | null {
  if (!conversationId) return null;
  for (const { data } of cachedData<Bootstrap>(qc, 'conversations.bootstrap')) {
    const s = sidebarSummaries(data.sidebar).find((x) => x.id === conversationId);
    if (s) return conversationLabel(s);
  }
  return null;
}
