/**
 * A person's profile: name and title (the sign-up name step, Settings → Profile). The account keeps them, so
 * a new burrow creates the person with them (`personFromAccount`). In every burrow the
 * account is in, the change is a burrow action by that person: a signed `member.updated` event, and
 * `person.updated` on the burrow topic so rosters, avatars and the sidebar footer follow at once.
 * Handles do not change (mentions keep working).
 */
import {
  AVATAR_MAX_BYTES,
  AVATAR_MAX_PIXELS,
  AVATAR_MIN_PIXELS,
  AVATAR_TYPES,
  initialsOf,
  newId,
  PersonName,
  PersonTitle,
  type ProfileResponse,
  type SetAvatarBody,
  topics,
  type UpdateProfileBody,
} from '@whombat/core';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { toAccount } from '../auth/service';
import { defineCommand } from '../commit/types';
import type { Tx } from '../db/client';
import { type AccountAvatar, accounts, principals, uploadReservations } from '../db/schema/index';
import { ensureChatWithAgent } from '../domain/the-agent';
import { AVATAR_CHANGES_PER_HOUR, AVATAR_REFUSALS, checkAvatar, replaceAvatar } from '../files/avatars';
import { UPLOAD_RATE_LOCK_CLASS } from '../files/commands';
import { lockBlob } from '../files/service';
import { blobKey, type StagedFile } from '../files/store';
import { ApiError, conflict, forbidden, notFound } from '../lib/errors';
import { loadPrincipalRow, toPerson } from '../read/principals';
import type { Services } from '../services';
import { burrowWhere } from './burrows';

/** The actor's own person row in this burrow. No key: the person changes their own name. */
export const updateMemberProfile = defineCommand({
  name: 'update_member_profile',
  schema: z.object({ name: PersonName.optional(), title: PersonTitle.optional() }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you have a profile.');
    const row = await loadPrincipalRow(tx, ctx.actor.id);
    if (!row) throw notFound('Person');
    const set: Partial<typeof principals.$inferInsert> = {};
    const texts: string[] = [];
    if (input.name !== undefined && input.name !== row.name) {
      set.name = input.name;
      set.initials = initialsOf(input.name);
      set.shortName = null;
      texts.push(`Changed their name from ${row.name} to ${input.name}`);
    }
    if (input.title !== undefined && input.title !== (row.title ?? '')) {
      set.title = input.title || null;
      texts.push(input.title ? `Changed their title to ${input.title}` : 'Removed their title');
    }
    if (texts.length === 0) return { principalId: row.id, changed: false };
    const [updated] = await tx.update(principals).set(set).where(eq(principals.id, row.id)).returning();
    if (!updated) throw notFound('Person');
    // Someone who just named themselves has their Chat with the agent (IN-26).
    if (set.name) await ensureChatWithAgent(ctx, updated);
    const event = await ctx.emit({
      type: 'member.updated',
      kind: 'System',
      text: texts.join('. '),
      where: burrowWhere(ctx.services, ctx.burrow.slug),
      aboutId: row.id,
      payload: { principalId: row.id, name: set.name ?? null, title: input.title ?? null },
    });
    ctx.publish(
      topics.burrow(ctx.burrow.id),
      { type: 'person.updated', person: toPerson(updated) },
      {
        eventId: event.id,
      },
    );
    return { principalId: row.id, changed: true };
  },
});

const Pixels = z.number().int().min(AVATAR_MIN_PIXELS).max(AVATAR_MAX_PIXELS);

/** The account's photo as a burrow command takes it: the blob and what the sniffer read, never the bytes. */
const AvatarInput = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  contentType: z.enum(AVATAR_TYPES),
  size: z.number().int().positive().max(AVATAR_MAX_BYTES),
  width: Pixels,
  height: Pixels,
});

/**
 * The actor's photo in this burrow (docs/decisions/person-avatars.md PVA-03): a new photo row, the old one deleted, a
 * signed `member.updated` (ids and the sha256, never bytes) and `person.updated`. The same photo again changes nothing
 * and signs nothing. No key: the person changes their own photo.
 */
export const setMemberAvatar = defineCommand({
  name: 'set_member_avatar',
  schema: z.object({ avatar: AvatarInput.nullable() }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you have a photo.');
    const row = await loadPrincipalRow(tx, ctx.actor.id);
    if (!row) throw notFound('Person');
    const changed = await replaceAvatar(ctx, row, input.avatar);
    if (!changed) return { principalId: row.id, changed: false };
    // The account's blob was stored just before; it can only be missing if something removed it since.
    if (input.avatar && !changed.next) throw conflict('Your photo couldn’t be saved. Try again.');
    const updated = await loadPrincipalRow(tx, row.id);
    if (!updated) throw notFound('Person');
    const event = await ctx.emit({
      type: 'member.updated',
      kind: 'System',
      text: changed.next ? 'Changed their photo' : 'Removed their photo',
      where: burrowWhere(ctx.services, ctx.burrow.slug),
      aboutId: row.id,
      payload: {
        principalId: row.id,
        avatar: changed.next
          ? {
              attachmentId: changed.next.id,
              sha256: changed.next.sha256 ?? '',
              contentType: changed.next.contentType,
              size: changed.next.size,
            }
          : null,
        previousAttachmentId: changed.previous?.id ?? null,
      },
    });
    ctx.publish(
      topics.burrow(ctx.burrow.id),
      { type: 'person.updated', person: toPerson(updated) },
      { eventId: event.id },
    );
    return { principalId: row.id, changed: true };
  },
});

