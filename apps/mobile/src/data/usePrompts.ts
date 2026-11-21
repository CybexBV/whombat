/**
 * The person's prompts as the phone reads and changes them (Whombat docs/decisions/prompts.md; app prompts-phone.md):
 * the list (`prompts.list`), T3 Code's projects for the repository picker (`prompts.projects`, asked when the picker
 * opens), and the writes, each of which reads the list again so Chat's `/` and Settings show what the box keeps. A
 * Whombat from before prompts answers `unknown_op`: then the phone shows no prompts anywhere, without an error.
 */
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@whombat/client/query';
import { queryHook, useApiMutation } from '@whombat/client/react';
import { api, type Prompt } from '@whombat/core';
import { useCallback } from 'react';
import { useBurrowBase } from './BurrowProvider';
import { olderWhombat } from './council';

const usePromptList = queryHook(api.prompts.list);
const usePromptProjectList = queryHook(api.prompts.projects);

export interface PromptsHere {
  /** The list, once the box answered. */
  prompts: Prompt[] | null;
  /** Prompts show here: the box answered, or it failed for another reason than not knowing them. */
  shown: boolean;
  /** The box doesn't know prompts (`unknown_op`). */
  older: boolean;
  error: unknown;
  refetch: () => void;
  refreshing: boolean;
}

/** The person's prompts; `enabled` false asks nothing (a screen that never shows them). */
export function usePrompts(enabled = true): PromptsHere {
  const { slug } = useBurrowBase();
  const query = usePromptList({ params: { burrow: slug } }, { enabled, retry: false });
  const older = !!query.error && olderWhombat(query.error);
  return {
    prompts: query.data?.prompts ?? null,
    shown: enabled && (!!query.data || (!!query.error && !older)),
    older,
    error: query.error,
    refetch: () => void query.refetch(),
    refreshing: query.isRefetching,
  };
}

/** T3 Code's projects, asked while the picker is open (each time it opens: projects come and go). */
export function usePromptProjects(open: boolean) {
  const { slug } = useBurrowBase();
  return usePromptProjectList({ params: { burrow: slug } }, { enabled: open, retry: false, staleTime: 0 });
}

/** Reads the list again after a change, wherever it shows. */
export function useRefreshPrompts(): () => Promise<void> {
  const qc = useQueryClient();
  const { slug } = useBurrowBase();
  return useCallback(
    () => qc.invalidateQueries({ queryKey: queryKeys.scope('prompts.list', { burrow: slug }) }),
    [qc, slug],
  );
}

/** Keeping, changing, removing and bringing back prompts; the list follows each. */
export function usePromptWrites() {
  const refresh = useRefreshPrompts();
  const after = { onSettled: () => void refresh() };
  return {
    create: useApiMutation(api.prompts.create, after),
    save: useApiMutation(api.prompts.save, after),
    remove: useApiMutation(api.prompts.remove, after),
    restore: useApiMutation(api.prompts.restore, after),
  };
}

/** Using a prompt on a project; the list follows (its runs changed). */
export function useUsePrompt() {
  const refresh = useRefreshPrompts();
  return useApiMutation(api.prompts.use, { onSettled: () => void refresh() });
}
