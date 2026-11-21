/**
 * Attachment writes through the commit pipeline (docs/decisions/bp-attachments.md): reserving an upload,
 * completing it once its bytes are staged, discarding it before it is sent, an agent publishing an artifact,
 * and attaching ready uploads to a message. Signed events carry ids, sizes, kinds and hashes only, never
 * file names or bytes (BP-06); they are hidden from the log like chat itself.
 */
import {
  ARTIFACT_MAX_BYTES,
  AttachmentId,
  AttachmentKind,
  attachmentUrl,
  ConversationId,
  formatFileSize,
  newId,
  SVG_IMAGE_MAX,
  safeDisplayName,
  UploadReserveBody,
} from '@whombat/core';
import { and, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Tx } from '../db/client';
import { attachments, messages, principals, uploadReservations } from '../db/schema/index';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { readAll } from './previews';
import { diskFull, filesRoom } from './room';
import { type AttachmentRow, lockBlob } from './service';
import { publishFilesChanged } from './space-commands';
import { blobKey } from './store';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const StagedToken = z.string().regex(/^[0-9a-f-]{36}$/);

/** What the sniffer decided (see sniff.ts). */
const SniffedFields = z.object({
  contentType: z.string().min(1).max(120),
  kind: AttachmentKind,
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});

/** Bytes waiting in the store's staging area (see store.ts). Never file bytes. */
const StagedFields = z.object({ token: StagedToken, size: z.number().int().positive(), sha256: Sha256 });

export function tooLarge(reason: 'file' | 'quota', limit: number): ApiError {
  return new ApiError(
    'too_large',
    reason === 'file'
      ? `That file is too big. Files can be up to ${formatFileSize(limit)}.`
      : `This Whombat has used all of its ${formatFileSize(limit)} for files. Ask whoever runs this Whombat to raise it.`,
    { details: { reason, limit } },
  );
}

/** A declared type as a short printable string (a hint we keep, never serve). */
function declared(type: string): string {
  return type.replace(/[^\x21-\x7e]/g, '').slice(0, 120);
}

/** Advisory lock class for an uploader's hourly count ("WHUR"): one account's reserves in several burrows. */
export const UPLOAD_RATE_LOCK_CLASS = 0x57485552;

/**
 * Per account (people: every principal of the account, in any burrow; agents: the agent) at most
 * `WHOMBAT_UPLOAD_RATE_PER_HOUR` uploads an hour when that is set (0, the default, is no hourly limit), and the files
 * within their room: a fixed quota when one is set, else the disk's (`room.ts`, docs/decisions/page-sets.md PG-19, PG-20). Returns the rate key the
 * caller records the reservation under.
 *
 * The count comes from `upload_reservations`, which a discard does not remove, so reserving and discarding in a
 * loop still counts (security review). The uploader's count is checked and recorded under an advisory lock on
 * its rate key (an account reserving in two burrows at once), and the quota under the burrow's lock, which the
 * commit pipeline holds for the whole command: concurrent reserves in one burrow are serialized, so together
 * they cannot go past the quota.
 */
