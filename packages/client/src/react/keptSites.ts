/**
 * Kept sites in React (Whombat kept-sites.md): the websites the assistant keeps signed in between chats, and stopping
 * one. Stopping reads the list again; a change the assistant makes comes as `vault.updated`, which reads it again too.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { KeptSite } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { endpointKey } from '../query/keys';
import { useWhombat } from './context';
import { queryHook } from './queries';

export const useKeptSites = queryHook(api.keptSites.list);

const listKey = (burrow: string) => endpointKey(api.keptSites.list, { params: { burrow } });

export function useStopKeptSite(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<KeptSite, Error, KeptSite['id']>({
    mutationFn: async (siteId) => {
      const res = await client.request(api.keptSites.stop, { params: { burrow, siteId } });
      if (res.status !== 'ok') throw new Error('refused');
      return res.data.site;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: listKey(burrow) }),
  });
}
