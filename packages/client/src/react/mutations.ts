/**
 * Mutation hooks. Every mutation resolves to a `CommitResult` (`ok` / `pending_approval` / `blocked`)
 * so screens can show "Waiting for a person" or the key that was missing; only transport and
 * validation problems reject.
 *
 * Optimistic: sending a message, reactions, approval decide / undo. The optimistic change is rolled
 * back on errors and on `pending_approval` / `blocked` outcomes.
 */
import { type QueryKey, type UseMutationOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type ApprovalResponse,
  type Bootstrap,
  type ChatRuntime,
  type CommandScope,
  type ConversationKind,
  defaultNotifyLevel,
  type InboxResponse,
  type NotifyLevel,
  type Plan,
  type Reaction,
} from '@whombat/core';
import { type AnyEndpoint, api, type SendMessageResponse } from '@whombat/core/contracts';
import type { VaultEntryDetail } from '@whombat/core/vault';
import { useRef } from 'react';
import type { GuideActInput } from '../guides';
import type { CallInput, CommitResult, ResponseData } from '../http/types';
import {
  applyApproval,
  cacheSyncState,
  invalidateVault,
  removeMessageEverywhere,
  setConversationNotify,
  setConversationUnread,
  upsertMessageEverywhere,
} from '../query/apply';
import { burrowIdForSlug, cachedMe, patchEndpoint } from '../query/cache';
import { markInboxReadAt } from '../query/inboxRead';
import { queryKeys } from '../query/keys';
import {
  addOptimisticMessage,
  applyOptimisticDecision,
  applyOptimisticGuideAnswer,
  applyOptimisticPin,
  applyReactionToggle,
  confirmOptimisticMessage,
  findMessageConversationId,
  invalidateSnapshot,
  newClientId,
  restore,
  rollbackOptimisticMessage,
  type Snapshot,
  setMessageReactions,
} from '../query/optimistic';
import { markInboxRead } from '../query/reducers';
import { applyPlan, invalidateWork } from '../query/supervision';
import { OutcomeUnknownError, wentThrough } from '../session/types';
import { useWhombat } from './context';

/** The request id of sending the message with this client id (≥ 16 characters, as the protocol wants). */
export function sendRequestId(clientId: string): string {
  return `msg_${clientId.replace(/[^A-Za-z0-9_-]/g, '')}`.padEnd(20, '0');
}

type MutationOptions<TResult, TVars, TContext = unknown> = Omit<
  UseMutationOptions<TResult, Error, TVars, TContext>,
  'mutationFn' | 'onMutate'
>;

/** A mutation for any endpoint: `mutate({ params, body })` resolves to its `CommitResult`. */
export function useApiMutation<E extends AnyEndpoint>(
  ep: E,
  options?: MutationOptions<CommitResult<ResponseData<E>>, CallInput<E>>,
) {
  const { client } = useWhombat();
  return useMutation<CommitResult<ResponseData<E>>, Error, CallInput<E>>({
    ...options,
    mutationFn: (input) => client.request(ep, input),
  });
}

/* Messages --------------------------------------------------------------------------------------- */

export interface SendMessageTarget {
  burrow: string;
  conversationId: string;
  /** Reply in this thread. */
  threadRootId?: string | null;
}

export interface SendMessageVariables {
  text: string;
  attachmentIds?: string[];
  /** Mentioned principal ids, for the optimistic copy's highlighting. */
  mentions?: string[];
  /** Reuse to retry idempotently; generated when omitted. */
  clientId?: string;
  /**
   * What answers the new thread (contracts 0.96.1, CT-469; Whombat chat-runtime.md CR-02; app chat-runtime.md AP-2684):
   * the Chat's top-level box's choice (`chatStartRuntime`), stored with the thread before its first turn. Omitted: the
   * agent's own. A retry with the same `clientId` repeats it.
   */
  runtime?: ChatRuntime;
}