async function checkLimits(tx: Tx, ctx: ApplyContext, size: number): Promise<string> {
  const config = ctx.services.config;
  const since = new Date(ctx.now.getTime() - 3_600_000);
  const [actor] = await tx
    .select({ accountId: principals.accountId })
    .from(principals)
    .where(eq(principals.id, ctx.actor.id));
  const rateKey = actor?.accountId ? `account:${actor.accountId}` : `principal:${ctx.actor.id}`;
  await tx.execute(sql`select pg_advisory_xact_lock(${UPLOAD_RATE_LOCK_CLASS}::int, hashtext(${rateKey}))`);
  const limit = config.WHOMBAT_UPLOAD_RATE_PER_HOUR;
  const [recent] = limit
    ? await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(uploadReservations)
        .where(and(eq(uploadReservations.rateKey, rateKey), gt(uploadReservations.createdAt, since)))
    : [];
  if (limit && (recent?.n ?? 0) >= limit)
    throw new ApiError(
      'rate_limited',
      'You’ve uploaded a lot of files in the last hour. Try again in a few minutes.',
      {
        details: { limit: config.WHOMBAT_UPLOAD_RATE_PER_HOUR, windowSeconds: 3600 },
      },
    );
  const room = await filesRoom(config, size, async () => {
    const [used] = await tx
      .select({ bytes: sql<number>`coalesce(sum(${attachments.size}), 0)::bigint` })
      .from(attachments)
      // A file removed from Files (`deleted`, files-space.md FS-06) no longer counts: its row only waits for the sweep.
      .where(and(eq(attachments.burrowId, ctx.burrow.id), ne(attachments.state, 'deleted')));
    return Number(used?.bytes ?? 0);
  });
  if (room === 'quota') throw tooLarge('quota', config.WHOMBAT_BURROW_QUOTA_BYTES ?? 0);
  if (room === 'disk') throw diskFull();
  return rateKey;
}

/** Records a reservation for the uploader's hourly count (kept when the upload is discarded). */
async function recordReservation(tx: Tx, ctx: ApplyContext, attachmentId: string, rateKey: string) {
  await tx
    .insert(uploadReservations)
    .values({ id: attachmentId, burrowId: ctx.burrow.id, rateKey, createdAt: ctx.now });
}

/** The conversation, if it is one of the actor's burrow; 404 otherwise (no probing for other burrows' ids). */
async function postableConversation(tx: Tx, ctx: ApplyContext, conversationId: string) {
  const conversation = await loadConversationRow(tx, conversationId);
  if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('Conversation');
  return conversation;
}

/** Moves staged bytes to their blob (under the blob's lock) and marks the row ready. */
async function storeBytes(
  tx: Tx,
  ctx: ApplyContext,
  row: Pick<AttachmentRow, 'id' | 'conversationId'>,
  staged: z.output<typeof StagedFields>,
  sniffed: z.output<typeof SniffedFields>,
): Promise<AttachmentRow> {
  const key = blobKey(staged.sha256);
  await lockBlob(tx, key);
  await ctx.services.files.store.commit(staged, key);
  const [updated] = await tx
    .update(attachments)
    .set({
      state: 'ready',
      size: staged.size,
      sha256: staged.sha256,
      blobKey: key,
      contentType: sniffed.contentType,
      kind: sniffed.kind,
      width: sniffed.width,
      height: sniffed.height,
      uploadedAt: ctx.now,
    })
    .where(eq(attachments.id, row.id))
    .returning();
  if (!updated) throw notFound('Upload');
  await ctx.emit({
    type: 'attachment.uploaded',
    kind: 'Messages',
    text: null,
    where: null,
    payload: {
      attachmentId: row.id,
      conversationId: row.conversationId,
      size: staged.size,
      sha256: staged.sha256,
      kind: sniffed.kind,
    },
  });
  return updated;
}

export const reserveUpload = defineCommand({
  name: 'reserve_upload',
  schema: UploadReserveBody,
  async apply(tx, ctx, input) {
    const conversation = await postableConversation(tx, ctx, input.conversationId);
    const max = ctx.services.files.maxBytes;
    if (input.size > max) throw tooLarge('file', max);
    const rateKey = await checkLimits(tx, ctx, input.size);
    const id = newId('attachment');
    await recordReservation(tx, ctx, id, rateKey);
    const [row] = await tx
      .insert(attachments)
      .values({
        id,
        burrowId: ctx.burrow.id,
        conversationId: conversation.id,
        name: safeDisplayName(input.name),
        declaredType: declared(input.contentType),
        contentType: 'application/octet-stream',
        size: input.size,
        state: 'reserved',
        url: attachmentUrl(ctx.burrow.slug, id),
        uploadedById: ctx.actor.id,
        createdAt: ctx.now,
      })
      .returning();
    if (!row) throw conflict('Could not reserve the upload.');
    return row;
  },
});