/** The account's person rows, one per burrow, oldest first. */
function personRows(services: Services, accountId: string) {
  return services.db
    .select()
    .from(principals)
    .where(and(eq(principals.accountId, accountId), eq(principals.kind, 'person')))
    .orderBy(asc(principals.createdAt));
}

/**
 * At most `AVATAR_CHANGES_PER_HOUR` photo changes an hour per account (PVA-07), counted in `upload_reservations` under
 * `avatar:<account>` (pruned by the attachment sweep after the window), checked and recorded under the rate key's lock.
 */
async function recordAvatarChange(tx: Tx, accountId: string, now: Date) {
  const rateKey = `avatar:${accountId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(${UPLOAD_RATE_LOCK_CLASS}::int, hashtext(${rateKey}))`);
  const [recent] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(uploadReservations)
    .where(
      and(
        eq(uploadReservations.rateKey, rateKey),
        gt(uploadReservations.createdAt, new Date(now.getTime() - 3_600_000)),
      ),
    );
  if ((recent?.n ?? 0) >= AVATAR_CHANGES_PER_HOUR)
    throw new ApiError('rate_limited', 'You’ve changed your photo a lot in the last hour. Try again later.', {
      details: { limit: AVATAR_CHANGES_PER_HOUR, windowSeconds: 3600 },
    });
  // Account-wide, so no burrow (the column only says where an upload was reserved).
  await tx
    .insert(uploadReservations)
    .values({ id: newId('attachment'), burrowId: '', rateKey, createdAt: now });
}

/**
 * `PUT /me/avatar` (contracts CT-265; person-avatars.md PVA-01…PVA-05): the photo is checked and its bytes stored as a
 * blob, the account keeps it (account state, not signed), then the person in each burrow follows through the commit
 * pipeline, one burrow at a time, like `updateProfile`. `null` removes it everywhere.
 */
export async function setAvatar(
  services: Services,
  accountId: string,
  body: SetAvatarBody,
): Promise<ProfileResponse> {
  let photo: AccountAvatar | null = null;
  let staged: StagedFile | null = null;
  if (body.image !== null) {
    const checked = checkAvatar(body.image);
    if (!checked.ok)
      throw new ApiError('bad_request', AVATAR_REFUSALS[checked.reason], {
        details: { reason: checked.reason },
      });
    staged = await services.files.store.stage([checked.bytes], { maxBytes: AVATAR_MAX_BYTES });
    photo = {
      sha256: staged.sha256,
      contentType: checked.contentType,
      size: staged.size,
      width: checked.width,
      height: checked.height,
    };
  }
  let previous: AccountAvatar | null = null;
  try {
    previous = await services.pipeline.transactAccount(async (tx) => {
      const [row] = await tx.select().from(accounts).where(eq(accounts.id, accountId)).for('update');
      if (!row) throw notFound('Account');
      const same = (row.avatar?.sha256 ?? null) === (photo?.sha256 ?? null);
      if (!same) await recordAvatarChange(tx, accountId, services.clock());
      // Stored even when it is the same photo: the blob may be gone (an older binary's sweep after a rollback).
      if (staged && photo) {
        const key = blobKey(photo.sha256);
        await lockBlob(tx, key);
        await services.files.store.commit(staged, key);
        staged = null;
      }
      if (!same) await tx.update(accounts).set({ avatar: photo }).where(eq(accounts.id, accountId));
      return same ? null : (row.avatar ?? null);
    });
  } finally {
    if (staged) await services.files.store.discard(staged).catch(() => {});
  }
  // Every burrow, also when the account already had this photo: a person who lacks it gets it, the rest change nothing.
  for (const person of await personRows(services, accountId)) {
    await services.pipeline.commit(
      setMemberAvatar,
      { avatar: photo },
      {
        burrowId: person.burrowId,
        actorId: person.id,
      },
    );
  }
  // The old photo's bytes, once no burrow's row uses them (the burrow commands reclaim them too, PVA-08).
  if (previous) await services.files.removeIfUnused(blobKey(previous.sha256)).catch(() => false);
  const [account] = await services.db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) throw notFound('Account');
  return {
    account: toAccount(account),
    people: (await personRows(services, accountId)).map(toPerson),
  };
}

/**
 * `PATCH /me/profile`: the account first (account state, not signed), then the person in each burrow through
 * the commit pipeline, one burrow at a time.
 */
export async function updateProfile(
  services: Services,
  accountId: string,
  body: UpdateProfileBody,
): Promise<ProfileResponse> {
  const account = await services.pipeline.transactAccount(async (tx) => {
    const [row] = await tx
      .update(accounts)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
      })
      .where(eq(accounts.id, accountId))
      .returning();
    if (!row) throw notFound('Account');
    return row;
  });
  const persons = () =>
    services.db
      .select()
      .from(principals)
      .where(and(eq(principals.accountId, accountId), eq(principals.kind, 'person')))
      .orderBy(asc(principals.createdAt));
  for (const person of await persons()) {
    await services.pipeline.commit(updateMemberProfile, body, {
      burrowId: person.burrowId,
      actorId: person.id,
    });
  }
  return { account: toAccount(account), people: (await persons()).map(toPerson) };
}
