/**
 * What the agent runs on the person's Whombat (contracts 3.0, CT-1533…CT-1537; Whombat one-person.md OP-19; app
 * one-person.md AP-5655): its services (websites, dev servers, dashboards that stay up as containers) with Stop, and
 * the commands the person always allows it (AC-42). Each write answers what it changed as it is now, which goes into
 * the read at once; `services.changed` refetches the list (`query/apply.ts`).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@whombat/core/contracts';
import type { CommitResult, ResponseData } from '../http/types';
import { queryKeys } from '../query/keys';
import { useWhombat } from './context';
import { queryHook } from './queries';

/** The agent's services and whether the container engine is here (`services.list`). */
export const useAgentServices = queryHook(api.services.list);
/** The commands the person always allowed the agent (“Always allow for Dusty”, AC-42). */
export const useCommandAllowances = queryHook(api.agent.commandAllowances);

/** Stop one of the agent's services (it stays stopped); the answer replaces it in `services.list` at once. */
export function useStopService(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  type E = typeof api.services.stop;
  return useMutation<CommitResult<ResponseData<E>>, Error, { id: string }>({
    mutationFn: ({ id }) => client.request(api.services.stop, { params: { burrow }, body: { id } }),
    onSuccess: (result) => {
      if (result.status !== 'ok') return;
      const { service } = result.data;
      qc.setQueryData(queryKeys.endpoint(api.services.list, { params: { burrow } }), (d) =>
        d ? { ...d, services: d.services.map((s) => (s.id === service.id ? service : s)) } : d,
      );
    },
  });
}

/** Remove an allowance (the command asks again next time); the answer replaces the list at once. */
export function useRemoveCommandAllowance(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  type E = typeof api.agent.removeCommandAllowance;
  return useMutation<CommitResult<ResponseData<E>>, Error, { allowanceId: string }>({
    mutationFn: ({ allowanceId }) =>
      client.request(api.agent.removeCommandAllowance, { params: { burrow, allowanceId } }),
    onSuccess: (result) => {
      if (result.status !== 'ok') return;
      qc.setQueryData(queryKeys.endpoint(api.agent.commandAllowances, { params: { burrow } }), {
        allowances: result.data.allowances,
      });
    },
  });
}
