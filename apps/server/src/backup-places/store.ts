/**
 * The place records (`backup_places`, docs/decisions/backup-places.md): read anywhere, written only here, through the
 * commit pipeline. A by-hand place's REST password waits sealed with key custody (`backup_place:<id>:pending`) until
 * “Check it” uses it or a day passes.
 */
import { eq } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { type BackupPlaceRow, backupPlaces } from '../db/schema/index';
import type { KeyCustody } from '../keys/custody';
import type { Services } from '../services';

export type { BackupPlaceRow };

export async function loadPlaceRows(db: Db | Tx): Promise<BackupPlaceRow[]> {
  return db.select().from(backupPlaces);
}

export async function loadPlaceRow(db: Db | Tx, id: string): Promise<BackupPlaceRow | null> {
  const [row] = await db.select().from(backupPlaces).where(eq(backupPlaces.id, id));
  return row ?? null;
}

/** The fields a place record is written with (the rest keep what they had). */
export type PlaceRowChange = Partial<Omit<BackupPlaceRow, 'id' | 'createdAt' | 'updatedAt'>> &
  Pick<BackupPlaceRow, 'kind' | 'name' | 'client'>;

/** Writes a place's record (made the first time). */
export async function savePlaceRow(services: Services, id: string, change: PlaceRowChange): Promise<void> {
  const now = services.clock();
  await services.pipeline.transactAccount(async (tx) => {
    await tx
      .insert(backupPlaces)
      .values({ ...change, id, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: backupPlaces.id, set: { ...change, updatedAt: now } });
  });
}

/** Changes fields of a record that is there. */
export async function updatePlaceRow(
  services: Services,
  id: string,
  change: Partial<Omit<BackupPlaceRow, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<void> {
  await services.pipeline.transactAccount(async (tx) => {
    await tx
      .update(backupPlaces)
      .set({ ...change, updatedAt: services.clock() })
      .where(eq(backupPlaces.id, id));
  });
}

export async function deletePlaceRow(services: Services, id: string): Promise<void> {
  await services.pipeline.transactAccount(async (tx) => {
    await tx.delete(backupPlaces).where(eq(backupPlaces.id, id));
  });
}

export const pendingAad = (id: string) => `backup_place:${id}:pending`;

export function sealPending(custody: KeyCustody, id: string, password: string): string {
  return custody.seal(pendingAad(id), password);
}

/** The waiting password, or null when there is none or it is older than a day. */
export function openPending(custody: KeyCustody, row: BackupPlaceRow, now: Date): string | null {
  if (!row.pendingPasswordEnc || !row.pendingUntil || row.pendingUntil.getTime() <= now.getTime())
    return null;
  return custody.open(pendingAad(row.id), row.pendingPasswordEnc);
}