/** Send a message or thread reply; it shows at once and is replaced by the server's copy. */
export function useSendMessage(
  target: SendMessageTarget,
  options?: MutationOptions<CommitResult<SendMessageResponse>, SendMessageVariables, { clientId: string }>,
) {
  const { client, commands } = useWhombat();
  const qc = useQueryClient();
  // One client id per mutate() call, stable across re-renders between onMutate and the request.
  const clientIds = useRef(new WeakMap<SendMessageVariables, string>()).current;
  // What each message's first send carried as `runtime`, so “Resend” (the same request) carries it too.
  const sentRuntime = useRef(new Map<string, ChatRuntime>()).current;
  const idFor = (v: SendMessageVariables) => {
    let id = v.clientId ?? clientIds.get(v);
    if (!id) {
      id = newClientId();
      clientIds.set(v, id);
    }
    return id;
  };
  const listScope = queryKeys.scope('messages.list', { conversationId: target.conversationId });
  return useMutation<CommitResult<SendMessageResponse>, Error, SendMessageVariables, { clientId: string }>({
    ...options,
    onMutate: async (v) => {
      const clientId = idFor(v);
      await qc.cancelQueries({ queryKey: listScope });
      const me = cachedMe(qc, burrowIdForSlug(qc, target.burrow));
      if (me) {
        addOptimisticMessage(qc, {
          conversationId: target.conversationId,
          threadRootId: target.threadRootId ?? null,
          authorId: me,
          text: v.text,
          clientId,
          mentions: v.mentions,
        });
      }
      return { clientId };
    },
    mutationFn: (v) => {
      const clientId = idFor(v);
      // The idempotency key is derived from the client id, so a retry of this message is the same request.
      const requestId = sendRequestId(clientId);
      const params = { burrow: target.burrow, conversationId: target.conversationId };
      if (v.runtime) sentRuntime.set(clientId, v.runtime);
      const runtime = v.runtime ?? sentRuntime.get(clientId);
      const body = {
        text: v.text,
        threadRootId: target.threadRootId ?? undefined,
        attachmentIds: v.attachmentIds,
        clientId,
        ...(runtime ? { runtime } : {}),
      };
      commands?.begin({
        requestId,
        endpoint: api.messages.send,
        input: { params, query: {}, body },
        label: 'Message',
      });
      return client.messages.send({
        params,
        body,
        requestId,
        onProgress: (phase) => commands?.progress(requestId, phase),
      });
    },
    onSuccess: (result, v, context, ctx) => {
      const clientId = context?.clientId ?? idFor(v);
      commands?.settle(sendRequestId(clientId), { ok: true });
      if (result.status === 'ok') confirmOptimisticMessage(qc, clientId, result.data.message);
      else rollbackOptimisticMessage(qc, target.conversationId, clientId);
      return options?.onSuccess?.(result, v, context, ctx);
    },
    onError: (error, v, context, ctx) => {
      const clientId = context?.clientId ?? idFor(v);
      commands?.settle(sendRequestId(clientId), { ok: false, error });
      // An ambiguous outcome keeps the message on screen (“Not confirmed yet”) instead of taking back what may
      // have been sent (MA-09), and one that went through without its answer (CT-195) stays until the list refetched
      // below shows the stored copy; anything else returns it to the composer as a draft.
      if (!(error instanceof OutcomeUnknownError) && !wentThrough(error))
        rollbackOptimisticMessage(qc, target.conversationId, clientId);
      return options?.onError?.(error, v, context, ctx);
    },
    onSettled: (result, error, v, context, ctx) => {
      // The cancel above reverts any resync fetch that was in flight for this conversation to a
      // permanently idle fetchStatus with nothing to retry it. Invalidate it once the mutation settles
      // so that fetch (and whatever it would have recovered, e.g. messages missed during a disconnect)
      // actually happens.
      void qc.invalidateQueries({ queryKey: listScope });
      return options?.onSettled?.(result, error, v, context, ctx);
    },
  });
}

export interface ReactionVariables {
  messageId: string;
  value: string;
  on: boolean;
}

/** Add or remove the viewer's reaction, shown at once. */
export function useReaction(
  burrow: string,
  options?: MutationOptions<
    CommitResult<{ reactions: Reaction[] }>,
    ReactionVariables,
    { snapshot: Snapshot; listScope: QueryKey }
  >,
) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<
    CommitResult<{ reactions: Reaction[] }>,
    Error,
    ReactionVariables,
    { snapshot: Snapshot; listScope: QueryKey }
  >({
    ...options,
    onMutate: async (v) => {
      // Scope the cancel to the reacted message's own conversation (falling back to every
      // conversation only when it isn't cached anywhere) instead of cancelling every conversation's
      // in-flight messages.list fetch, including a resync recovering messages missed during a
      // disconnect elsewhere.
      const conversationId = findMessageConversationId(qc, v.messageId);
      const listScope = queryKeys.scope('messages.list', conversationId ? { conversationId } : undefined);
      await qc.cancelQueries({ queryKey: listScope });
      const me = cachedMe(qc, burrowIdForSlug(qc, burrow));
      return { snapshot: me ? applyReactionToggle(qc, v.messageId, v.value, v.on, me) : [], listScope };
    },
    mutationFn: (v) =>
      client.messages.react({
        params: { burrow, messageId: v.messageId },
        body: { value: v.value, on: v.on },
      }),
    onSuccess: (result, v, context, ctx) => {
      if (result.status === 'ok') setMessageReactions(qc, v.messageId, result.data.reactions);
      else if (context) {
        restore(qc, context.snapshot);
        invalidateSnapshot(qc, context.snapshot);
      }
      return options?.onSuccess?.(result, v, context, ctx);
    },
    onError: (error, v, context, ctx) => {
      if (context) {
        restore(qc, context.snapshot);
        invalidateSnapshot(qc, context.snapshot);
      }
      return options?.onError?.(error, v, context, ctx);
    },
    onSettled: (result, error, v, context, ctx) => {
      // Recover whatever the cancel above reverted to a permanently idle fetchStatus (see
      // useSendMessage's onSettled for why this is needed).
      void qc.invalidateQueries({ queryKey: context?.listScope ?? queryKeys.scope('messages.list') });
      return options?.onSettled?.(result, error, v, context, ctx);
    },
  });
}

/**
 * “More detail” under an agent's short reply (docs/decisions/concise-replies.md): the button goes at once (the
 * server's copy, marked asked), and the agent's “is thinking” follows over realtime.
 */
export function useRequestMore(
  burrow: string,
  options?: MutationOptions<CommitResult<ResponseData<typeof api.messages.more>>, { messageId: string }>,
) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<ResponseData<typeof api.messages.more>>, Error, { messageId: string }>({
    ...options,
    mutationFn: (v) => client.request(api.messages.more, { params: { burrow, messageId: v.messageId } }),
    onSuccess: (result, v, context, ctx) => {
      if (result.status === 'ok') upsertMessageEverywhere(qc, result.data.message);
      return options?.onSuccess?.(result, v, context, ctx);
    },
  });
}

/* Editing, deleting and pinning messages (contracts CT-173, CT-174) ----------------------------------- */

export interface EditMessageVariables {
  messageId: string;
  text: string;
}

/**
 * Edit your own message's text (`messages.edit`). The row keeps its editor until the server answers (an edit is not
 * shown as done before it is), then the server's copy (`editedAt`, the new text) replaces it everywhere.
 */
