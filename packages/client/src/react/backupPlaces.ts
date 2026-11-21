/**
 * Backup places in React (app backup-places.md AP-6700): `backup.places` in the query cache, read by This Whombat →
 * Backups and by the server's and NAS connection's pages (“Backups kept here”), and read again after a place is set.
 * No data where there is no session, on a box from before (`unknown_op`) or for someone who isn't an owner: those show
 * nothing new. Not retried: a refusal is an answer.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BackupOverviewOutput } from '@whombat/protocol/session';
import { useCallback } from 'react';
import { QUERY_ROOT } from '../query/keys';
import { sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import {
  BACKUP_CHECKPOINTS_QUERY_KEY,
  BACKUP_OVERVIEW_QUERY_KEY,
  BACKUP_PAGE_NOTES_QUERY_KEY,
  BACKUP_SERVICE_STATUS_QUERY_KEY,
  backupOverviewOnce,
} from './backupOptions';

/** Where `backup.places` is kept (endpoint-shaped, like the desk's and voice typing's). */
export const BACKUP_PLACES_QUERY_KEY = [QUERY_ROOT, 'backup.places', {}, {}] as const;

/** An overview this read can take its places from: on its way, or read in the last few seconds. */
const OVERVIEW_FRESH_MS = 5_000;

export function useBackupPlaces(session: ApplianceSession | null | undefined, enabled = true) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: BACKUP_PLACES_QUERY_KEY,
    queryFn: async () => {
      const s = session as ApplianceSession;
      // On the Backups page the overview already reads them; a server's page asks for the places alone.
      const state = qc.getQueryState<BackupOverviewOutput>(BACKUP_OVERVIEW_QUERY_KEY);
      const shared =
        state &&
        (state.fetchStatus === 'fetching' ||
          (state.data && Date.now() - state.dataUpdatedAt < OVERVIEW_FRESH_MS));
      const overview = shared ? await backupOverviewOnce(qc, s).catch(() => null) : null;
      return overview?.places ?? sessionOps.backupPlaces(s);
    },
    enabled: !!session && enabled,
    retry: false,
    staleTime: 30_000,
  });
}

/**
 * Reads the places again (after one was set up, or the destination changed), and what the Backups page shows with them:
 * a new place lists its own backups, and the one before becomes an earlier place.
 */
export function useReloadBackupPlaces(): () => Promise<void> {
  const qc = useQueryClient();
  return useCallback(async () => {
    qc.removeQueries({ queryKey: BACKUP_OVERVIEW_QUERY_KEY });
    await Promise.all([
      qc.invalidateQueries({ queryKey: BACKUP_PLACES_QUERY_KEY }),
      qc.invalidateQueries({ queryKey: BACKUP_PAGE_NOTES_QUERY_KEY }),
      qc.invalidateQueries({ queryKey: BACKUP_SERVICE_STATUS_QUERY_KEY }),
      qc.invalidateQueries({ queryKey: BACKUP_CHECKPOINTS_QUERY_KEY }),
    ]);
  }, [qc]);
}