export const completeUpload = defineCommand({
  name: 'complete_upload',
  schema: z.object({ attachmentId: AttachmentId, staged: StagedFields, sniffed: SniffedFields }),
  async apply(tx, ctx, input) {
    const [row] = await tx
      .select()
      .from(attachments)
      .where(eq(attachments.id, input.attachmentId))
      .for('update');
    if (!row || row.burrowId !== ctx.burrow.id || row.uploadedById !== ctx.actor.id) throw notFound('Upload');
    if (row.state !== 'reserved') throw conflict('That file is already uploaded.');
    if (row.size !== input.staged.size) throw badRequest('The file’s size doesn’t match what was reserved.');
    return storeBytes(tx, ctx, row, input.staged, input.sniffed);
  },
});

export const discardUpload = defineCommand({
  name: 'discard_upload',
  schema: z.object({ attachmentId: AttachmentId }),
  async apply(tx, ctx, input) {
    const [row] = await tx
      .select()
      .from(attachments)
      .where(eq(attachments.id, input.attachmentId))
      .for('update');
    // A photo (no conversation) is not an upload: only `me.setAvatar` replaces or removes it (person-avatars.md PVA-02).
    if (
      !row ||
      row.burrowId !== ctx.burrow.id ||
      row.uploadedById !== ctx.actor.id ||
      row.conversationId === null
    )
      throw notFound('Upload');
    if (row.messageId) throw conflict('That file is on a message already.');
    // A file saved into Files is removed there (`files.remove`, files-space.md FS-06), not discarded as an upload.
    if (row.filedAt) throw conflict('That file is in Files. Remove it from Files instead.');
    await tx.delete(attachments).where(eq(attachments.id, row.id));
    const files = ctx.services.files;
    const key = row.blobKey;
    if (key)
      ctx.after(async () => {
        await files.removeIfUnused(key);
      });
    return { ok: true as const };
  },
});

/**
 * An agent's artifact (`upload_file`): reserved and stored in one step, for a conversation it may post in. It reaches
 * people's Files only when a person saves it from its message (files-space.md FS-14, FS-18; `saveToFiles` is gone).
 */
export const publishArtifact = defineCommand({
  name: 'publish_artifact',
  schema: z.object({
    conversationId: ConversationId,
    name: z.string().min(1).max(1000),
    declaredType: z.string().max(255).default(''),
    staged: StagedFields,
    sniffed: SniffedFields,
    /** An agent's file is up to `ARTIFACT_MAX_BYTES`; a page set it shows (docs/decisions/page-sets.md) up to any file's limit. */
    limit: z.enum(['artifact', 'pages']).default('artifact'),
  }),
  async apply(tx, ctx, input) {
    const conversation = await postableConversation(tx, ctx, input.conversationId);
    const max = Math.min(
      input.limit === 'pages' ? Number.POSITIVE_INFINITY : ARTIFACT_MAX_BYTES,
      ctx.services.files.maxBytes,
    );
    if (input.staged.size > max) throw tooLarge('file', max);
    const rateKey = await checkLimits(tx, ctx, input.staged.size);
    const id = newId('attachment');
    await recordReservation(tx, ctx, id, rateKey);
    await tx.insert(attachments).values({
      id,
      burrowId: ctx.burrow.id,
      conversationId: conversation.id,
      name: safeDisplayName(input.name),
      declaredType: declared(input.declaredType),
      contentType: 'application/octet-stream',
      size: input.staged.size,
      state: 'reserved',
      url: attachmentUrl(ctx.burrow.slug, id),
      uploadedById: ctx.actor.id,
      createdAt: ctx.now,
    });
    return storeBytes(tx, ctx, { id, conversationId: conversation.id }, input.staged, input.sniffed);
  },
});

/**
 * The actor's ready uploads for this conversation that are on no message yet, locked for the send; any other
 * id is refused with what is wrong with it.
 */
