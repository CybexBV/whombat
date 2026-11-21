/**
 * A person's photo (docs/decisions/person-avatars.md PVA-01…PVA-12; contracts CT-265): the checks a photo passes, and
 * the attachment row a person's photo is in each burrow. A photo is an ordinary ready image attachment with no
 * conversation and no message (PVA-02), so clients load it like any image attachment (HTTP or the session's resource
 * streams, both through `readableAttachment`), and its bytes are a blob in the file store like every upload's.
 */
import {
  AVATAR_MAX_BYTES,
  AVATAR_MAX_PIXELS,
  AVATAR_MIN_PIXELS,
  AVATAR_TYPES,
  attachmentUrl,
  formatFileSize,
  newId,
} from '@whombat/core';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { ApplyContext } from '../commit/types';
import type { Db } from '../db/client';
import { type AccountAvatar, attachments, principals } from '../db/schema/index';
import { type AttachmentRow, lockBlob } from './service';
import { sniffBuffer } from './sniff';
import { blobKey } from './store';

/** Photo changes an account may make in an hour (PVA-07): setting and removing count, the same photo again doesn't. */
export const AVATAR_CHANGES_PER_HOUR = 10;

/** Why a photo is refused, in words people read (PVA-05). */
export type AvatarRefusal = 'empty' | 'too_big' | 'type' | 'damaged' | 'too_small' | 'too_large';

export const AVATAR_REFUSALS: Record<AvatarRefusal, string> = {
  empty: 'Choose a photo.',
  too_big: `That photo is too big. Photos can be up to ${formatFileSize(AVATAR_MAX_BYTES)}.`,
  type: 'Choose a JPEG, PNG or WebP photo.',
  damaged: 'That photo is damaged, or isn’t an image we can show.',
  too_small: `That photo is too small. Choose one at least ${AVATAR_MIN_PIXELS} × ${AVATAR_MIN_PIXELS} pixels.`,
  too_large: `That photo is too large. Photos can be up to ${AVATAR_MAX_PIXELS} × ${AVATAR_MAX_PIXELS} pixels.`,
};

export type CheckedAvatar =
  | { ok: true; bytes: Buffer; contentType: (typeof AVATAR_TYPES)[number]; width: number; height: number }
  | { ok: false; reason: AvatarRefusal };

/**
 * A photo from `me.setAvatar`'s base64 (PVA-05): at most `AVATAR_MAX_BYTES` decoded, sniffed from its bytes as a JPEG,
 * PNG or WebP image (never SVG or GIF: the name it is sniffed under has no extension, so text never passes), each
 * side `AVATAR_MIN_PIXELS`…`AVATAR_MAX_PIXELS`. Pure.
 */
export function checkAvatar(base64: string): CheckedAvatar {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > AVATAR_MAX_BYTES) return { ok: false, reason: 'too_big' };
  const sniffed = sniffBuffer(bytes, 'photo');
  if (!sniffed.ok)
    return { ok: false, reason: sniffed.reason === 'image_too_large' ? 'too_large' : 'damaged' };
  const { contentType, kind, width, height } = sniffed.value;
  const type = AVATAR_TYPES.find((t) => t === contentType);
  if (kind !== 'image' || !type) return { ok: false, reason: 'type' };
  if (!width || !height) return { ok: false, reason: 'damaged' };
  if (width < AVATAR_MIN_PIXELS || height < AVATAR_MIN_PIXELS) return { ok: false, reason: 'too_small' };
  if (width > AVATAR_MAX_PIXELS || height > AVATAR_MAX_PIXELS) return { ok: false, reason: 'too_large' };
  return { ok: true, bytes, contentType: type, width, height };
}

/** The display name a photo's row has (`photo.jpg`): never a name a person chose. */
export function avatarName(contentType: string): string {
  return contentType === 'image/png'
    ? 'photo.png'
    : contentType === 'image/webp'
      ? 'photo.webp'
      : 'photo.jpg';
}

/**
 * A ready photo row for `personId` in this burrow, its bytes the account's blob (PVA-02, PVA-03). Null when the blob
 * isn't in the store (an older binary's sweep took it after a rollback): the person keeps the initials. Under the
 * blob's lock, so the sweep can't delete the bytes between the check and the row.
 */
export async function insertAvatarRow(
  ctx: Pick<ApplyContext, 'tx' | 'services' | 'burrow' | 'now'>,
  personId: string,
  avatar: AccountAvatar,
): Promise<AttachmentRow | null> {
  const key = blobKey(avatar.sha256);
  await lockBlob(ctx.tx, key);
  if ((await ctx.services.files.store.size(key)) === null) return null;
  const id = newId('attachment');
  const [row] = await ctx.tx
    .insert(attachments)
    .values({
      id,
      burrowId: ctx.burrow.id,
      conversationId: null,
      name: avatarName(avatar.contentType),
      declaredType: avatar.contentType,
      contentType: avatar.contentType,
      kind: 'image',
      size: avatar.size,
      sha256: avatar.sha256,
      blobKey: key,
      width: avatar.width,
      height: avatar.height,
      state: 'ready',
      url: attachmentUrl(ctx.burrow.slug, id),
      uploadedById: personId,
      messageId: null,
      createdAt: ctx.now,
      uploadedAt: ctx.now,
    })
    .returning();
  return row ?? null;
}

/** The person's current photo row, if any. */
export async function currentAvatarRow(
  tx: Db,
  person: { avatarAttachmentId: string | null },
): Promise<AttachmentRow | null> {
  if (!person.avatarAttachmentId) return null;
  const [row] = await tx.select().from(attachments).where(eq(attachments.id, person.avatarAttachmentId));
  return row ?? null;
}

/**
 * Points the person at the account's photo (or none) in this burrow: a new row when the bytes differ, the old row
 * deleted (its blob reclaimed after the commit when nothing else uses it). Returns what changed, or null when the
 * person already shows that photo. Writes only; the caller signs and publishes.
 */
export async function replaceAvatar(
  ctx: Pick<ApplyContext, 'tx' | 'services' | 'burrow' | 'now' | 'after'>,
  person: { id: string; avatarAttachmentId: string | null },
  avatar: AccountAvatar | null,
): Promise<{ next: AttachmentRow | null; previous: AttachmentRow | null } | null> {
  const previous = await currentAvatarRow(ctx.tx, person);
  if ((previous?.sha256 ?? null) === (avatar?.sha256 ?? null)) return null;
  const next = avatar ? await insertAvatarRow(ctx, person.id, avatar) : null;
  if (avatar && !next && !previous) return null;
  await ctx.tx
    .update(principals)
    .set({ avatarAttachmentId: next?.id ?? null, avatarUrl: next?.url ?? null })
    .where(eq(principals.id, person.id));
  if (previous) {
    await ctx.tx.delete(attachments).where(eq(attachments.id, previous.id));
    const key = previous.blobKey;
    const files = ctx.services.files;
    if (key)
      ctx.after(async () => {
        await files.removeIfUnused(key);
      });
  }
  return { next, previous };
}

/** Whether the attachment is the photo of someone in this burrow (PVA-06: anyone in the burrow may read it). */
export async function isBurrowAvatar(db: Db, burrowId: string, attachmentId: string): Promise<boolean> {
  const [hit] = await db
    .select({ id: principals.id })
    .from(principals)
    .where(
      and(
        eq(principals.burrowId, burrowId),
        isNotNull(principals.avatarAttachmentId),
        eq(principals.avatarAttachmentId, attachmentId),
      ),
    )
    .limit(1);
  return Boolean(hit);
}
