/**
 * The copy somewhere else in React (Whombat offsite-copy.md): what the box says of its second place rides in the backup
 * summary (`summary.offsite`, read with the Backups page's overview), so this only changes it — set up, removed, copied
 * now — and reads the page again after. A box from before has no `summary.offsite`: the page doesn't offer it.
 */
import { useMutation } from '@tanstack/react-query';
import type { BackupOffsiteState, BackupSetOffsiteInput } from '@whombat/protocol/session';
import { useEffect } from 'react';
import type { z } from 'zod';
import { sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import { useReloadBackupOptions } from './backupOptions';

export function useBackupOffsiteActions(session: ApplianceSession | null | undefined) {
  const reload = useReloadBackupOptions();
  const set = useMutation({
    mutationFn: (input: z.input<typeof BackupSetOffsiteInput>) =>
      sessionOps.backupSetOffsite(session as ApplianceSession, input),
    onSuccess: () => reload(),
  });
  const remove = useMutation({
    mutationFn: () => sessionOps.backupRemoveOffsite(session as ApplianceSession),
    onSettled: () => reload(),
  });
  const copyNow = useMutation({
    mutationFn: () => sessionOps.backupCopyOffsite(session as ApplianceSession),
    onSettled: () => reload(),
  });
  return { set, remove, copyNow };
}

/** How often the page reads Backups again while a copy runs: the box re-reads the copy's state once a minute too. */
export const OFFSITE_FOLLOW_MS = 60_000;

/** While a copy runs (or the first one is on its way) the page reads Backups again now and then, to say when it's done. */
export function useFollowOffsiteCopy(state: BackupOffsiteState | null | undefined): void {
  const reload = useReloadBackupOptions();
  useEffect(() => {
    if (state !== 'first' && state !== 'copying') return;
    const timer = setInterval(() => void reload(), OFFSITE_FOLLOW_MS);
    return () => clearInterval(timer);
  }, [reload, state]);
}
