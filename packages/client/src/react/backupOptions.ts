/**
 * Backup options and the list of backups in React (Whombat backup-options.md; app backup-options.md): the Backups page
 * in one request (`backup.overview`, CT-1691), its parts kept under the keys the screens read (`backup.status`,
 * `backup.checkpoints`, `backup.policy`), and read again after Save, a check, a move or a removal. A box from before the
 * overview (`unknown_op`) answers each part's own op instead; one from before the options answers `unknown_op` there
 * too, and those screens show what they showed before. No data where there is no session or for someone who isn't an
 * owner. Not retried: a refusal is an answer.
 */
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BACKUP_LIST_PAGE,
  type BackupCheckpointsOutput,
  type BackupEarlierPlace,
  type BackupOverviewOutput,
  type BackupSetPolicyInput,
} from '@whombat/protocol/session';
import { useCallback } from 'react';
import { QUERY_ROOT } from '../query/keys';
import { OperationError, sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';

export const BACKUP_OVERVIEW_QUERY_KEY = [QUERY_ROOT, 'backup.overview', {}, {}] as const;
export const BACKUP_CHECKPOINTS_QUERY_KEY = [QUERY_ROOT, 'backup.checkpoints', {}, {}] as const;
export const BACKUP_POLICY_QUERY_KEY = [QUERY_ROOT, 'backup.policy', {}, {}] as const;
export const BACKUP_SERVICE_STATUS_QUERY_KEY = [QUERY_ROOT, 'backup.status', {}, {}] as const;
export const BACKUP_PAGE_NOTES_QUERY_KEY = [QUERY_ROOT, 'backup.pageNotes', {}, {}] as const;

/** How long one overview answers the parts read at the same time (the page's hooks mount together). */
const SHARED_MS = 5_000;
/** The most backups the list reads page by page for the screens that show the whole list. */
export const BACKUP_LIST_READ_MAX = 1_000;

/**
 * The overview, shared by the parts read together; null when it can't be had (a box from before it, or any refusal:
 * each part then asks its own op, which says why in its own words).
 */
export async function backupOverviewOnce(
  qc: QueryClient,
  session: ApplianceSession,
): Promise<BackupOverviewOutput | null> {
  try {
    return await qc.fetchQuery({
      queryKey: BACKUP_OVERVIEW_QUERY_KEY,
      queryFn: () => sessionOps.backupOverview(session),
      staleTime: SHARED_MS,
      retry: false,
    });
  } catch {
    return null;
  }
}

/**
 * A part of the overview, or its own op when the overview doesn't have it (a box from before, a part it couldn't read).
 * While the overview says the backup service isn't answering, a part it couldn't read fails at once with that notice:
 * asking the service again straight away would only wait for the same silence.
 */
async function part<T>(
  qc: QueryClient,
  session: ApplianceSession,
  pick: (o: BackupOverviewOutput) => T | null,
  own: () => Promise<T>,
): Promise<T> {
  const overview = await backupOverviewOnce(qc, session);
  const value = overview ? pick(overview) : null;
  if (value !== null) return value;
  if (overview?.notice)
    throw new OperationError('backup.overview', 503, 'backup_unavailable', overview.notice);
  // A part the box couldn't read: its own op says why (the same refusal the screen showed before).
  return own();
}

/**
 * Every backup in one list for the screens that show it whole: the first page, then the next ones (`BACKUP_LIST_PAGE`
 * at a time) up to `BACKUP_LIST_READ_MAX`. `nextCursor` says whether more are left.
 */
export async function readBackupList(
  session: ApplianceSession,
  first: BackupCheckpointsOutput,
): Promise<BackupCheckpointsOutput> {
  let checkpoints = first.checkpoints;
  let cursor = first.nextCursor ?? null;
  while (cursor && checkpoints.length < BACKUP_LIST_READ_MAX) {
    const page = await sessionOps.backupCheckpoints(session, undefined, { cursor, limit: BACKUP_LIST_PAGE });
    checkpoints = checkpoints.concat(page.checkpoints);
    cursor = page.nextCursor ?? null;
  }
  return { ...first, checkpoints, nextCursor: cursor };
}

/** What the Backups page says besides its parts: the overview's notice, and the places that kept backups before. */
export interface BackupPageNotes {
  /** The backup service isn't answering now, in plain words; null when it is (or on a box from before). */
  notice: string | null;
  earlierPlaces: BackupEarlierPlace[];
}

/** The overview's notice and earlier places (none on a box from before the overview), from the same one answer. */
export function useBackupPageNotes(session: ApplianceSession | null | undefined, enabled = true) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: BACKUP_PAGE_NOTES_QUERY_KEY,
    queryFn: async (): Promise<BackupPageNotes> => {
      const overview = await backupOverviewOnce(qc, session as ApplianceSession);
      return { notice: overview?.notice ?? null, earlierPlaces: overview?.earlierPlaces ?? [] };
    },
    enabled: !!session && enabled,
    retry: false,
    staleTime: 30_000,
  });
}

