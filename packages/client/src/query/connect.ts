/**
 * `connectRealtimeToQueryClient(realtime, queryClient)` — every realtime event is reduced into the
 * cache; reconnects and sequence gaps invalidate what the missed events could have touched.
 */
import type { QueryClient } from '@tanstack/query-core';
import { parseTopic, type TopicKind } from '@whombat/core';
import type { Realtime, ResyncSignal } from '../realtime/realtime';
import { applyRealtimeEvent, type CacheSyncState, cacheSyncState } from './apply';
import { parseKey, QUERY_ROOT, queryKeys } from './keys';

export interface ConnectOptions {
  /** Ordering state (defaults to the one shared by everything applied to this QueryClient). */
  state?: CacheSyncState;
  /** Called after an event was applied (or ignored as stale: `applied` false). */
  onApplied?: (info: { type: string; applied: boolean }) => void;
}

export function connectRealtimeToQueryClient(
  realtime: Realtime,
  queryClient: QueryClient,
  options: ConnectOptions = {},
): () => void {
  const state = options.state ?? cacheSyncState(queryClient);
  // Local realtime state has no queryFn and must survive having no observers for a while.
  queryClient.setQueryDefaults([QUERY_ROOT, 'typing'], { staleTime: Number.POSITIVE_INFINITY });

  const offEvent = realtime.onEvent((event, frame) => {
    const applied = applyRealtimeEvent(
      queryClient,
      event,
      { at: frame.at, topic: frame.topic, seq: frame.seq, burrowId: realtime.session()?.burrowId ?? null },
      state,
    );
    options.onApplied?.({ type: event.type, applied });
  });
  const offResync = realtime.onResync((signal) => invalidateForResync(queryClient, signal));
  return () => {
    offEvent();
    offResync();
  };
}

/**
 * Endpoints whose data events on each topic kind can change: what `applyRealtimeEvent` patches for the events
 * `REALTIME_EVENT_TOPICS` sends there. A missed `burrow` event (agents, people, the burrow, conversations' sidebar rows,
 * runs, approvals, plans, PRs, audit, automations, the AI gateway's pool) changes the sidebar and roster, the cards in
 * messages and those lists; never the session, the AI sign-ins, the Vault, settings or search (docs/decisions/
 * web-efficiency.md WE-04: a reconnect used to refetch every active query). Usage refetches since the gateway's pool
 * travels on the burrow topic (CT-332, AP-1122).
 */
export const TOPIC_ENDPOINTS: Record<TopicKind, readonly string[]> = {
  burrow: [
    // agent.updated, principal.created, person.updated, burrow.updated, conversation.updated, pr.updated
    'conversations.bootstrap',
    'conversations.list',
    'conversations.get',
    'agent.get',
    'burrows.get',
    'me.get',
    // run.updated, approval.updated, plan.updated patch the cards in messages, pins and search results
    'messages.list',
    'messages.thread',
    'messages.get',
    'conversations.pins',
    'search.query',
    'runs.get',
    'runs.list',
    'approvals.get',
    'approvals.list',
    'plans.get',
    'plans.list',
    'prs.get',
    'prs.list',
    'audit.get',
    'audit.list',
    'notifications.inbox',
    'automations.list',
    'automations.get',
    'automations.run',
    'automations.runs',
    'work.overview',
    'work.needsYou',
    // deployment.recorded (CT-296)
    'deployments.list',
    'deployments.environments',
    // conversation.updated: joining or leaving changes which Files the viewer sees (AP-776)
    'files.summary',
    'files.list',
    // usage.gateway_updated (CT-332): the AI gateway's pool in Settings → AI → Usage (AP-1122)
    'usage.list',
  ],
  conv: [
    'messages.thread',
    'messages.get',
    'plans.list',
    'plans.get',
    'activity.list',
    'work.overview',
    // A message with files sent or deleted moves the conversation's Files (AP-776).
    'files.list',
    // `conversation.handoffs`: what the agent handed to T3 Code from here (app t3code-handoff.md).
    'conversations.handoffs',
    // A message moves its thread in the Threads lists, its room's row in Chat and Feedback, and the pins it is in.
    'chats.threads',
    'chats.list',
    'conversations.pins',
  ],
  run: ['runs.get', 'runs.log', 'activity.list', 'work.overview'],
  canvas: ['canvases.get', 'canvases.list'],
  me: [
    'notifications.inbox',
    'conversations.bootstrap',
    'conversations.list',
    'search.query',
    'search.getAnswer',
    'work.overview',
    'work.needsYou',
    // `files.changed` travels on `me` (CT-275): missed frames mean the summary and lists may be stale (AP-776).
    'files.summary',
    'files.list',
    // `home.changed` and `widget.updated` travel on `me` (contracts 0.80, CT-336).
    'home.overview',
    'watch.list',
    'widgets.list',
    'chats.list',
    // `desk.changed` travels on `me` (contracts 0.100; desk-display-web.md AP-3001): the screen, its pairing and request.
    'desk.get',
    'desk.screens',
    'desk.screen.get',
    // `voice.changed` travels on `me` (contracts 3.1): voice typing's settings and its models' downloads.
    'voice.get',
    // `chat.settled`, `chat.cleared`, `chat.placed`, `chat.thread_runtime` and `conversation.unread` travel on `me`: a
    // thread's first message, the Threads lists, which threads have something new and what answers a thread.
    'messages.list',
    'messages.thread',
    'chats.threads',
    'chats.unread',
    'chats.runtime',
  ],
  // The burrow's server events (contracts 0.80, CT-339): `hosts.server`, `hosts.guest`, `hosts.alert`, `hosts.task`,
  // `hosts.enrollment`, `hosts.resync`.
  hosts: [
    'hosts.fleet',
    'hosts.getServer',
    'hosts.listGuests',
    'hosts.getGuest',
    'hosts.listAlerts',
    'hosts.listEnrollments',
    'hosts.manageRead',
    'home.overview',
    'watch.list',
  ],
};

/** The open conversation's own reads, which its `conv` topic refetches for that conversation only. */
const CONVERSATION_READS: ReadonlySet<string> = new Set(['messages.list', 'conversations.get']);

/**
 * Invalidate what events missed on these topics could have changed; active queries refetch. One invalidation for all
 * of it: a query matched twice (the open conversation's messages by its `conv` topic and the `burrow` topic's list)
 * would be fetched twice, the second cancelling the first.
 */
export function invalidateForResync(qc: QueryClient, signal: ResyncSignal): void {
  const ids = new Set<string>();
  const conversations = new Set<string>();
  for (const topic of signal.topics) {
    const t = parseTopic(topic);
    if (!t) continue;
    for (const id of TOPIC_ENDPOINTS[t.kind]) ids.add(id);
    if (t.kind === 'conv') {
      conversations.add(t.id);
      qc.removeQueries({ queryKey: queryKeys.typing(t.id) });
    }
  }
  if (!ids.size && !conversations.size) return;
  void qc.invalidateQueries({
    predicate: (q) => {
      const key = parseKey(q.queryKey);
      if (!key) return false;
      if (ids.has(key.endpointId)) return true;
      const conversation = key.params.conversationId;
      return (
        CONVERSATION_READS.has(key.endpointId) &&
        typeof conversation === 'string' &&
        conversations.has(conversation)
      );
    },
  });
}
