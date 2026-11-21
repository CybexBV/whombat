/**
 * What the runtime remembers about the box's own backups between its starts (`box_backup`, one row, migration 0038;
 * docs/decisions/backup-options.md): things the keep-the-place-right job still has to do or say. Read leniently (a
 * member that doesn't parse is left out), written only here through the commit pipeline.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '../db/client';
import { boxBackup } from '../db/schema/index';
import type { Services } from '../services';

const ROW = 1;
const Iso = z.string().max(40);
const Id = z.string().min(1).max(200);

/** The claim's “Let {assistant} set it up”: the person's yes, until the assistant set the backups up or couldn't. */
const Consent = z.object({
  at: Iso,
  accountId: Id,
  placeId: Id.nullable(),
  /** `waiting` for the AI and a place; `done`; `failed` (the Inbox asks again). */
  state: z.enum(['waiting', 'done', 'failed']),
});

/** Where to tell the person about the first backup to a place they said yes to: the thread they said it in. */
const FirstBackup = z.object({
  burrowId: Id,
  agentId: Id,
  conversationId: Id,
  threadRootId: Id.nullable(),
  /** As people call it (`BlackBox`). */
  place: z.string().max(200),
  /** Asked at; a backup that succeeded or failed after it is the first one. */
  since: Iso,
});

/** A “lost or stolen” restore: the place in use still needs a new password, so the old box can't add backups. */
const Rotate = z.object({
  since: Iso,
  tries: z.number().int().min(0),
  lastError: z.string().max(300).nullable(),
});

/**
 * A “lost or stolen” restore whose backups are on a place Whombat can't give a new password (set up by hand, or a
 * destination typed in): the person changes it there. Asked in the Inbox until a destination is set again.
 */
const ChangePassword = z.object({
  since: Iso,
  /** As people call the place (`BlackBox`, `192.168.1.40:8747`). */
  place: z.string().max(200).nullable(),
  /** Set up by hand: “Set it up by hand” again gives it a new password; else the person types the new one. */
  byHand: z.boolean(),
});

/** Backups left on the box's own disk to move to the place (part of the person's yes to it). */
const MoveLocal = z.object({ since: Iso, tries: z.number().int().min(0) });

/** The place in use answered that its backup app has no kit user (backup-passkey.md): the job gives it one. */
const PlaceKit = z.object({ since: Iso });

export const BoxBackupNotes = z.object({
  consent: Consent.optional(),
  firstBackup: FirstBackup.optional(),
  rotate: Rotate.optional(),
  changePassword: ChangePassword.optional(),
  moveLocal: MoveLocal.optional(),
  placeKit: PlaceKit.optional(),
  /** The restore (its `since`) whose “Your Whombat is back” push went out. */
  restorePushed: Iso.optional(),
  /** The restore whose assistant message was posted. */
  restoreSaid: Iso.optional(),
  /** The restore whose restart the manager took. */
  restartedFor: Iso.optional(),
});
export type BoxBackupNotes = z.infer<typeof BoxBackupNotes>;

/** Each member that parses (a newer runtime's member, or a damaged one, is left out). */
function lenient(raw: unknown): BoxBackupNotes {
  const out: Record<string, unknown> = {};
  const shape = BoxBackupNotes.shape;
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  for (const key of Object.keys(shape) as (keyof typeof shape)[]) {
    const parsed = shape[key].safeParse(obj[key]);
    if (parsed.success && parsed.data !== undefined) out[key] = parsed.data;
  }
  return out as BoxBackupNotes;
}

export async function loadBoxBackupNotes(db: Db | Tx): Promise<BoxBackupNotes> {
  const [row] = await db.select({ state: boxBackup.state }).from(boxBackup).where(eq(boxBackup.id, ROW));
  return lenient(row?.state);
}

/**
 * Changes the notes in one transaction (the row locked, so two changes never lose each other's); `change` returns the
 * new notes, or null to leave them. Returns what is kept now.
 */
export async function changeBoxBackupNotes(
  services: Services,
  change: (notes: BoxBackupNotes) => BoxBackupNotes | null,
): Promise<BoxBackupNotes> {
  return services.pipeline.transactAccount(async (tx) => {
    const [row] = await tx
      .select({ state: boxBackup.state })
      .from(boxBackup)
      .where(eq(boxBackup.id, ROW))
      .for('update');
    const before = lenient(row?.state);
    const next = change(before);
    if (!next) return before;
    const state = next as Record<string, unknown>;
    await tx
      .insert(boxBackup)
      .values({ id: ROW, state, updatedAt: services.clock() })
      .onConflictDoUpdate({ target: boxBackup.id, set: { state, updatedAt: services.clock() } });
    return next;
  });
}

/** `notes` without `key`. */
export function without<K extends keyof BoxBackupNotes>(notes: BoxBackupNotes, key: K): BoxBackupNotes {
  const { [key]: _gone, ...rest } = notes;
  return rest;
}