/** The backup service's own status (`backup.status`): the top card's last backup, check and kit generation. */
export function useBackupServiceStatus(session: ApplianceSession | null | undefined, enabled = true) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: BACKUP_SERVICE_STATUS_QUERY_KEY,
    queryFn: () => {
      const s = session as ApplianceSession;
      return part(
        qc,
        s,
        (o) => (o.status ? { status: o.status, summary: o.summary } : null),
        () => sessionOps.backupStatus(s),
      );
    },
    enabled: !!session && enabled,
    retry: false,
    staleTime: 30_000,
  });
}

/** The list of backups, newest first (the first page from the overview, then the rest page by page). */
export function useBackupCheckpoints(session: ApplianceSession | null | undefined, enabled = true) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: BACKUP_CHECKPOINTS_QUERY_KEY,
    queryFn: async () => {
      const s = session as ApplianceSession;
      const first = await part(
        qc,
        s,
        (o) => o.checkpoints,
        () => sessionOps.backupCheckpoints(s),
      );
      return readBackupList(s, first);
    },
    enabled: !!session && enabled,
    retry: false,
    staleTime: 30_000,
  });
}

export function useBackupPolicy(session: ApplianceSession | null | undefined, enabled = true) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: BACKUP_POLICY_QUERY_KEY,
    queryFn: () => {
      const s = session as ApplianceSession;
      return part(
        qc,
        s,
        (o) => o.policy,
        () => sessionOps.backupPolicy(s),
      );
    },
    enabled: !!session && enabled,
    retry: false,
    staleTime: 30_000,
  });
}

/** Reads the overview, the list and the policy again (the overview first, so the parts don't take the old one). */
export function useReloadBackupOptions(): () => Promise<void> {
  const qc = useQueryClient();
  return useCallback(async () => {
    qc.removeQueries({ queryKey: BACKUP_OVERVIEW_QUERY_KEY });
    await Promise.all([
      qc.invalidateQueries({ queryKey: BACKUP_PAGE_NOTES_QUERY_KEY }),
      qc.invalidateQueries({ queryKey: BACKUP_SERVICE_STATUS_QUERY_KEY }),
      qc.invalidateQueries({ queryKey: BACKUP_CHECKPOINTS_QUERY_KEY }),
      qc.invalidateQueries({ queryKey: BACKUP_POLICY_QUERY_KEY }),
    ]);
  }, [qc]);
}

/** The list again after a change (the overview's old first page isn't reused). */
function reloadList(qc: QueryClient) {
  qc.removeQueries({ queryKey: BACKUP_OVERVIEW_QUERY_KEY });
  return qc.invalidateQueries({ queryKey: BACKUP_CHECKPOINTS_QUERY_KEY });
}

/** The options dialog's Save: the answer is the policy now, then the list is read again (the summary's estimate). */
export function useSetBackupPolicy(session: ApplianceSession | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BackupSetPolicyInput) =>
      sessionOps.backupSetPolicy(session as ApplianceSession, input),
    onSuccess: (answer) => {
      qc.setQueryData(BACKUP_POLICY_QUERY_KEY, answer);
      qc.removeQueries({ queryKey: BACKUP_OVERVIEW_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: BACKUP_POLICY_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: BACKUP_CHECKPOINTS_QUERY_KEY });
    },
  });
}

/** “Check this backup now”: the result lands on the backup in the list, so it is read again. */
export function useCheckBackup(session: ApplianceSession | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (checkpointId: string) => sessionOps.backupCheck(session as ApplianceSession, checkpointId),
    onSettled: () => reloadList(qc),
  });
}

/** Move (copy to the place, then remove from the box) or Remove the backups left on the box's own disk. */
export function useBackupLocal(session: ApplianceSession | null | undefined) {
  const qc = useQueryClient();
  const reload = () => reloadList(qc);
  const move = useMutation({
    mutationFn: () => sessionOps.backupMoveLocal(session as ApplianceSession),
    onSettled: reload,
  });
  const remove = useMutation({
    mutationFn: () => sessionOps.backupRemoveLocal(session as ApplianceSession),
    onSettled: reload,
  });
  return { move, remove };
}
