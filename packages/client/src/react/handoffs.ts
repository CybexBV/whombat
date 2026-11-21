/**
 * What the agent handed to T3 Code from a conversation (Whombat t3code.md T3-24; app t3code-handoff.md AP-6610): the
 * conversation's hand-overs from `conversations.handoffs`, kept current by the `conversation.handoffs` frame. Web and
 * phone share it.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Handoff, JobAnswersBody, Message } from '@whombat/core';
import {
  api,
  type ConversationHandoffs,
  type HandoffAnswerBody,
  type HandoffSendBody,
} from '@whombat/core/contracts';
import type { CommitResult } from '../http/types';
import { queryKeys } from '../query/keys';
import { useWhombat } from './context';
import { queryHook } from './queries';

export const useHandoffsQuery = queryHook(api.conversations.handoffs);

const NONE: readonly Handoff[] = [];

/**
 * The conversation's hand-overs, oldest first. Empty while they load, when asked for nothing (`conversationId` null or
 * `enabled` false), and from a Whombat that doesn't know `conversations.handoffs` yet.
 */
export function useHandoffs(
  burrow: string | null | undefined,
  conversationId: string | null | undefined,
  enabled = true,
): readonly Handoff[] {
  const { data } = useHandoffsQuery(
    burrow && conversationId && enabled ? { params: { burrow, conversationId } } : null,
    { retry: false },
  );
  return data?.handoffs ?? NONE;
}

/**
 * The person's answer to a job's question and their message to a job (Whombat t3code.md T3-38, T3-39; app job-view.md):
 * each answers with the conversation's hand-overs, which replace the cached list at once (the frame follows).
 */
export function useJobActions(burrow: string, conversationId: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const keep = (result: CommitResult<ConversationHandoffs>) => {
    if (result.status !== 'ok') return;
    qc.setQueryData(
      queryKeys.endpoint(api.conversations.handoffs, { params: { burrow, conversationId } }),
      result.data,
    );
  };
  const answer = useMutation<CommitResult<ConversationHandoffs>, Error, HandoffAnswerBody>({
    mutationFn: (body) =>
      client.request(api.conversations.handoffAnswer, { params: { burrow, conversationId }, body }),
    onSuccess: keep,
  });
  const send = useMutation<CommitResult<ConversationHandoffs>, Error, HandoffSendBody>({
    mutationFn: (body) =>
      client.request(api.conversations.handoffSend, { params: { burrow, conversationId }, body }),
    onSuccess: keep,
  });
  return { answer, send };
}

/**
 * The person's answers to what a job's result message left for them, sent together (Whombat t3code.md T3-60): T3 Code
 * carries them out in one run. Answers with the message as it is now (its `jobResult.sends` has them); the
 * `message.updated` frame follows.
 */
export function useJobAnswers(burrow: string) {
  const { client } = useWhombat();
  return useMutation<CommitResult<{ message: Message }>, Error, { messageId: string } & JobAnswersBody>({
    mutationFn: ({ messageId, answers }) =>
      client.request(api.messages.jobAnswers, { params: { burrow, messageId }, body: { answers } }),
  });
}
