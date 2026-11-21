/**
 * Shared links in React (docs/decisions/share-links.md): the Share sheet's preview, making a link, the list in
 * Settings, stopping one or all. Making or stopping a link reads the list again.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateShareBody, SharedLink, ShareScope } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { endpointKey } from '../query/keys';
import { useWhombat } from './context';
import { queryHook } from './queries';

export const useShares = queryHook(api.shares.list);

const listKey = (burrow: string) => endpointKey(api.shares.list, { params: { burrow } });

/** The words of a refusal or failure, the Whombat's own when it gave them. */
export function shareErrorText(error: unknown, fallback: string): string {
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message
  )
    return error.message;
  return fallback;
}

/** What a link to `scope` would show (read once per open sheet, never retried). */
export function useSharePreview(burrow: string, scope: ShareScope | null) {
  const { client } = useWhombat();
  return useQuery({
    queryKey: ['whombat', 'shares.preview', burrow, scope?.rootId ?? null, scope?.fromMessageId ?? null],
    enabled: scope !== null,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    queryFn: async () => {
      const res = await client.request(api.shares.preview, { params: { burrow }, body: scope as ShareScope });
      if (res.status !== 'ok') throw new Error('refused');
      return res.data;
    },
  });
}

export function useCreateShare(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<SharedLink, Error, CreateShareBody>({
    mutationFn: async (body) => {
      const res = await client.request(api.shares.create, { params: { burrow }, body });
      if (res.status !== 'ok') throw new Error('refused');
      return res.data.share;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: listKey(burrow) }),
  });
}

export function useStopShare(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<SharedLink, Error, string>({
    mutationFn: async (shareId) => {
      const res = await client.request(api.shares.stop, { params: { burrow, shareId } });
      if (res.status !== 'ok') throw new Error('refused');
      return res.data.share;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: listKey(burrow) }),
  });
}

export function useStopAllShares(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<number, Error, void>({
    mutationFn: async () => {
      const res = await client.request(api.shares.stopAll, { params: { burrow }, body: {} });
      if (res.status !== 'ok') throw new Error('refused');
      return res.data.stopped;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: listKey(burrow) }),
  });
}