export function useEditMessage(
  burrow: string,
  options?: MutationOptions<CommitResult<ResponseData<typeof api.messages.edit>>, EditMessageVariables>,
) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<ResponseData<typeof api.messages.edit>>, Error, EditMessageVariables>({
    ...options,
    mutationFn: (v) =>
      client.request(api.messages.edit, {
        params: { burrow, messageId: v.messageId },
        body: { text: v.text },
      }),
    onSuccess: (result, v, context, ctx) => {
      if (result.status === 'ok') upsertMessageEverywhere(qc, result.data.message);
      return options?.onSuccess?.(result, v, context, ctx);
    },
  });
}

export interface DeleteMessageVariables {
  messageId: string;
  conversationId: string;
}

/**
 * Delete a message (`messages.delete`): without replies it leaves every list, its thread and the pins at once (and a
 * late `message.updated` can't bring it back); a thread root with replies becomes the tombstone the server answers.
 */
export function useDeleteMessage(
  burrow: string,
  options?: MutationOptions<CommitResult<ResponseData<typeof api.messages.delete>>, DeleteMessageVariables>,
) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<ResponseData<typeof api.messages.delete>>, Error, DeleteMessageVariables>({
    ...options,
    mutationFn: (v) => client.request(api.messages.delete, { params: { burrow, messageId: v.messageId } }),
    onSuccess: (result, v, context, ctx) => {
      if (result.status === 'ok') {
        if (result.data.message) upsertMessageEverywhere(qc, result.data.message);
        else {
          cacheSyncState(qc).tombstones.add(v.messageId);
          removeMessageEverywhere(qc, v.conversationId, v.messageId);
        }
      }
      return options?.onSuccess?.(result, v, context, ctx);
    },
  });
}

export interface PinMessageVariables {
  messageId: string;
  pinned: boolean;
}

/** Pin or unpin a message (`messages.pin`), shown at once and rolled back when refused. */
export function usePinMessage(
  burrow: string,
  options?: MutationOptions<
    CommitResult<ResponseData<typeof api.messages.pin>>,
    PinMessageVariables,
    { snapshot: Snapshot | null }
  >,
) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const rollback = (snap: Snapshot | null | undefined) => {
    if (!snap) return;
    restore(qc, snap);
    invalidateSnapshot(qc, snap);
  };
  return useMutation<
    CommitResult<ResponseData<typeof api.messages.pin>>,
    Error,
    PinMessageVariables,
    { snapshot: Snapshot | null }
  >({
    ...options,
    onMutate: (v) => {
      const me = cachedMe(qc, burrowIdForSlug(qc, burrow));
      return { snapshot: applyOptimisticPin(qc, v.messageId, v.pinned, me) };
    },
    mutationFn: (v) =>
      client.request(api.messages.pin, {
        params: { burrow, messageId: v.messageId },
        body: { pinned: v.pinned },
      }),
    onSuccess: (result, v, context, ctx) => {
      if (result.status === 'ok') upsertMessageEverywhere(qc, result.data.message);
      else rollback(context?.snapshot);
      return options?.onSuccess?.(result, v, context, ctx);
    },
    onError: (error, v, context, ctx) => {
      rollback(context?.snapshot);
      return options?.onError?.(error, v, context, ctx);
    },
  });
}

/* Approvals -------------------------------------------------------------------------------------- */

export interface DecideVariables {
  number: number;
  decision: 'approve' | 'decline';
  note?: string;
  /**
   * How far a yes to a `run_command` goes (agent-computer.md AC-42, contracts CT-217): once, for this task, or always
   * for the agent. Only with `approve` of a `run_command`; absent = once.
   */
  scope?: CommandScope;
  /**
   * “Approve later” (contracts 0.80, CT-338; one-whombat.md ONE-10): run the approved action then (“Tonight at 03:00”).
   * Only with `approve`, and only where the Whombat has `shell.assistant` (an older one runs it at once).
   */
  executeAt?: string;
}

function useApprovalMutation<V extends { number: number }>(
  burrow: string,
  kind: (v: V) => 'approve' | 'decline' | 'undo',
  call: (v: V) => Promise<CommitResult<ApprovalResponse>>,
  options?: MutationOptions<CommitResult<ApprovalResponse>, V, { snapshot: Snapshot | null }>,
  scope?: (v: V) => CommandScope | undefined,
) {
  const qc = useQueryClient();
  const rollback = (snapshot: Snapshot | null | undefined) => {
    if (!snapshot) return;
    restore(qc, snapshot);
    // Invalidate every endpoint the snapshot touched (approvals, messages, PR, inbox, audit), not just
    // approvals.get: restore() can overwrite a realtime update (e.g. approval.updated, audit.appended)
    // that landed while the mutation was in flight, and those endpoints' own version guards won't
    // re-apply an event they already recorded as applied. Invalidating forces a refetch of server truth.
    invalidateSnapshot(qc, snapshot);
  };
  return useMutation<CommitResult<ApprovalResponse>, Error, V, { snapshot: Snapshot | null }>({
    ...options,
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: queryKeys.scope('approvals.get') });
      const me = cachedMe(qc, burrowIdForSlug(qc, burrow));
      return {
        snapshot: me ? applyOptimisticDecision(qc, v.number, kind(v), me, undefined, scope?.(v)) : null,
      };
    },
    mutationFn: call,
    onSuccess: (result, v, context, ctx) => {
      if (result.status === 'ok') {
        applyApproval(qc, result.data.approval);
        // “Always allow” changed the agent's keys (a risk row to On, RA-06) or its allowed commands (AC-42).
        if (scope?.(v) === 'agent')
          for (const id of ['agent.get', 'agent.commandAllowances'])
            void qc.invalidateQueries({ queryKey: queryKeys.scope(id) });
        // “Don’t ask again on The Titan” set the server to Never (Whombat server-asks.md SA-07): its page and the fleet.
        if (scope?.(v) === 'agent' && result.data.approval.action.type === 'connection_call')
          for (const id of ['hosts.serverSettings', 'hosts.getServer', 'hosts.fleet'])
            void qc.invalidateQueries({ queryKey: queryKeys.scope(id) });
      } else rollback(context?.snapshot);
      return options?.onSuccess?.(result, v, context, ctx);
    },
    onError: (error, v, context, ctx) => {
      rollback(context?.snapshot);
      return options?.onError?.(error, v, context, ctx);
    },
  });
}

