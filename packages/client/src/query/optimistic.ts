/**
 * Optimistic cache updates for the mutations people expect to feel instant: sending a message,
 * reacting, deciding and undoing an approval. Each returns what its rollback needs. The React
 * mutation hooks (`@whombat/client/react`) wire these into `useMutation`.
 */
import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/query-core';
import type {
  Approval,
  ApprovalResponse,
  CommandScope,
  InboxResponse,
  Message,
  MessagePage,
  Reaction,
} from '@whombat/core';
import { alwaysAllowRow } from '@whombat/core';
import { answeredGuideCard, type GuideActInput } from '../guides';
import { applyApproval, patchMessages, removeOptimisticMessage, upsertMessageEverywhere } from './apply';
import { cachedData, endpointQueries, putQueryData } from './cache';
import { mapList, toggleReaction } from './reducers';

/** Id prefix of messages that exist only on this device until the server confirms them. */
export const OPTIMISTIC_PREFIX = 'msg_local-';

export function isOptimisticMessage(m: Pick<Message, 'id'>): boolean {
  return m.id.startsWith(OPTIMISTIC_PREFIX);
}

/** A client id for `SendMessageBody.clientId` (unique enough per device, no crypto needed). */
export function newClientId(now: () => number = Date.now): string {
  return `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface OptimisticMessageInput {
  conversationId: string;
  authorId: string;
  text: string;
  clientId: string;
  threadRootId?: string | null;
  mentions?: string[];
  createdAt?: string;
}

export function optimisticMessage(input: OptimisticMessageInput): Message {
  return {
    id: `${OPTIMISTIC_PREFIX}${input.clientId}`,
    conversationId: input.conversationId,
    authorId: input.authorId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    editedAt: null,
    text: input.text.trim(),
    mentions: input.mentions ?? [],
    card: null,
    suggestions: [],
    more: null,
    attachments: [],
    reactions: [],
    threadRootId: input.threadRootId ?? null,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: input.clientId,
  };
}

/** Show the message right away. */
export function addOptimisticMessage(qc: QueryClient, input: OptimisticMessageInput): Message {
  const m = optimisticMessage(input);
  upsertMessageEverywhere(qc, m);
  return m;
}

/** Server accepted: its message replaces the optimistic one (matched by `clientId`). */
export function confirmOptimisticMessage(qc: QueryClient, clientId: string, message: Message): void {
  upsertMessageEverywhere(qc, { ...message, clientId: message.clientId ?? clientId });
  removeOptimisticMessage(qc, message.conversationId, clientId, message.id);
}

/** Sending failed, was blocked or needs approval: take the optimistic message back out. */
export function rollbackOptimisticMessage(qc: QueryClient, conversationId: string, clientId: string): void {
  removeOptimisticMessage(qc, conversationId, clientId);
}

/* Snapshots -------------------------------------------------------------------------------------- */

export type Snapshot = [QueryKey, unknown][];

/** Current data of every cached call of the given endpoints. */
export function snapshot(qc: QueryClient, endpointIds: readonly string[]): Snapshot {
  return endpointIds.flatMap((id) =>
    endpointQueries(qc, id).map((q) => [q.queryKey, q.state.data] as [QueryKey, unknown]),
  );
}

export function restore(qc: QueryClient, snap: Snapshot): void {
  for (const [key, data] of snap) putQueryData(qc, key, data);
}

/**
 * Invalidate every query a snapshot touched. `restore()` sets each cached entry back to its
 * pre-mutation value, which can overwrite a realtime update that arrived while the
 * mutation was in flight (e.g. `approval.updated` landing before a failed `undo`). Invalidating every
 * snapshotted key (not just the mutation's own entity) forces a refetch of server truth for everything
 * the rollback touched, so a mounted screen recovers instead of being stuck on the stale value `restore`
 * just wrote back. `exact: true` because a snapshot key is a specific cached call, not a scope prefix.
 */
export function invalidateSnapshot(qc: QueryClient, snap: Snapshot): void {
  for (const [key] of snap) void qc.invalidateQueries({ queryKey: key, exact: true });
}

const MESSAGE_ENDPOINTS = ['messages.list', 'messages.thread', 'messages.get'] as const;
const APPROVAL_ENDPOINTS = [
  'approvals.get',
  'approvals.list',
  ...MESSAGE_ENDPOINTS,
  'prs.get',
  'notifications.inbox',
  'audit.list',
  'audit.get',
] as const;

/* Reactions -------------------------------------------------------------------------------------- */

/** The conversation a cached message belongs to, so a reaction can scope its cancel/invalidate to it. */
export function findMessageConversationId(qc: QueryClient, messageId: string): string | null {
  for (const id of MESSAGE_ENDPOINTS) {
    for (const { data } of cachedData<unknown>(qc, id)) {
      const hit = findMessageIn(data, messageId);
      if (hit) return hit.conversationId;
    }
  }
  return null;
}

function findMessageIn(data: unknown, messageId: string): Message | null {
  const d = data as Partial<
    MessagePage & InfiniteData<MessagePage> & { root: Message; replies: Message[]; message: Message }
  >;
  const lists: Message[] = [
    ...(d.pages?.flatMap((p) => p.messages) ?? []),
    ...(d.messages ?? []),
    ...(d.root ? [d.root] : []),
    ...(d.replies ?? []),
    ...(d.message ? [d.message] : []),
  ];
  return lists.find((m) => m.id === messageId) ?? null;
}

export function applyReactionToggle(
  qc: QueryClient,
  messageId: string,
  value: string,
  on: boolean,
  me: string,
): Snapshot {
  const snap = snapshot(qc, MESSAGE_ENDPOINTS);
  patchMessages({ qc }, (m) => {
    if (m.id !== messageId) return m;
    const reactions = toggleReaction(m.reactions, value, on, me);
    return reactions === m.reactions ? m : { ...m, reactions };
  });
  return snap;
}

export function setMessageReactions(qc: QueryClient, messageId: string, reactions: Reaction[]): void {
  patchMessages({ qc }, (m) => (m.id === messageId ? { ...m, reactions } : m));
}

/* Approvals -------------------------------------------------------------------------------------- */

/** The cached approval with this number (modal, list, cards or inbox). */
export function findCachedApproval(qc: QueryClient, number: number): Approval | null {
  for (const { data } of cachedData<ApprovalResponse>(qc, 'approvals.get')) {
    if (data.approval.number === number) return data.approval;
  }
  for (const { data } of cachedData<{ approvals: Approval[] } | InfiniteData<{ approvals: Approval[] }>>(
    qc,
    'approvals.list',
  )) {
    const pages = 'pages' in data ? data.pages : [data];
    for (const p of pages) {
      const hit = p.approvals.find((a) => a.number === number);
      if (hit) return hit;
    }
  }
  for (const id of MESSAGE_ENDPOINTS) {
    for (const { data } of cachedData<unknown>(qc, id)) {
      const hit = findInMessages(data, number);
      if (hit) return hit;
    }
  }
  for (const { data } of cachedData<InboxResponse>(qc, 'notifications.inbox')) {
    for (const s of data.sections) {
      const hit = s.items.find((i) => i.approval?.number === number)?.approval;
      if (hit) return hit;
    }
  }
  return null;
}

function findInMessages(data: unknown, number: number): Approval | null {
  const d = data as Partial<
    MessagePage & InfiniteData<MessagePage> & { root: Message; replies: Message[]; message: Message }
  >;
  const lists: Message[] = [
    ...(d.pages?.flatMap((p) => p.messages) ?? []),
    ...(d.messages ?? []),
    ...(d.root ? [d.root] : []),
    ...(d.replies ?? []),
    ...(d.message ? [d.message] : []),
  ];
  for (const m of lists)
    if (m.card?.kind === 'approval' && m.card.approval.number === number) return m.card.approval;
  return null;
}

export type ApprovalDecision = 'approve' | 'decline' | 'undo';

/** The approval as it will look once decided (or undone). */
export function decidedApproval(
  a: Approval,
  decision: ApprovalDecision,
  me: string,
  at: string,
  scope?: CommandScope,
): Approval {
  const state = decision === 'approve' ? 'approved' : decision === 'decline' ? 'declined' : 'pending';
  const met = state === 'approved';
  const conditions = mapList(a.conditions, (c) =>
    c.kind === 'person_approves' && c.met !== met ? { ...c, met } : c,
  );
  if (state === 'pending') return { ...a, state, decidedById: null, decidedAt: null, conditions };
  // A yes to a command carries how far it goes (AC-42; absent = once), so the card says “Allowed for this task.” at once;
  // “Always allow” on a risk row too (RA-06), so it ends “From now on Neo may deploy without asking.” at once.
  const scoped =
    state !== 'approved'
      ? {}
      : a.action.type === 'run_command'
        ? { scope: scope ?? ('once' as const) }
        : scope === 'agent' && alwaysAllowRow(a.action)
          ? { scope: 'agent' as const }
          : {};
  return { ...a, state, decidedById: me, decidedAt: at, conditions, ...scoped };
}

/** Show the decision everywhere; returns the snapshot to roll back to (null when the approval is not cached). */
export function applyOptimisticDecision(
  qc: QueryClient,
  number: number,
  decision: ApprovalDecision,
  me: string,
  at: string = new Date().toISOString(),
  scope?: CommandScope,
): Snapshot | null {
  const current = findCachedApproval(qc, number);
  if (!current) return null;
  const snap = snapshot(qc, APPROVAL_ENDPOINTS);
  applyApproval(qc, decidedApproval(current, decision, me, at, scope));
  return snap;
}

/* Pins (contracts CT-174) ------------------------------------------------------------------------ */

/**
 * Pin or unpin a message at once: its marker, the conversation's “Pinned · N” and the pins pane follow before the
 * server answers. Returns the snapshot to roll back to, or null when the message isn't cached.
 */
export function applyOptimisticPin(
  qc: QueryClient,
  messageId: string,
  pinned: boolean,
  me: string | null,
  at: string = new Date().toISOString(),
): Snapshot | null {
  const message = findCachedMessage(qc, messageId);
  if (!message) return null;
  const snap = snapshot(qc, [...MESSAGE_ENDPOINTS, 'conversations.pins']);
  upsertMessageEverywhere(qc, {
    ...message,
    pinnedAt: pinned ? (message.pinnedAt ?? at) : null,
    pinnedById: pinned ? (message.pinnedById ?? me) : null,
  });
  return snap;
}

/* Guide cards (docs/decisions/assistant-guides.md AG-03) ---------------------------------------------------------- */

/** The cached message with this id (lists, threads, single reads). */
export function findCachedMessage(qc: QueryClient, messageId: string): Message | null {
  for (const id of MESSAGE_ENDPOINTS) {
    for (const { data } of cachedData<unknown>(qc, id)) {
      const hit = findMessageIn(data, messageId);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Lock a guide card at once with the answer (the server does the same and publishes `message.updated`); returns
 * the snapshot to roll back to, or null when the message isn't cached or its card isn't an open guide.
 */
export function applyOptimisticGuideAnswer(
  qc: QueryClient,
  messageId: string,
  input: GuideActInput,
  at: string = new Date().toISOString(),
): Snapshot | null {
  const message = findCachedMessage(qc, messageId);
  if (message?.card?.kind !== 'guide' || message.card.state !== 'open') return null;
  const card = answeredGuideCard(message.card, input, at);
  const snap = snapshot(qc, MESSAGE_ENDPOINTS);
  patchMessages({ qc }, (m) => (m.id === messageId ? { ...m, card } : m));
  return snap;
}
