/**
 * The copy somewhere else in React (Whombat offsite-copy.md): what the box says of its second place rides in the backup
 * summary (`summary.offsite`, read with the Backups page's overview), so this only changes it — set up, removed, copied
 * now — and reads the page again after. A box from before has no `summary.offsite`: the page doesn't offer it.
 */
import { useMutation } from '@tanstack/react-query';
import type { BackupSetOffsiteInput } from '@whombat/protocol/session';
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