/** Approve (in advance or now) or decline; the card, modal, inbox and plan step flip at once. */
export function useDecideApproval(
  burrow: string,
  options?: MutationOptions<CommitResult<ApprovalResponse>, DecideVariables, { snapshot: Snapshot | null }>,
) {
  const { client } = useWhombat();
  return useApprovalMutation<DecideVariables>(
    burrow,
    (v) => v.decision,
    (v) =>
      client.approvals.decide({
        params: { burrow, number: v.number },
        body: {
          decision: v.decision,
          note: v.note,
          ...(v.scope ? { scope: v.scope } : {}),
          ...(v.executeAt ? { executeAt: v.executeAt } : {}),
        },
      }),
    options,
    (v) => v.scope,
  );
}

/** Undo a decision (until the action has executed). */
export function useUndoApproval(
  burrow: string,
  options?: MutationOptions<
    CommitResult<ApprovalResponse>,
    { number: number },
    { snapshot: Snapshot | null }
  >,
) {
  const { client } = useWhombat();
  return useApprovalMutation<{ number: number }>(
    burrow,
    () => 'undo',
    (v) => client.approvals.undo({ params: { burrow, number: v.number } }),
    options,
  );
}

/* Guide cards (docs/decisions/assistant-guides.md AG-03) ----------------------------------------------------- */

export interface GuideActVariables extends GuideActInput {
  messageId: string;
}

/**
 * A secret as a mutation holds it: a one-shot box the request empties. TanStack keeps a mutation's variables in its
 * cache (and in `useMutation().variables`) for minutes after it settles, and `reset()` doesn't clear the cache's copy;
 * a secret must go with the request and nowhere else (CN-02, AG-03). Put the box in the variables, `take()` it in
 * `mutationFn`.
 */
export interface Sealed<T> {
  take(): T | undefined;
}

export function sealOnce<T>(value: T): Sealed<T> {
  let held: T | undefined = value;
  return {
    take() {
      const out = held;
      held = undefined;
      return out;
    },
  };
}

/** A form's values as the mutation holds them (`sealOnce`). */
export type SealedGuideValues = Sealed<Record<string, string>>;

/** What the mutation itself keeps: everything but the form's values, which ride sealed. */
export type GuideActMutationVariables = Omit<GuideActVariables, 'values'> & { sealed?: SealedGuideValues };

export function sealGuideValues(values: Record<string, string> | undefined): SealedGuideValues | undefined {
  return values ? sealOnce(values) : undefined;
}

/**
 * Act on a guide card: a button, a choice or a form. The card locks at once with the answer
 * (`applyOptimisticGuideAnswer`); the server locks it too, publishes `message.updated` and posts the next step.
 * Any failure restores the card and refetches what the snapshot touched, so a card another tab already answered
 * (`guide_closed`) shows as the server has it. Form values are sent and never cached: `mutate` seals them, the
 * request takes them out.
 */
export function useGuideAct(
  burrow: string,
  options?: MutationOptions<
    CommitResult<ResponseData<typeof api.guides.act>>,
    GuideActMutationVariables,
    { snapshot: Snapshot | null }
  >,
) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const settle = (snap: Snapshot | null | undefined) => {
    if (!snap) return;
    restore(qc, snap);
    invalidateSnapshot(qc, snap);
  };
  const mutation = useMutation<
    CommitResult<ResponseData<typeof api.guides.act>>,
    Error,
    GuideActMutationVariables,
    { snapshot: Snapshot | null }
  >({
    ...options,
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: queryKeys.scope('messages.list') });
      const { messageId, sealed: _sealed, ...input } = v;
      return { snapshot: applyOptimisticGuideAnswer(qc, messageId, input) };
    },
    mutationFn: ({ messageId, actionId, optionIds, sealed }) => {
      const values = sealed?.take();
      return client.request(api.guides.act, {
        params: { burrow, messageId },
        body: { actionId, ...(optionIds?.length ? { optionIds } : {}), ...(values ? { values } : {}) },
      });
    },
    onSuccess: (result, v, context, ctx) => {
      if (result.status !== 'ok') settle(context?.snapshot);
      // The server's own answer (“Client ID 1234… saved”) and the next step replace the optimistic copy.
      else if (context?.snapshot) invalidateSnapshot(qc, context.snapshot);
      return options?.onSuccess?.(result, v, context, ctx);
    },
    onError: (error, v, context, ctx) => {
      settle(context?.snapshot);
      return options?.onError?.(error, v, context, ctx);
    },
  });
  const seal = ({ values, ...rest }: GuideActVariables): GuideActMutationVariables => {
    const sealed = sealGuideValues(values);
    return sealed ? { ...rest, sealed } : rest;
  };
  return {
    ...mutation,
    mutate: (v: GuideActVariables, opts?: Parameters<typeof mutation.mutate>[1]) =>
      mutation.mutate(seal(v), opts),
    mutateAsync: (v: GuideActVariables, opts?: Parameters<typeof mutation.mutateAsync>[1]) =>
      mutation.mutateAsync(seal(v), opts),
  };
}

/* Read state ------------------------------------------------------------------------------------- */

