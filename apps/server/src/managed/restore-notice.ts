/**
 * “Your Whombat is back. Open it to finish.” (docs/decisions/backup-options.md): after a bring back the runtime comes
 * back quarantined and waits for the person's one answer, while the app that started it may be closed. Once per
 * restore (its `since`, kept in `box_backup`), a `backup` push tells the person — the one push a quarantined box sends —
 * and its tap opens where the app finishes. Checked every half minute while quarantined; nothing otherwise.
 */
import { changeBoxBackupNotes, loadBoxBackupNotes } from '../backup-places/notes';
import { personAccountId } from '../read/principals';
import type { Services } from '../services';
import type { BackupPort } from './backup-port';
import type { ControlPush } from './push';
import { readRestoreState } from './restore-state';
import { RESTORE_DONE_NOTICE } from './security-push';

/** How often a quarantined box looks whether its restore waits for the person. */
export const RESTORE_NOTICE_EVERY_MS = 30_000;

/** Tells the person once that the restore is done; `told`, `none` (nothing waits, or told already). */
export async function tellRestoreDone(
  services: Services,
  port: BackupPort,
  push: Pick<ControlPush, 'notice'>,
): Promise<'told' | 'none'> {
  if (!services.maintenance.quarantined) return 'none';
  const state = await readRestoreState(port);
  if (state?.phase !== 'checking') return 'none';
  const since = state.since ?? 'unknown';
  if ((await loadBoxBackupNotes(services.db)).restorePushed === since) return 'none';
  const account = await personAccountId(services.db);
  if (!account) return 'none';
  // Noted first: a push that went out twice would be worse than one lost (the Inbox item says it too).
  await changeBoxBackupNotes(services, (n) => ({ ...n, restorePushed: since }));
  await push.notice('backup', [account], `restore-done:${since}`, RESTORE_DONE_NOTICE, {
    evenInQuarantine: true,
  });
  return 'told';
}

/** Starts looking (a box with a backup service); returns the way to stop. */
export function startRestoreNotice(
  services: Services,
  port: BackupPort,
  push: Pick<ControlPush, 'notice'>,
  everyMs = RESTORE_NOTICE_EVERY_MS,
): () => void {
  let going = false;
  const tick = () => {
    if (going || !services.maintenance.quarantined) return;
    going = true;
    void tellRestoreDone(services, port, push)
      .catch((err: unknown) =>
        services.log.warn({ err: String(err) }, 'backup restore: the person wasn’t told it is back'),
      )
      .finally(() => {
        going = false;
      });
  };
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
