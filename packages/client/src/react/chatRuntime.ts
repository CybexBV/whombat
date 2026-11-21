/**
 * What answers in Chat (Whombat chat-runtime.md CR-01…CR-11; contracts 0.96.0; app chat-runtime.md AP-2680…): the
 * popover's read (`chats.runtime`), a thread's choice saved at once (`chats.setThreadRuntime`, optimistic, put back when
 * refused) and “Make this <Name>’s default” (`agents.update`). The choice goes with `chats.start` in `useStartChat`; a
 * change on another device arrives as `chat.thread_runtime` (`query/apply.ts`). Web and phone share them.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ChatRuntime } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { chatDefaultBody, chatRuntimeRefusalText } from '../chat/runtime';
import type { CommitResult, ResponseData } from '../http/types';
import { applyChatThreadRuntime, cachedChatThreadRuntime } from '../query/apply';
import { queryKeys } from '../query/keys';
import { isOptimisticMessage } from '../query/optimistic';
import { useWhombat } from './context';
import { useSetAgentModel } from './mutations';
import { queryHook } from './queries';

/** `chats.runtime` as it is (one hook per read endpoint). */
export const useChatRuntimeView = queryHook(api.chats.runtime);

/**
 * What answers in the caller's Chat (CR-01): the assistant's default, the providers with their models, readiness and
 * usage, and — with `rootId` — that thread's own choice (`thread`). `enabled: false` (no button: another room, a runtime
 * without `chat.runtime`) asks nothing; a thread that exists only on this device yet isn't asked about.
 */
export function useChatRuntime(
  burrow: string | null | undefined,
  rootId?: string | null,
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options;
  const local = !!rootId && isOptimisticMessage({ id: rootId });
  return useChatRuntimeView(
    burrow && enabled && !local ? { params: { burrow }, query: rootId ? { thread: rootId } : {} } : null,
    { retry: false, staleTime: 30_000 },
  );
}

export interface SetThreadRuntimeInput {
  /** The thread's first message. */
  rootId: string;
  /** The thread's new choice; null: it follows the assistant's own again (`chatThreadChoice`). */
  runtime: ChatRuntime | null;
}

/**
 * A thread's choice, saved at once (CR-02): the button and every cached read show it before the Whombat answers; a
 * refusal or a failure puts the previous choice back and says why (`onRefused`, `chatRuntimeRefusalText`). Applies
 * from the thread's next turn.
 */
export function useSetThreadRuntime(burrow: string, options: { onRefused?: (text: string) => void } = {}) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const putBack = (rootId: string, prev: ChatRuntime | null | undefined) => {
    if (prev === undefined) {
      void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.runtime') });
      void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.threads') });
    } else applyChatThreadRuntime(qc, rootId, prev);
  };
  return useMutation<
    CommitResult<ResponseData<typeof api.chats.setThreadRuntime>>,
    Error,
    SetThreadRuntimeInput,
    { prev: ChatRuntime | null | undefined }
  >({
    mutationFn: ({ rootId, runtime }) =>
      client.request(api.chats.setThreadRuntime, {
        params: { burrow, rootId: rootId as never },
        body: { runtime },
      }),
    onMutate: ({ rootId, runtime }) => {
      const prev = cachedChatThreadRuntime(qc, rootId);
      applyChatThreadRuntime(qc, rootId, runtime);
      return { prev };
    },
    onSuccess: (result, { rootId }, context) => {
      if (result.status === 'ok') return applyChatThreadRuntime(qc, rootId, result.data.thread);
      putBack(rootId, context?.prev);
      options.onRefused?.(chatRuntimeRefusalText(result));
    },
    onError: (error, { rootId }, context) => {
      putBack(rootId, context?.prev);
      options.onRefused?.(chatRuntimeRefusalText(error));
    },
  });
}

/**
 * “Make this <Name>’s default” (CR-03): the whole choice, fast replies too, as the assistant's runtime
 * (`agent.update`, `chatDefaultBody`); its profile and Chat's default read again (`useSetAgentModel`). The answer is a
 * `CommitResult`: `chatMadeDefaultText` when ok, `chatRuntimeRefusalText` else.
 */
export function useMakeChatDefault(burrow: string) {
  const update = useSetAgentModel(burrow);
  return {
    ...update,
    make: (runtime: ChatRuntime) =>
      update.mutateAsync({ params: { burrow }, body: { runtime: chatDefaultBody(runtime) } }),
  };
}