/** Mark a conversation read up to a message; the sidebar badge clears at once. */
export function useMarkRead(
  burrow: string,
  options?: MutationOptions<
    CommitResult<ResponseData<typeof api.conversations.markRead>>,
    { conversationId: string; messageId: string }
  >,
) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const readInbox = useReadInboxAt(burrow);
  return useMutation<
    CommitResult<ResponseData<typeof api.conversations.markRead>>,
    Error,
    { conversationId: string; messageId: string }
  >({
    ...options,
    onMutate: (v) => {
      setConversationUnread(qc, v.conversationId, 0, 0);
      // Its top level's mentions, direct messages and replies leave the inbox, on every device (AP-704).
      readInbox(v.conversationId, null);
    },
    mutationFn: (v) =>
      client.conversations.markRead({
        params: { burrow, conversationId: v.conversationId },
        body: { messageId: v.messageId },
      }),
    onSuccess: (result, v, context, ctx) => {
      if (result.status === 'ok')
        setConversationUnread(qc, v.conversationId, result.data.unread, result.data.mentions);
      return options?.onSuccess?.(result, v, context, ctx);
    },
    onError: (error, v, context, ctx) => {
      void qc.invalidateQueries({ queryKey: queryKeys.scope('conversations.bootstrap') });
      return options?.onError?.(error, v, context, ctx);
    },
  });
}

/**
 * Where the viewer read (a conversation's top level, or a thread, `threadRootId`): the inbox rows about it are read at
 * once in the cache and on the server, so other devices agree (AP-704). Nothing is sent when no cached row matches.
 */
export function useReadInboxAt(
  burrow: string,
): (conversationId: string, threadRootId: string | null) => void {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return (conversationId, threadRootId) => {
    const ids = markInboxReadAt(qc, conversationId, threadRootId, new Date().toISOString(), burrow);
    if (ids.length === 0) return;
    client.notifications.markRead({ params: { burrow }, body: { ids: ids.slice(0, 200) } }).then(
      (result) => {
        if (result.status !== 'ok') return;
        patchEndpoint<InboxResponse>(
          qc,
          'notifications.inbox',
          (d) => (d.unread === result.data.unread ? d : { ...d, unread: result.data.unread }),
          { burrow },
        );
      },
      () => void qc.invalidateQueries({ queryKey: queryKeys.scope('notifications.inbox') }),
    );
  };
}

/* Conversations (essentials, contracts 0.26) ------------------------------------------------------ */

export interface SetNotifyVariables {
  conversationId: string;
  /** The conversation's kind: a `null` level shows its default at once (`defaultNotifyLevel`). */
  kind: ConversationKind;
  /** A level, or null for the kind's default (CT-175). */
  notify: NotifyLevel | null;
}

/**
 * The viewer's notification level for a conversation (the header's bell, the sidebar's Mute; AP-469): the sidebar and
 * the bell show it at once, the server's answer confirms it, a failure puts the cached state back by refetching.
 */
export function useSetNotify(
  burrow: string,
  options?: MutationOptions<
    CommitResult<ResponseData<typeof api.conversations.setNotify>>,
    SetNotifyVariables
  >,
) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<
    CommitResult<ResponseData<typeof api.conversations.setNotify>>,
    Error,
    SetNotifyVariables
  >({
    ...options,
    onMutate: (v) => setConversationNotify(qc, v.conversationId, v.notify ?? defaultNotifyLevel(v.kind)),
    mutationFn: (v) =>
      client.request(api.conversations.setNotify, {
        params: { burrow, conversationId: v.conversationId },
        body: { notify: v.notify },
      }),
    onSuccess: (result, v, context, ctx) => {
      if (result.status === 'ok') setConversationNotify(qc, v.conversationId, result.data.notify);
      return options?.onSuccess?.(result, v, context, ctx);
    },
    onError: (error, v, context, ctx) => {
      for (const id of ['conversations.bootstrap', 'conversations.get', 'conversations.getChannel'])
        void qc.invalidateQueries({ queryKey: queryKeys.scope(id) });
      return options?.onError?.(error, v, context, ctx);
    },
  });
}

/* Notifications ---------------------------------------------------------------------------------- */

export type MarkNotificationsReadVariables = { ids: string[] } | { all: true };

/** Mark inbox rows read as they are opened (or all of them); the inbox's unread count drops at once. */
export function useMarkNotificationsRead(
  burrow: string,
  options?: MutationOptions<
    CommitResult<ResponseData<typeof api.notifications.markRead>>,
    MarkNotificationsReadVariables
  >,
) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const mark = (v: MarkNotificationsReadVariables, unread?: number) =>
    patchEndpoint<InboxResponse>(
      qc,
      'notifications.inbox',
      (d) => markInboxRead(d, 'all' in v ? 'all' : v.ids, new Date().toISOString(), unread),
      { burrow },
    );
  return useMutation<
    CommitResult<ResponseData<typeof api.notifications.markRead>>,
    Error,
    MarkNotificationsReadVariables
  >({
    ...options,
    onMutate: (v) => mark(v),
    mutationFn: (v) => client.notifications.markRead({ params: { burrow }, body: v }),
    onSuccess: (result, v, context, ctx) => {
      if (result.status === 'ok') mark(v, result.data.unread);
      return options?.onSuccess?.(result, v, context, ctx);
    },
    onError: (error, v, context, ctx) => {
      void qc.invalidateQueries({ queryKey: queryKeys.scope('notifications.inbox') });
      return options?.onError?.(error, v, context, ctx);
    },
  });
}

/* The agent (Settings → Agent; Whombat one-agent.md OA-09) ------------------------------------------- */

