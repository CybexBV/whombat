/**
 * Getting one thing back from a backup in React (Whombat backup-look.md; app backup-look.md): open the backup when the
 * flow starts and follow it while it opens or brings things back, a category's things a page at a time (with a search),
 * bring the picked ones back, and close it when the flow ends. Shared by web and phone. Not retried: a refusal is an
 * answer.
 */
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { BackupLook, BackupLookCategory, BackupLookContentsOutput } from '@whombat/protocol/session';
import { useEffect, useRef, useState } from 'react';
import { QUERY_ROOT } from '../query/keys';
import { sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';

/** How often an opening backup, or a bring-back still going, is read again. */
export const LOOK_FOLLOW_MS = 1500;

const contentsKey = (lookId: string | null) => [QUERY_ROOT, 'backup.lookContents', { lookId }, {}] as const;
const itemsKey = (lookId: string | null, category: BackupLookCategory | null, query: string) =>
  [QUERY_ROOT, 'backup.lookContents', { lookId, category }, { query }] as const;

/** Whether the look is still on its way somewhere (opening, or bringing things back): read it again soon. */
export function lookMoving(look: Pick<BackupLook, 'state' | 'bring'> | null | undefined): boolean {
  return !look || look.state === 'opening' || look.bring?.state === 'bringing';
}

/**
 * Opens `checkpointId` for reading while `open` is true and follows it; closes it when the flow ends (unmounted or
 * closed). `look` is null until the box answers; `error` is a refusal of the op itself (a box from before, the backup
 * service down).
 */
export function useBackupLook(session: ApplianceSession | null | undefined, checkpointId: string | null) {
  const qc = useQueryClient();
  const [opened, setOpened] = useState<BackupLook | null>(null);
  const [error, setError] = useState<unknown>(null);
  const lookId = opened?.lookId ?? null;
  const started = useRef<string | null>(null);

  useEffect(() => {
    if (!session || !checkpointId || started.current === checkpointId) return;
    started.current = checkpointId;
    setOpened(null);
    setError(null);
    sessionOps.backupLook(session, checkpointId).then(setOpened, setError);
  }, [session, checkpointId]);

  const contents = useQuery({
    queryKey: contentsKey(lookId),
    enabled: !!session && !!lookId && opened?.state !== 'failed',
    queryFn: () => sessionOps.backupLookContents(session as ApplianceSession, { lookId: lookId as string }),
    refetchInterval: (q) => (lookMoving(q.state.data?.look) ? LOOK_FOLLOW_MS : false),
    retry: false,
  });
  const look = contents.data?.look ?? opened;

  // The flow ends: the backup closes (the box closes it after two hours unused anyway).
  useEffect(() => {
    return () => {
      const id = started.current && lookId;
      if (session && id) void sessionOps.backupLookClose(session, id).catch(() => {});
    };
  }, [session, lookId]);

  const reload = () => qc.invalidateQueries({ queryKey: [QUERY_ROOT, 'backup.lookContents'] });
  const retry = () => {
    started.current = null;
    setOpened(null);
    setError(null);
    if (session && checkpointId) {
      started.current = checkpointId;
      sessionOps.backupLook(session, checkpointId).then(setOpened, setError);
    }
  };
  return {
    look,
    categories: contents.data?.categories ?? [],
    error: error ?? contents.error ?? null,
    reload,
    retry,
  };
}

/** How long typing in the search waits before the box is asked. */
export const LOOK_SEARCH_WAIT_MS = 250;

/** `value`, once it stopped changing for `ms`. */
function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (value === settled) return;
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, settled, ms]);
  return settled;
}

/** A category's things, a page at a time, matching `query` (empty: all; asked once typing pauses). */
export function useBackupLookItems(
  session: ApplianceSession | null | undefined,
  lookId: string | null,
  category: BackupLookCategory | null,
  typed: string,
) {
  const query = useSettled(typed.trim(), LOOK_SEARCH_WAIT_MS);
  const q = useInfiniteQuery<
    BackupLookContentsOutput,
    Error,
    InfiniteData<BackupLookContentsOutput>,
    ReturnType<typeof itemsKey>,
    string | undefined
  >({
    queryKey: itemsKey(lookId, category, query),
    enabled: !!session && !!lookId && !!category,
    initialPageParam: undefined,
    queryFn: ({ pageParam }) =>
      sessionOps.backupLookContents(session as ApplianceSession, {
        lookId: lookId as string,
        category: category as BackupLookCategory,
        ...(query ? { query } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // While a search is asked, the list stays as it was (only within the same category).
    placeholderData: (previous, before) =>
      (before?.queryKey[2] as { category?: unknown } | undefined)?.category === category
        ? previous
        : undefined,
    retry: false,
  });
  return {
    items: q.data?.pages.flatMap((p) => p.items) ?? [],
    loading: q.isPending && !!category,
    error: q.error,
    more: q.hasNextPage ? () => void q.fetchNextPage() : null,
  };
}

/** Brings the picked things back; the look then says how it went (`look.bring`), followed while it is still going. */
export function useBringBack(session: ApplianceSession | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { lookId: string; items: string[] }) =>
      sessionOps.backupLookBring(session as ApplianceSession, input),
    onSuccess: (answer) => {
      qc.setQueryData(contentsKey(answer.look.lookId), (d: BackupLookContentsOutput | undefined) =>
        d ? { ...d, look: answer.look } : d,
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [QUERY_ROOT, 'backup.lookContents'] }),
  });
}
