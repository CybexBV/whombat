/**
 * GitHub for settings (docs/decisions/github-gh.md): connect. Every repository the account owns comes with the
 * connection (docs/decisions/agent-repos.md AGR-08), so there is nothing to pick.
 */
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { useApiMutation } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';

export type GitHubOutcome<T> = { ok: true; data: T } | { ok: false; message: string };

function failure(err: unknown, fallback: string): { ok: false; message: string } {
  return { ok: false, message: (err instanceof ApiError && err.message) || fallback };
}

/** "Connect GitHub": asks the Whombat to connect the burrow with your GitHub sign-in. */
export function useConnectGitHub(burrow: string | null) {
  const qc = useQueryClient();
  const connect = useApiMutation(api.github.connect);
  async function run(): Promise<GitHubOutcome<null>> {
    if (!burrow) return { ok: false, message: 'Finish setting up your Whombat first.' };
    try {
      const res = await connect.mutateAsync({ params: { burrow } });
      if (res.status !== 'ok')
        return { ok: false, message: 'Couldn’t connect GitHub. Try again in a moment.' };
      qc.setQueryData(queryKeys.github.status({ params: { burrow } }), res.data);
      void qc.invalidateQueries({ queryKey: queryKeys.scope('github.status') });
      void qc.invalidateQueries({ queryKey: queryKeys.scope('repos.list') });
      return { ok: true, data: null };
    } catch (err) {
      void qc.invalidateQueries({ queryKey: queryKeys.scope('github.status') });
      return failure(err, 'Couldn’t connect GitHub. Try again in a moment.');
    }
  }
  return { connect: run, connecting: connect.isPending };
}