/** Settings → Agent → Keys: replaces the agent's grants; its profile refreshes. */
export function useSetAgentKeys(
  burrow: string,
  options?: MutationOptions<
    CommitResult<ResponseData<typeof api.agent.setKeys>>,
    CallInput<typeof api.agent.setKeys>
  >,
) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<
    CommitResult<ResponseData<typeof api.agent.setKeys>>,
    Error,
    CallInput<typeof api.agent.setKeys>
  >({
    ...options,
    mutationFn: (input) => client.agent.setKeys(input),
    onSuccess: (result, v, context, ctx) => {
      if (result.status === 'ok') {
        void qc.invalidateQueries({ queryKey: queryKeys.scope('agent.get', { burrow }) });
      }
      return options?.onSuccess?.(result, v, context, ctx);
    },
  });
}

/**
 * Settings → Agent: its name, face (`agent.update`) and which AI provider runs its turns (with fast replies since
 * contracts 0.96: `modelRuntimeBody`, `chatDefaultBody`); its profile refreshes, and Chat's default with a new runtime.
 */
export function useSetAgentModel(
  burrow: string,
  options?: MutationOptions<
    CommitResult<ResponseData<typeof api.agent.update>>,
    CallInput<typeof api.agent.update>
  >,
) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<
    CommitResult<ResponseData<typeof api.agent.update>>,
    Error,
    CallInput<typeof api.agent.update>
  >({
    ...options,
    mutationFn: (input) => client.request(api.agent.update, input),
    onSuccess: (result, v, context, ctx) => {
      if (result.status === 'ok') {
        // The answer is the agent as saved: its name and face show everywhere at once (assistant-name-web.md AP-1507),
        // without waiting for `agent.updated`.
        const saved = result.data.agent;
        patchEndpoint<Bootstrap>(qc, 'conversations.bootstrap', (d) =>
          d.principals.some((p) => p.id === saved.id)
            ? { ...d, principals: d.principals.map((p) => (p.id === saved.id ? saved : p)) }
            : d,
        );
        void qc.invalidateQueries({ queryKey: queryKeys.scope('agent.get', { burrow }) });
        // The agent's own runtime is Chat's default (chat-runtime.md CR-02, AP-2683): the popover reads it again.
        if (v.body?.runtime) void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.runtime') });
      }
      return options?.onSuccess?.(result, v, context, ctx);
    },
  });
}

/** “Check again” on the AI provider panel: the runner re-checks Claude Code and ChatGPT; the status refreshes. */
export function useRecheckAgentSetup(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<ResponseData<typeof api.host.recheckAgents>>, Error, void>({
    mutationFn: () => client.request(api.host.recheckAgents, { params: { burrow } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.scope('host.agents', { burrow }) });
    },
  });
}

/* Connectors (docs/decisions/connectors.md) ------------------------------------------------------ */

/** Settings → Connections: the app writes answer the new status; the rest refresh it. */
function useConnectorMutation<E extends AnyEndpoint>(ep: E) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<ResponseData<E>>, Error, CallInput<E>>({
    mutationFn: (input) => client.request(ep, input),
    onSuccess: (result) => {
      if (result.status !== 'ok') return;
      if (ep.id === api.connectors.setGoogleApp.id || ep.id === api.connectors.removeGoogleApp.id)
        qc.setQueryData(
          queryKeys.connectors.status(),
          result.data as ResponseData<typeof api.connectors.status>,
        );
      else void qc.invalidateQueries({ queryKey: queryKeys.scope(api.connectors.status) });
    },
  });
}

/** Save or replace the Google OAuth client (step 5 of the setup). */
export const useSetMicrosoftApp = () => useConnectorMutation(api.connectors.setMicrosoftApp);
export const useRemoveMicrosoftApp = () => useConnectorMutation(api.connectors.removeMicrosoftApp);
export const useStartMicrosoftConnection = () => useConnectorMutation(api.connections.startMicrosoft);
export const useSetGoogleApp = () => useConnectorMutation(api.connectors.setGoogleApp);
/** Remove the Google OAuth client. */
export const useRemoveGoogleApp = () => useConnectorMutation(api.connectors.removeGoogleApp);
/** “Check again” on a connection. */
export const useCheckConnection = () => useConnectorMutation(api.connections.check);
/** Disconnect a connection. */
export const useRemoveConnection = () => useConnectorMutation(api.connections.remove);
/**
 * Email (IMAP)'s servers for an address (connections-more.md CM-20): what Whombat found and a known provider's hint.
 * Changes nothing cached; the page keeps the answer for the address it asked about.
 */
export function useImapDiscover() {
  const { client } = useWhombat();
  return useMutation<
    CommitResult<ResponseData<typeof api.connectors.imapDiscover>>,
    Error,
    CallInput<typeof api.connectors.imapDiscover>
  >({ mutationFn: (input) => client.request(api.connectors.imapDiscover, input) });
}
/** Connect Email (IMAP) after Whombat signed in to both servers (CM-22); the connectors' status reads again. */
export const useImapConnect = () => useConnectorMutation(api.connectors.imapConnect);

/**
 * Connect Google: asks for the consent URL, then leaves for it as a full-page navigation (which also works
 * on mobile browsers). Google sends the browser back to `returnTo` with `connected=google` or
 * `connect_error=<code>`.
 */
export function useStartGoogleConnection(
  navigate: (url: string) => void = (url) => window.location.assign(url),
) {
  const { client } = useWhombat();
  return useMutation<
    CommitResult<ResponseData<typeof api.connections.startGoogle>>,
    Error,
    CallInput<typeof api.connections.startGoogle>
  >({
    mutationFn: (input) => client.request(api.connections.startGoogle, input),
    onSuccess: (result) => {
      if (result.status === 'ok') navigate(result.data.authorizeUrl);
    },
  });
}

/* The connections catalog (contracts 0.48.0, Whombat connections-catalog.md CX-70…CX-72) ------------ */

