/**
 * The quiet hours for changes (Whombat care-plan.md; `changeWindow.get`, `changeWindow.set`): when the assistant installs
 * updates and restarts things, and when an approval's *Tonight* runs. A Whombat that doesn't know them answers
 * `unknown_op`; the apps then keep 03:00, as before.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, CHANGE_WINDOW_DEFAULT, type ChangeWindow, type ChangeWindowView } from '@whombat/core';
import type { CommitResult } from '../http/types';
import { queryKeys } from '../query/keys';
import { useWhombat } from './context';
import { queryHook } from './queries';

/** The quiet hours as the Whombat has them. */
export const useChangeWindowView = queryHook(api.changeWindow.get);

/** The quiet hours, the default while they aren't read (or the Whombat doesn't have them). */
export function useChangeWindow(burrow: string | null | undefined): ChangeWindow {
  const view = useChangeWindowView(burrow ? { params: { burrow } } : null, {
    staleTime: 5 * 60_000,
    retry: false,
  });
  return view.data?.window ?? CHANGE_WINDOW_DEFAULT;
}

/** Move the quiet hours; the view is the Whombat's answer at once. */
export function useSetChangeWindow(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<ChangeWindowView>, Error, ChangeWindow>({
    mutationFn: (window) => client.request(api.changeWindow.set, { params: { burrow }, body: { window } }),
    onSuccess: (result) => {
      if (result.status !== 'ok') return;
      qc.setQueryData(queryKeys.endpoint(api.changeWindow.get, { params: { burrow } }), result.data);
    },
  });
}
