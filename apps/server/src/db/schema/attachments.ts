/**
 * Attachments (Workstream A, docs/decisions/bp-attachments.md): one row per upload, reserved for one
 * conversation by its uploader, `ready` once its bytes are stored, attached to at most one message. Bytes live
 * in the file store under their sha256 (`blob_key`); several rows may share a blob, never metadata.
 */
import type { AttachmentKind } from '@whombat/core';
import { index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { ts } from './common';

/** `deleted`: a file saved straight into Files and removed there (files-space.md FS-06); the sweep removes the row. */
export type AttachmentState = 'reserved' | 'ready' | 'deleted';

export const attachments = pgTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id').notNull(),
    /**
     * The conversation it was reserved for: it can only be sent there. Null for a person's photo
     * (docs/decisions/person-avatars.md PVA-02), which belongs to no conversation and is never sent.
     */
    conversationId: text('conversation_id'),
    /** Safe display name (never used as a storage path). */
    name: text('name').notNull(),
    /** What the client said the type was (a hint only). */
    declaredType: text('declared_type').notNull().default(''),
    /** Sniffed from the bytes (`application/octet-stream` until they arrive). */
    contentType: text('content_type').notNull(),
    kind: text('kind').$type<AttachmentKind>().notNull().default('file'),
    /** Reserved size; the exact stored size once ready. */
    size: integer('size').notNull(),
    sha256: text('sha256'),
    /** File-store key of the bytes (`sha256/ab/cd/<sha256>`), set when ready. */
    blobKey: text('blob_key'),
    width: integer('width'),
    height: integer('height'),
    /**
     * The thumbnail's size (`Attachment.thumbnailWidth`/`Height`, docs/decisions/review-features.md RF-04): set once the
     * image worker made one at upload (PNG and JPEG larger than `THUMBNAIL_MAX_EDGE`); null: none. Its bytes are the
     * derived preview of the blob (`files/previews.ts`), removed with it.
     */
    thumbnailWidth: integer('thumbnail_width'),
    thumbnailHeight: integer('thumbnail_height'),
    state: text('state').$type<AttachmentState>().notNull().default('reserved'),
    /** Stable relative API path (`Attachment.url`). */
    url: text('url').notNull(),
    uploadedById: text('uploaded_by_id').notNull(),
    messageId: text('message_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    uploadedAt: ts('uploaded_at'),
    /**
     * Its folder in the conversation's Files (docs/decisions/files-space.md FS-03): `''` (the top) or `A/B`, compared
     * case-insensitively.
     */
    folder: text('folder').notNull().default(''),
    /**
     * Saved into Files: straight, without a message (`files.save` of an upload; FS-02), or a message's file someone saved
     * (“Save to Files”, files-space.md FS-14; an agent's file is in the person's Files only then).
     */
    filedAt: ts('filed_at'),
    /** Who saved a message's file into Files (FS-16: they may tidy it); null otherwise. */
    filedById: text('filed_by'),
    /** Taken out of Files (FS-06): a message's file stays on its message, it is no longer listed in Files. */
    filesRemovedAt: ts('files_removed_at'),
    filesRemovedById: text('files_removed_by'),
  },
  (t) => [
    index('attachments_burrow_state_idx').on(t.burrowId, t.state),
    index('attachments_uploader_idx').on(t.uploadedById, t.createdAt),
    index('attachments_sha256_idx').on(t.sha256),
    index('attachments_message_idx').on(t.messageId),
    index('attachments_orphans_idx').on(t.state, t.createdAt),
    index('attachments_conversation_state_idx').on(t.conversationId, t.state),
  ],
);

/**
 * One row per upload reserved or artifact published, kept for the rate window even when the upload is discarded
 * (security review: reserve → discard loops were not counted). `rateKey` is `account:<id>` for people (every
 * principal of the account, any burrow) or `principal:<id>` for agents. Pruned by the attachment sweep.
 */
export const uploadReservations = pgTable(
  'upload_reservations',
  {
    /** The attachment it reserved. */
    id: text('id').primaryKey(),
    burrowId: text('burrow_id').notNull(),
    rateKey: text('rate_key').notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('upload_reservations_rate_idx').on(t.rateKey, t.createdAt)],
);