/** Every write on a catalog connection (`connections.*`; the secret ops go as secret session ops, CX-16). */
export type ConnectionWrite =
  | typeof api.connections.create
  | typeof api.connections.update
  | typeof api.connections.setSecret
  | typeof api.connections.recheck
  | typeof api.connections.disconnect
  | typeof api.connections.setTool
  | typeof api.connections.startOAuth
  | typeof api.connections.finishOAuth
  | typeof api.connections.startNextcloud
  | typeof api.connections.pollNextcloud
  | typeof api.connections.startServiceLogin
  | typeof api.connections.pollServiceLogin
  | typeof api.connections.probe
  | typeof api.connections.identify
  | typeof api.connections.discover
  | typeof api.connections.hideFound
  | typeof api.connections.allowNetwork;

/**
 * The connection a write answers (create, update, setSecret, recheck, setTool; a Nextcloud or service-login poll that
 * connected).
 */
function writtenConnection(data: unknown): { id: string } | null {
  const d = data as { connection?: { id?: unknown }; state?: unknown } | null;
  return d && typeof d.connection?.id === 'string' ? { id: d.connection.id } : null;
}

/**
 * A write on the burrow's connections (CX-71, CX-72). A write that answers a connection refreshes the list and that
 * connection's tools (`setTool` answers the tools themselves: they go in at once); removing one drops its tools; “Add
 * this network” answers the home-network list the Vault shares (VT-12). Starting an OAuth sign-in, a Nextcloud login
 * that is still pending, a probe, identifying an address, a scan of the home network and hiding what it found change
 * nothing cached (CT-314, CT-316).
 */
export function useConnectionWrite<E extends ConnectionWrite>(
  ep: E,
  burrow: string,
  options?: MutationOptions<CommitResult<ResponseData<E>>, CallInput<E>>,
) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<ResponseData<E>>, Error, CallInput<E>>({
    ...options,
    mutationFn: (input) => client.request(ep, input),
    onSuccess: (result, v, context, ctx) => {
      if (result.status === 'ok') {
        const params = (v as { params?: { connectionId?: string } }).params;
        if (ep.id === api.connections.allowNetwork.id)
          qc.setQueryData(
            queryKeys.vaultNetworks.list(),
            result.data as ResponseData<typeof api.vaultNetworks.list>,
          );
        else if (ep.id === api.connections.disconnect.id && params?.connectionId) {
          for (const read of [api.connections.tools, api.connections.onePassword])
            qc.removeQueries({ queryKey: queryKeys.scope(read, { connectionId: params.connectionId }) });
          void qc.invalidateQueries({ queryKey: queryKeys.scope(api.connections.list) });
          // Removing the Vault's sync (1Password) takes its tag off the entries it kept in step, or the entries too
          // (`vaultEntries`); the Vault reads again only where it is on screen.
          if ((v as { query?: { vaultEntries?: unknown } }).query?.vaultEntries !== undefined)
            invalidateVault(qc, null);
        } else if (ep.id === api.connections.setTool.id && params?.connectionId)
          qc.setQueryData(
            queryKeys.connections.tools({ params: { burrow, connectionId: params.connectionId } }),
            result.data as ResponseData<typeof api.connections.tools>,
          );
        const written = writtenConnection(result.data);
        if (written) {
          void qc.invalidateQueries({ queryKey: queryKeys.scope(api.connections.list) });
          if (ep.id !== api.connections.setTool.id)
            void qc.invalidateQueries({
              queryKey: queryKeys.scope(api.connections.tools, { connectionId: written.id }),
            });
        } else if (ep.id === api.connections.finishOAuth.id)
          void qc.invalidateQueries({ queryKey: queryKeys.scope(api.connections.list) });
      }
      return options?.onSuccess?.(result, v, context, ctx);
    },
  });
}

/**
 * Sync now and the answer to the guard's “1Password says 4 items are gone” (Whombat onepassword-sync.md; contracts
 * `connections.onePasswordSync`, `connections.onePasswordRemovals`): both answer the connection's page part, which goes
 * into the cache at once. An answer changes the Vault (entries removed, or kept only in Whombat) and takes the guard's
 * card out of the Inbox, so those read again; a refusal because the set changed reads the page part again, which shows
 * the new set.
 */
export function useOnePasswordWrite<
  E extends typeof api.connections.onePasswordSync | typeof api.connections.onePasswordRemovals,
>(ep: E, burrow: string, options?: MutationOptions<CommitResult<ResponseData<E>>, CallInput<E>>) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<ResponseData<E>>, Error, CallInput<E>>({
    ...options,
    mutationFn: (input) => client.request(ep, input),
    onSuccess: (result, v, context, ctx) => {
      const connectionId = connectionOf(v);
      if (result.status === 'ok') {
        qc.setQueryData(
          queryKeys.connections.onePassword({ params: { burrow, connectionId } }),
          result.data as ResponseData<typeof api.connections.onePassword>,
        );
        if (ep.id === api.connections.onePasswordRemovals.id) {
          invalidateVault(qc, null);
          void qc.invalidateQueries({ queryKey: queryKeys.scope('home.overview') });
        }
      } else
        void qc.invalidateQueries({
          queryKey: queryKeys.scope(api.connections.onePassword, { connectionId }),
        });
      return options?.onSuccess?.(result, v, context, ctx);
    },
    onError: (error, v, context, ctx) => {
      void qc.invalidateQueries({
        queryKey: queryKeys.scope(api.connections.onePassword, { connectionId: connectionOf(v) }),
      });
      if (ep.id === api.connections.onePasswordRemovals.id)
        void qc.invalidateQueries({ queryKey: queryKeys.scope('home.overview') });
      return options?.onError?.(error, v, context, ctx);
    },
  });
}

function connectionOf(v: unknown): string {
  return (v as { params: { connectionId: string } }).params.connectionId;
}