export async function claimAttachments(
  tx: Tx,
  ctx: ApplyContext,
  conversationId: string,
  ids: readonly string[],
): Promise<AttachmentRow[]> {
  const rows = await tx
    .select()
    .from(attachments)
    .where(inArray(attachments.id, [...ids]))
    .for('update');
  const byId = new Map(rows.map((r) => [r.id, r]));
  const claimed: AttachmentRow[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || row.burrowId !== ctx.burrow.id || row.uploadedById !== ctx.actor.id)
      throw badRequest('Unknown attachment.');
    if (row.conversationId !== conversationId)
      throw badRequest('That file was uploaded for another conversation.');
    if (row.state !== 'ready') throw badRequest('That file hasn’t finished uploading.');
    if (row.messageId) throw badRequest('That file is on a message already.');
    claimed.push(row);
  }
  return claimed;
}

/**
 * The text of the SVG files among claimed uploads, to find one an agent also wrote out as a drawing (messaging.md
 * MS-D01). Files larger than an SVG image may be (four UTF-8 bytes a character at most) are skipped: never drawn.
 */
export async function svgFileTexts(ctx: ApplyContext, rows: readonly AttachmentRow[]): Promise<string[]> {
  const texts: string[] = [];
  for (const row of rows) {
    if (row.contentType !== 'image/svg+xml' || !row.blobKey || row.size > 4 * SVG_IMAGE_MAX) continue;
    const bytes = await readAll(ctx.services.files.store, row.blobKey);
    if (bytes) texts.push(bytes.toString('utf8'));
  }
  return texts;
}

/**
 * Puts pictures Whombat drew onto a card's message (delegate.md DLG-27, council.md): linked to it and in its list of
 * files, in place of the ones they replace. A read shows only the files in that list (`loadMessages`), so a link alone
 * leaves the card's pictures empty. Only uploads of the message's own conversation.
 */
export async function putOnMessage(
  tx: Tx,
  ctx: ApplyContext,
  message: { id: string; conversationId: string },
  attachmentIds: readonly string[],
  replaced: readonly string[] = [],
): Promise<void> {
  if (!attachmentIds.length) return;
  const rows = await tx
    .select()
    .from(attachments)
    .where(
      and(
        inArray(attachments.id, [...attachmentIds]),
        eq(attachments.conversationId, message.conversationId),
      ),
    );
  if (!rows.length) return;
  const [row] = await tx
    .select({ attachmentIds: messages.attachmentIds })
    .from(messages)
    .where(eq(messages.id, message.id))
    .for('update');
  if (!row) return;
  const ids = rows.map((r) => r.id);
  const gone = new Set([...replaced, ...ids]);
  await tx
    .update(messages)
    .set({ attachmentIds: [...row.attachmentIds.filter((id) => !gone.has(id)), ...ids] })
    .where(eq(messages.id, message.id));
  await linkAttachments(tx, ctx, message.id, rows);
}

/** Links claimed uploads to their message and signs which bytes it carries (ids, sizes, hashes). */
export async function linkAttachments(
  tx: Tx,
  ctx: ApplyContext,
  messageId: string,
  rows: readonly AttachmentRow[],
): Promise<void> {
  if (!rows.length) return;
  await tx
    .update(attachments)
    .set({ messageId })
    .where(
      inArray(
        attachments.id,
        rows.map((r) => r.id),
      ),
    );
  const event = await ctx.emit({
    type: 'attachments.attached',
    kind: 'Messages',
    text: null,
    where: null,
    payload: {
      messageId,
      attachments: rows.map((r) => ({ id: r.id, size: r.size, sha256: r.sha256 ?? '', kind: r.kind })),
    },
  });
  // A person's files are in the conversation's Files now (files-space.md FS-01); an agent's only once someone saves
  // them (FS-14), unless one was saved before it was sent.
  const conversationId = rows[0]?.conversationId;
  if (conversationId && (ctx.actor.kind === 'person' || rows.some((r) => r.filedAt)))
    await publishFilesChanged(ctx, conversationId, { eventId: event.id });
}
