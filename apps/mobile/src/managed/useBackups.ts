/**
 * What the phone's backup screens read (backup-options-android.md AP-6850, AP-6864): the session to ask — the Whombat's,
 * or the demo world's in-memory box (`fixtures/backupOptions.ts`) — the backup service's status and the place's name.
 */
import { useBackupPlaces, useBackupServiceStatus } from '@whombat/client/react';
import type { ApplianceSession } from '@whombat/client/session';
import { useBurrowBase } from '../data/BurrowProvider';
import { demoBackups } from '../fixtures/backupOptions';
import { useManaged } from './context';

/** The session the backup screens ask: the Whombat's, the demo's box, or none. */
export function useBackupSession(): ApplianceSession | null {
  const managed = useManaged();
  const { mode } = useBurrowBase();
  if (managed) return managed.session;
  return mode === 'fixtures' ? demoBackups().session() : null;
}

/**
 * `backup.status`: the service's document (when, where, the last check, the kit's generation), from the Backups page's
 * one overview like the web's.
 */
export { useBackupServiceStatus } from '@whombat/client/react';

/** The place that keeps the backups by its name (“BlackBox”), else the destination as the service shows it. */
export function useBackupPlaceName(session: ApplianceSession | null): string | null {
  const places = useBackupPlaces(session);
  const status = useBackupServiceStatus(session);
  const list = places.data;
  const current = list?.currentPlaceId ? list.places.find((p) => p.id === list.currentPlaceId) : null;
  return current?.name ?? status.data?.status?.destination.display ?? null;
}
