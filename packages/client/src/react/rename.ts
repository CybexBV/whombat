/**
 * `useRenameThing`: renames a server (`hosts.updateServer` with `name`) or a connection (`connections.update` with
 * `label`) from where it is listed, and refreshes what shows its name (the sidebar and Home, its page).
 */
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@whombat/core/contracts';
import { useCallback } from 'react';
import { connectProblem } from '../connections/form';
import type { ThingRenameTarget } from '../home/rename';
import { renameValue } from '../home/rename';
import { commitOutcomeText, hostErrorInfo } from '../hosts/errors';
import { useHostsChange } from '../hosts/react';
import { queryKeys } from '../query/keys';
import { useConnectionWrite } from './mutations';

/** How a rename went: done (`changed` false when nothing needed changing), or why not, in words. */
export type RenameOutcome = { ok: true; changed: boolean } | { ok: false; problem: string };

export function useRenameThing(burrow: string): {
  rename: (target: ThingRenameTarget, typed: string) => Promise<RenameOutcome>;
  pending: boolean;
} {
  const qc = useQueryClient();
  const server = useHostsChange(api.hosts.updateServer);
  const connection = useConnectionWrite(api.connections.update, burrow);
  const rename = useCallback(
    async (target: ThingRenameTarget, typed: string): Promise<RenameOutcome> => {
      const value = renameValue(target, typed);
      if (!value) return { ok: true, changed: false };
      if (target.kind === 'server') {
        try {
          const r = await server.mutateAsync({
            params: { burrow, serverId: target.id },
            body: { name: value.name },
          });
          const refused = commitOutcomeText(r);
          return refused ? { ok: false, problem: refused } : { ok: true, changed: true };
        } catch (err) {
          const info = hostErrorInfo(err);
          return { ok: false, problem: info.fields.name ?? info.message };
        }
      }
      if (value.name === null) return { ok: true, changed: false };
      try {
        const r = await connection.mutateAsync({
          params: { burrow, connectionId: target.id },
          body: { label: value.name },
        });
        const refused = commitOutcomeText(r);
        if (refused) return { ok: false, problem: refused };
        void qc.invalidateQueries({ queryKey: queryKeys.scope(api.home.overview) });
        return { ok: true, changed: true };
      } catch (err) {
        const p = connectProblem(err);
        return {
          ok: false,
          problem: p.fields.label ?? p.message ?? 'That didn’t work. Try again in a moment.',
        };
      }
    },
    [burrow, server, connection, qc],
  );
  return { rename, pending: server.isPending || connection.isPending };
}
