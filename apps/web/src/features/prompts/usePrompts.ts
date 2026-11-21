/**
 * The person's prompts, read and changed (docs/app/decisions/prompts-web.md): the list, asked once and kept fresh after
 * every change and use; T3 Code's projects, asked when the picker opens; and using a prompt, after which Chat and the
 * thread read again. A box without prompts (`unknown_op`) gives an empty list and `known: false`, never an error.
 */
import { useQueryClient } from '@tanstack/react-query';
import type { CommitResult } from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { queryHook, useApiMutation } from '@whombat/client/react';
import type { Prompt } from '@whombat/core';
import {
  api,
  type PromptProject,
  type PromptProjectsResponse,
  type PromptsResponse,
} from '@whombat/core/contracts';
import { useCallback, useMemo } from 'react';
import { promptsMissing } from './promptsModel';

const usePromptList = queryHook(api.prompts.list);
const usePromptProjectsQuery = queryHook(api.prompts.projects);
const NONE: Prompt[] = [];

export interface PromptsState {
  prompts: readonly Prompt[];
  /** The list has answered (empty on a box without prompts). */
  known: boolean;
  /** The box has prompts; false while unknown or on a box from before. */
  available: boolean;
  loading: boolean;
  /** A real failure (not a box from before). */
  error: unknown;
  refetch: () => void;
}

/** The person's prompts; nothing is asked until `enabled`. */
export function usePrompts(burrow: string, enabled = true): PromptsState {
  const q = usePromptList({ params: { burrow } }, { enabled, retry: false, staleTime: 30_000 });
  const missing = promptsMissing(q.error);
  return {
    prompts: q.data?.prompts ?? NONE,
    known: q.data !== undefined || missing,
    available: q.data !== undefined,
    loading: enabled && q.isPending && !q.error,
    error: q.error && !missing ? q.error : null,
    refetch: () => void q.refetch(),
  };
}

export interface PromptProjectsState {
  projects: readonly PromptProject[] | null;
  t3: PromptProjectsResponse['t3'] | null;
  loading: boolean;
}

/** T3 Code's projects, asked only while `enabled` (the picker is open). An error reads as T3 Code unreachable. */
export function usePromptProjects(burrow: string, enabled: boolean): PromptProjectsState {
  const q = usePromptProjectsQuery({ params: { burrow } }, { enabled, retry: false, staleTime: 30_000 });
  if (q.data) return { projects: q.data.projects, t3: q.data.t3, loading: false };
  if (q.error) return { projects: null, t3: 'unreachable', loading: false };
  return { projects: null, t3: null, loading: enabled };
}

function okData<T>(result: CommitResult<T>): T {
  if (result.status !== 'ok') throw new Error(result.status);
  return result.data;
}

/** Keep, change, remove and bring back prompts; the list is replaced or read again after each. */
export function usePromptWrites(burrow: string) {
  const qc = useQueryClient();
  const listKey = queryKeys.endpoint(api.prompts.list, { params: { burrow } });
  const putList = (data: PromptsResponse) => qc.setQueryData(listKey, data);
  const putOne = (prompt: Prompt) =>
    qc.setQueryData<PromptsResponse>(listKey, (was) =>
      was
        ? {
            prompts: was.prompts.some((p) => p.id === prompt.id)
              ? was.prompts.map((p) => (p.id === prompt.id ? prompt : p))
              : [...was.prompts, prompt],
          }
        : was,
    );
  const settle = () => void qc.invalidateQueries({ queryKey: listKey });
  const create = useApiMutation(api.prompts.create, {
    onSuccess: (r) => r.status === 'ok' && putOne(r.data.prompt),
    onSettled: settle,
  });
  const save = useApiMutation(api.prompts.save, {
    onSuccess: (r) => r.status === 'ok' && putOne(r.data.prompt),
    onSettled: settle,
  });
  const remove = useApiMutation(api.prompts.remove, {
    onSuccess: (r) => r.status === 'ok' && putList(r.data),
    onSettled: settle,
  });
  const restore = useApiMutation(api.prompts.restore, {
    onSuccess: (r) => r.status === 'ok' && putList(r.data),
    onSettled: settle,
  });
  return useMemo(
    () => ({
      /** Keep a new prompt, or change `id`'s. */
      save: async (id: string | null, body: Parameters<typeof create.mutateAsync>[0]['body']) =>
        okData(
          id
            ? await save.mutateAsync({ params: { burrow, promptId: id as never }, body })
            : await create.mutateAsync({ params: { burrow }, body }),
        ).prompt,
      remove: async (id: string) =>
        okData(await remove.mutateAsync({ params: { burrow, promptId: id as never } })),
      restore: async () => okData(await restore.mutateAsync({ params: { burrow }, body: {} })),
      saving: create.isPending || save.isPending,
      removing: remove.isPending,
      restoring: restore.isPending,
    }),
    [burrow, create, save, remove, restore],
  );
}

/**
 * Use a prompt on a project in a Chat room (as a new thread, or with `rootId` a reply there). Resolves with where the
 * message is; the list (its runs) and the room's messages are read again.
 */
export function useUsePrompt(burrow: string) {
  const qc = useQueryClient();
  const use = useApiMutation(api.prompts.use);
  const run = useCallback(
    async (
      prompt: Pick<Prompt, 'id'>,
      where: { conversationId: string; rootId?: string | null },
      project: Pick<PromptProject, 'id' | 'title'>,
    ) => {
      const result = okData(
        await use.mutateAsync({
          params: { burrow, promptId: prompt.id as never },
          body: {
            conversationId: where.conversationId as never,
            ...(where.rootId ? { rootId: where.rootId as never } : {}),
            project: { id: project.id, title: project.title.trim() || project.id },
          },
        }),
      );
      for (const id of ['prompts.list', 'messages.list', 'messages.thread', 'chats.threads'])
        void qc.invalidateQueries({ queryKey: queryKeys.scope(id) });
      return result;
    },
    [burrow, qc, use],
  );
  return { run, pending: use.isPending };
}
