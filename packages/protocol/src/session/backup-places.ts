/**
 * Backup places over the session (Whombat backup-places.md): a NAS or server that keeps this Whombat's backups, owners
 * only. `backup.places` lists them; `backup.usePlace` sets one up and points the box's backups at it; a place Whombat
 * can't install itself is set up by hand (`backup.placeByHand` hands out the app to paste, `backup.placeCheck` sets it).
 */
import { BackupPlace } from '@whombat/core/domain';
import { z } from 'zod';

const PlaceId = z.string().min(3).max(300);

export const BackupPlacesInput = z.strictObject({});
export const BackupPlacesOutput = z.object({
  places: z.array(BackupPlace).max(100),
  /** The place that keeps this Whombat's backups now, when one does. */
  currentPlaceId: PlaceId.nullable(),
});

/**
 * `move`: needed while backups go somewhere other than this Whombat's own disk (the confirm said so). `location`: where
 * on the place (a `BackupPlaceLocation.id`); absent, the recommended one, or where they are now. On the place in use, a
 * new `location` moves them there.
 */
export const BackupUsePlaceInput = z.strictObject({
  placeId: PlaceId,
  move: z.boolean().optional(),
  location: z.string().min(1).max(200).optional(),
});
export const BackupUsePlaceOutput = z.object({
  placeId: PlaceId,
  /** Where backups go now, as people read it (`BlackBox`). */
  destination: z.string().max(200),
  /** Where on it, as people read it (`the share whombat-backups`), when the place has a choice. */
  locationName: z.string().max(200).nullable().default(null),
  appendOnly: z.enum(['verified', 'not-enforced', 'unknown']),
  /** The first backup was started. */
  firstBackup: z.boolean(),
});

export const BackupPlaceByHandInput = z.strictObject({ placeId: PlaceId });
export const BackupPlaceByHandOutput = z.object({
  /** The compose file to paste; it holds the user's bcrypt line, never the password. */
  compose: z.string().max(20_000),
  steps: z.array(z.string().max(500)).max(12),
  /** Until when “Check it” can set it (the password waits on the server). */
  expiresAt: z.string().max(40),
});

export const BackupPlaceCheckInput = z.strictObject({ placeId: PlaceId, move: z.boolean().optional() });
export const BackupPlaceCheckOutput = BackupUsePlaceOutput;

/** Removes the backup app of a place not in use; `deleteData` also removes the backups it kept. */
export const BackupForgetPlaceInput = z.strictObject({
  placeId: PlaceId,
  deleteData: z.boolean().optional(),
});
export const BackupForgetPlaceOutput = z.object({ ok: z.literal(true) });
