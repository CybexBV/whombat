/**
 * Where a restore is, as the backup service answers `GET /v1/quarantine` (the protocol's `BackupRestoreState`), read the
 * same way by the session's ops, the Inbox and the push. Read tolerantly: a service that names `interrupted` as the
 * phase (the box restarted before the restore finished, and it was put back as it was) is a failed restore whose reason
 * is `interrupted` and which can be tried again; a reason this runtime can't carry is left out rather than making the
 * whole answer unreadable; and the service's technical `detail` never goes further than here (people read `error`).
 */
import {
  BACKUP_RESTORE_INTERRUPTED,
  BackupRestoreReason,
  BackupRestoreState,
} from '@whombat/protocol/session';
import { type BackupPort, READ } from './backup-port';

/** The service's answer as the app reads it; null when it isn't one. */
export function restoreStateOf(body: unknown): BackupRestoreState | null {
  if (!body || typeof body !== 'object') return null;
  const { detail: _technical, ...raw } = body as Record<string, unknown>;
  if (raw.phase === BACKUP_RESTORE_INTERRUPTED) {
    raw.phase = 'failed';
    raw.reason ??= BACKUP_RESTORE_INTERRUPTED;
  }
  if (raw.reason !== undefined && raw.reason !== null && !BackupRestoreReason.safeParse(raw.reason).success)
    delete raw.reason;
  const parsed = BackupRestoreState.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Where a restore is now; null when the service didn't answer one. */
export async function readRestoreState(port: BackupPort): Promise<BackupRestoreState | null> {
  const res = await port.call('GET', '/v1/quarantine', undefined, READ).catch(() => null);
  return res?.status === 200 ? restoreStateOf(res.body) : null;
}