/** Save or remove the OAuth app of an `app_oauth` entry (Dropbox, CX-14): the answer is the catalog's status. */
export function useConnectorAppWrite<
  E extends typeof api.connectors.setApp | typeof api.connectors.removeApp,
>(ep: E, options?: MutationOptions<CommitResult<ResponseData<E>>, CallInput<E>>) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<ResponseData<E>>, Error, CallInput<E>>({
    ...options,
    mutationFn: (input) => client.request(ep, input),
    onSuccess: (result, v, context, ctx) => {
      if (result.status === 'ok') {
        qc.setQueryData(
          queryKeys.connections.catalog(),
          result.data as ResponseData<typeof api.connections.catalog>,
        );
        // Removing the app sends every connection made with it to “Needs connecting again”.
        void qc.invalidateQueries({ queryKey: queryKeys.scope(api.connections.list) });
      }
      return options?.onSuccess?.(result, v, context, ctx);
    },
  });
}

/* The Vault (docs/decisions/vault.md) ------------------------------------------------------------ */

type VaultWrite =
  | typeof api.vault.create
  | typeof api.vault.update
  | typeof api.vault.setSecret
  // A website login's authenticator key (contracts 3.14): answers the entry, like a secret.
  | typeof api.vault.setTotp
  | typeof api.vault.remove
  | typeof api.vault.check
  | typeof api.vault.setTool
  | typeof api.vault.giveKey
  | typeof api.vault.takeKey
  // An SSH key's own writes (contracts 0.32.0, VT-S03…VT-S07): each answers the entry, like the rest.
  | typeof api.vault.generateSshKey
  | typeof api.vault.replaceSshKey
  | typeof api.vault.addSshServer
  | typeof api.vault.updateSshServer
  | typeof api.vault.removeSshServer
  | typeof api.vault.checkSshServer
  | typeof api.vault.trustSshHostKey
  | typeof api.vault.setKeyServers
  // The environment variable an API entry's value is in for the agent's commands (contracts 0.125, CT-1240).
  | typeof api.vault.setKeyEnvName;

/**
 * Any change to one of the Vault entries (AP-110). The writes answer the entry as it is now (not a
 * commit outcome): it goes into the entry's detail at once, then the Vault's reads refetch (the list, the profile
 * pane's keys, the agents a key may still go to). Removing an entry drops its detail.
 */
export function useVaultWrite<E extends VaultWrite>(
  ep: E,
  burrow: string,
  options?: MutationOptions<CommitResult<ResponseData<E>>, CallInput<E>>,
) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<ResponseData<E>>, Error, CallInput<E>>({
    ...options,
    mutationFn: (input) => client.request(ep, input),
    onSuccess: (result, v, context, ctx) => {
      if (result.status === 'ok') {
        const entry = (result.data as { entry?: VaultEntryDetail }).entry;
        const removed = (v as { params?: { entryId?: string } }).params?.entryId;
        if (entry) {
          qc.setQueryData(queryKeys.vault.get({ params: { burrow, entryId: entry.id } }), (old) =>
            old ? { ...old, entry } : old,
          );
          invalidateVault(qc, entry.id);
        } else if (ep.id === api.vault.remove.id && removed) {
          qc.removeQueries({ queryKey: queryKeys.scope('vault.get', { entryId: removed }) });
          qc.removeQueries({ queryKey: queryKeys.scope('vault.uses', { entryId: removed }) });
          invalidateVault(qc, removed);
        }
      }
      return options?.onSuccess?.(result, v, context, ctx);
    },
  });
}

/** Add or remove a home network (VT-12): the answer is the new list. */
export function useVaultNetworkWrite<
  E extends typeof api.vaultNetworks.add | typeof api.vaultNetworks.remove,
>(ep: E, options?: MutationOptions<CommitResult<ResponseData<E>>, CallInput<E>>) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<ResponseData<E>>, Error, CallInput<E>>({
    ...options,
    mutationFn: (input) => client.request(ep, input),
    onSuccess: (result, v, context, ctx) => {
      if (result.status === 'ok')
        qc.setQueryData(
          queryKeys.vaultNetworks.list(),
          result.data as ResponseData<typeof api.vaultNetworks.list>,
        );
      return options?.onSuccess?.(result, v, context, ctx);
    },
  });
}

/* Shared plans (work-supervision WS-01…WS-10) ------------------------------------------------------ */

type PlanWrite =
  | typeof api.plans.create
  | typeof api.plans.update
  | typeof api.plans.addStep
  | typeof api.plans.updateStep
  | typeof api.plans.removeStep
  | typeof api.plans.startStep
  | typeof api.plans.createCanvas;

/**
 * Any plan change: make a plan, rename / reorder, add, edit, remove or start a step, create the plan canvas. The
 * answer's plan goes everywhere it shows at once (`applyPlan`: the pane, lists, the card, the canvas; never over a
 * newer one realtime already brought) and the work overview refetches. `plans.createCanvas` also puts the new canvas in
 * the canvases list.
 */
export function usePlanWrite<E extends PlanWrite>(
  ep: E,
  options?: MutationOptions<CommitResult<ResponseData<E>>, CallInput<E>>,
) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<ResponseData<E>>, Error, CallInput<E>>({
    ...options,
    mutationFn: (input) => client.request(ep, input),
    onSuccess: (result, v, context, ctx) => {
      if (result.status === 'ok') {
        const data = result.data as { plan?: Plan };
        if (data.plan) applyPlan(qc, data.plan);
        if (ep.id === 'plans.createCanvas')
          void qc.invalidateQueries({ queryKey: queryKeys.scope('canvases.list') });
        invalidateWork(qc);
      }
      return options?.onSuccess?.(result, v, context, ctx);
    },
  });
}
