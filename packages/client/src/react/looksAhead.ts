/**
 * Looks ahead's setting and Inbox finding actions (`looksAhead.get`, `looksAhead.update`, `looksAhead.checkNow`,
 * `looksAhead.promote`, `looksAhead.feedback`).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type AheadInboxFeedbackBody,
  type AheadInboxFeedbackResponse,
  type AheadPromoteResponse,
  api,
  type ChatSummary,
  type HomeOverview,
  type LooksAheadCheckNowResult,
  type LooksAheadUpdate,
  type LooksAheadView,
} from '@whombat/core';
import { withNeedsYouListItem } from '../home/needsYouList';
import type { CommitResult } from '../http/types';
import { withLooksAheadChange } from '../looksAhead';
import { upsertMessageEverywhere } from '../query/apply';
import { patchEndpoint } from '../query/cache';
import { queryKeys } from '../query/keys';
import { useWhombat } from './context';
import { chatSummaryOf } from './home';
import { queryHook } from './queries';

/** Looks ahead as the Whombat has it. */
export const useLooksAhead = queryHook(api.looksAhead.get);

/**
 * Change Looks ahead: its switch, incoming mail, one calendar, one kind of finding, a standing rule, or stop keeping an
 * eye on something.
 */
export function useUpdateLooksAhead(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const key = queryKeys.endpoint(api.looksAhead.get, { params: { burrow } });
  const putBack = (before: LooksAheadView | undefined) => {
    if (before) qc.setQueryData(key, before);
    void qc.invalidateQueries({ queryKey: key });
  };
  return useMutation<
    CommitResult<LooksAheadView>,
    Error,
    LooksAheadUpdate,
    { before: LooksAheadView | undefined }
  >({
    mutationFn: (body) => client.request(api.looksAhead.update, { params: { burrow }, body }),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<LooksAheadView>(key);
      if (before) qc.setQueryData(key, withLooksAheadChange(before, body));
      return { before };
    },
    onSuccess: (result, _body, context) => {
      if (result.status === 'ok') qc.setQueryData(key, result.data);
      else putBack(context?.before);
    },
    onError: (_error, _body, context) => putBack(context?.before),
  });
}

/** Run one immediate Looks ahead check right now (`looksAhead.checkNow`). */
export function useCheckLooksAheadNow(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const key = queryKeys.endpoint(api.looksAhead.get, { params: { burrow } });
  return useMutation<CommitResult<LooksAheadCheckNowResult>, Error, void>({
    mutationFn: () => client.request(api.looksAhead.checkNow, { params: { burrow }, body: {} }),
    onSuccess: (result) => {
      if (result.status === 'ok') qc.setQueryData(key, result.data.view);
    },
  });
}

type HomeSnapshot = [readonly unknown[], unknown][];

/**
 * Promote a Looks ahead Inbox finding into a Chat thread (`looksAhead.promote`). When `text` is passed (a one-tap
 * action or direct reply), it posts the person's message and wakes the assistant. Removes the item from the Inbox
 * optimistically and adds the new thread to Chat caches immediately.
 */
export function usePromoteAhead(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<
    CommitResult<AheadPromoteResponse>,
    Error,
    { checkId: string; text?: string },
    { snapshot: HomeSnapshot }
  >({
    onMutate: ({ checkId }) => {
      const snapshot = qc.getQueriesData({ queryKey: queryKeys.scope('home.overview') });
      patchEndpoint<HomeOverview>(qc, 'home.overview', (d) =>
        withNeedsYouListItem(d, { kind: 'ahead', id: checkId }, 'gone'),
      );
      return { snapshot };
    },
    mutationFn: ({ checkId, text }) =>
      client.request(api.looksAhead.promote, {
        params: { burrow, checkId: checkId as never },
        body: text ? { text } : {},
      }),
    onSuccess: (result, _vars, ctx) => {
      if (result.status !== 'ok') {
        if (ctx) for (const [k, d] of ctx.snapshot) qc.setQueryData(k, d);
        return;
      }
      const { conversation, message } = result.data;
      patchEndpoint<{ chats: ChatSummary[] }>(qc, 'chats.list', (d, key) =>
        key.query.archived || d.chats.some((c) => c.id === conversation.id)
          ? d
          : { ...d, chats: [chatSummaryOf(conversation, message), ...d.chats] },
      );
      upsertMessageEverywhere(qc, message);
    },
    onError: (_err, _vars, ctx) => {
      if (ctx) for (const [k, d] of ctx.snapshot) qc.setQueryData(k, d);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.scope('home.overview') });
      void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.list') });
      void qc.invalidateQueries({ queryKey: queryKeys.scope('messages.list') });
      void qc.invalidateQueries({ queryKey: queryKeys.scope('looksAhead.get') });
    },
  });
}

/** Record “Not useful” or “Stop checking for this” on a Looks ahead Inbox finding (`looksAhead.feedback`). */
export function useAheadFeedback(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<
    CommitResult<AheadInboxFeedbackResponse>,
    Error,
    { checkId: string } & AheadInboxFeedbackBody,
    { snapshot: HomeSnapshot }
  >({
    onMutate: ({ checkId }) => {
      const snapshot = qc.getQueriesData({ queryKey: queryKeys.scope('home.overview') });
      patchEndpoint<HomeOverview>(qc, 'home.overview', (d) =>
        withNeedsYouListItem(d, { kind: 'ahead', id: checkId }, 'gone'),
      );
      return { snapshot };
    },
    mutationFn: ({ checkId, verdict, reason }) =>
      client.request(api.looksAhead.feedback, {
        params: { burrow, checkId: checkId as never },
        body: { verdict, ...(reason ? { reason } : {}) },
      }),
    onSuccess: (result, _vars, ctx) => {
      if (result.status !== 'ok' && ctx) for (const [k, d] of ctx.snapshot) qc.setQueryData(k, d);
    },
    onError: (_err, _vars, ctx) => {
      if (ctx) for (const [k, d] of ctx.snapshot) qc.setQueryData(k, d);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.scope('home.overview') });
      void qc.invalidateQueries({ queryKey: queryKeys.scope('looksAhead.get') });
    },
  });
}
