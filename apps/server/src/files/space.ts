/**
 * A conversation's Files (docs/decisions/files-space.md FS-01…FS-08, FS-14…FS-19): which attachments are in it, who may
 * change them, and the listing and summary queries. Writes are commands (`files/space-commands.ts`), the endpoints are
 * in `files/space-routes.ts`.
 *
 * A file is in its conversation's Files when it is `ready`, wasn't taken out of Files (`files_removed_at`), and either
 * was saved into Files (`filed_at`: straight, or a message's file someone saved) or a person sent it on a live message
 * of that conversation (FS-02, FS-14). An agent's file on a message is in Files only once a person saved it (“Save to
 * Files”); agents themselves still reach it (FS-15). A file saved into Files and later sent on a message stays in Files
 * on its own account (FS-D01). A person's photo has no conversation and is never in Files.
 */
import type { FileEntry, FileRef } from '@whombat/core';
import { and, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { attachments, messages, principals } from '../db/schema/index';
import { type AttachmentRow, toAttachment } from './service';

/**
 * SQL: the attachment row `a` (aliased as the table) with its message `m` (left-joined on `a.message_id`) is in Files.
 * People see a message's file there when a person sent it or someone saved it (FS-14); agents (`forAgents`) also see the
 * files agents posted that nobody saved (FS-15), so their work stays within reach. Agents never see a website visitor's
 * screenshots (the files on a Whombat Feedback report's root message, FB-F3-12): the report's assessment and its handoff
 * get them as the dispatch's attachments, not through Files (FS-D02).
 */
export function inFiles(forAgents = false) {
  const live = sql`(${messages.id} is not null and ${messages.deletedAt} is null and ${messages.conversationId} = ${attachments.conversationId})`;
  const shared = forAgents
    ? live
    : sql`(${live} and exists (select 1 from ${principals} as uploader where uploader.id = ${attachments.uploadedById} and uploader.kind = 'person'))`;
  const visitor = forAgents
    ? sql` and (${messages.id} is null or ${messages.card} is null or ${messages.card}->>'kind' <> 'report')`
    : sql``;
  return sql`(${attachments.state} = 'ready' and ${attachments.filesRemovedAt} is null and ${attachments.conversationId} is not null and (${attachments.filedAt} is not null or ${shared})${visitor})`;
}

/**
 * Whether a message's file is in the person's Files (`Attachment.inFiles`, FS-14): the row-level half of `inFiles()` for a
 * file shown on its (live) message — a person's file unless removed from Files, an agent's only once saved.
 */
export function messageFileInFiles(
  file: Pick<AttachmentRow, 'state' | 'conversationId' | 'filesRemovedAt' | 'filedAt'>,
  uploaderKind: string | null | undefined,
): boolean {
  if (file.state !== 'ready' || file.conversationId === null || file.filesRemovedAt !== null) return false;
  return file.filedAt !== null || uploaderKind === 'person';
}

/** When a file came into Files: saved into Files, else its message was sent. */
export const addedAtSql = sql<Date>`coalesce(${attachments.filedAt}, ${messages.createdAt}, ${attachments.createdAt})`;

export interface FileRow {
  attachment: AttachmentRow;
  /** When it came into Files. */
  addedAt: Date;
  /** The thread its message is in (null: a top-level message or no message). */
  threadRootId: string | null;
}

/** A position in a listing (newest first): the last entry's time and id. */
export interface FilesCursor {
  at: Date;
  id: string;
}

export function encodeFilesCursor(c: FilesCursor): string {
  return Buffer.from(`${c.at.toISOString()}|${c.id}`, 'utf8').toString('base64url');
}

/** Null for anything that isn't a cursor this server wrote. */
export function decodeFilesCursor(value: string): FilesCursor | null {
  let text: string;
  try {
    text = Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const bar = text.indexOf('|');
  if (bar < 0) return null;
  const at = new Date(text.slice(0, bar));
  const id = text.slice(bar + 1);
  if (Number.isNaN(at.getTime()) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return { at, id };
}

function toFileRow(r: {
  attachment: AttachmentRow;
  addedAt: Date | string;
  threadRootId: string | null;
}): FileRow {
  return {
    attachment: r.attachment,
    addedAt: r.addedAt instanceof Date ? r.addedAt : new Date(r.addedAt),
    threadRootId: r.threadRootId,
  };
}

/**
 * The Files of one conversation, newest first (`limit` + 1 rows are read so the caller knows there are more). The
 * caller has checked who is asking (members only, FS-04; the dispatch's own conversation, FS-08).
 */
export async function listFileRows(
  db: Db,
  conversationId: string,
  options: { limit: number; cursor?: FilesCursor | null; forAgents?: boolean; folder?: string },
): Promise<{ rows: FileRow[]; more: boolean }> {
  const after = options.cursor
    ? sql`(${addedAtSql}, ${attachments.id}) < (${options.cursor.at.toISOString()}::timestamptz, ${options.cursor.id})`
    : sql`true`;
  // A folder and the folders in it, any letter case (FS-03).
  const folder = options.folder
    ? sql`(lower(${attachments.folder}) = lower(${options.folder}) or starts_with(lower(${attachments.folder}), lower(${options.folder}) || '/'))`
    : sql`true`;
  const found = await db
    .select({ attachment: attachments, addedAt: addedAtSql, threadRootId: messages.threadRootId })
    .from(attachments)
    .leftJoin(messages, eq(messages.id, attachments.messageId))
    .where(and(eq(attachments.conversationId, conversationId), inFiles(options.forAgents), after, folder))
    .orderBy(desc(addedAtSql), desc(attachments.id))
    .limit(options.limit + 1);
  const rows = found.slice(0, options.limit).map(toFileRow);
  return { rows, more: found.length > options.limit };
}

/** One file of a conversation's Files (any other id, or one no longer in Files: null). */
export async function fileRow(db: Db, attachmentId: string, forAgents = false): Promise<FileRow | null> {
  const [found] = await db
    .select({ attachment: attachments, addedAt: addedAtSql, threadRootId: messages.threadRootId })
    .from(attachments)
    .leftJoin(messages, eq(messages.id, attachments.messageId))
    .where(and(eq(attachments.id, attachmentId), inFiles(forAgents)));
  return found ? toFileRow(found) : null;
}

/** How many files and bytes a conversation's Files hold. */
export async function filesTotals(
  db: Db,
  conversationId: string,
  forAgents = false,
): Promise<{ count: number; bytes: number }> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      bytes: sql<string>`coalesce(sum(${attachments.size}), 0)::bigint`,
    })
    .from(attachments)
    .leftJoin(messages, eq(messages.id, attachments.messageId))
    .where(and(eq(attachments.conversationId, conversationId), inFiles(forAgents)));
  return { count: row?.count ?? 0, bytes: Number(row?.bytes ?? 0) };
}

export interface FilesSummaryRow {
  conversationId: string;
  count: number;
  bytes: number;
  lastAddedAt: Date;
}

/**
 * Per conversation of the burrow with at least one file in Files (FS-04, FS-07), newest activity first: every
 * conversation is the person's.
 */
export async function filesSummaryRows(db: Db, burrowId: string): Promise<FilesSummaryRow[]> {
  const rows = await db
    .select({
      conversationId: sql<string>`${attachments.conversationId}`,
      count: sql<number>`count(*)::int`,
      bytes: sql<string>`coalesce(sum(${attachments.size}), 0)::bigint`,
      lastAddedAt: sql<Date | string>`max(${addedAtSql})`,
    })
    .from(attachments)
    .leftJoin(messages, eq(messages.id, attachments.messageId))
    .where(and(eq(attachments.burrowId, burrowId), isNotNull(attachments.conversationId), inFiles()))
    .groupBy(attachments.conversationId)
    .orderBy(desc(sql`max(${addedAtSql})`), attachments.conversationId);
  return rows.map((r) => ({
    conversationId: r.conversationId,
    count: r.count,
    bytes: Number(r.bytes),
    lastAddedAt: r.lastAddedAt instanceof Date ? r.lastAddedAt : new Date(r.lastAddedAt),
  }));
}

/* Who may change what (FS-05) ------------------------------------------------------------------- */

export interface FilesViewer {
  id: string;
  kind: 'person' | 'agent';
}

export interface FileFacts {
  uploadedById: string;
  messageId: string | null;
  filedAt: Date | string | null;
  /** Who saved a message's file into Files (FS-16). */
  filedById?: string | null;
}

/**
 * The viewer may move a file to another folder or take it out of Files (FS-05): the person, whoever's file it is
 * (one-person.md OP-S07); never the agent.
 */
export function canTidyFile(_file: FileFacts, _conversationKind: string, viewer: FilesViewer): boolean {
  return viewer.kind === 'person';
}

/**
 * The viewer may rename a file (FS-05): only one saved straight into Files and on no message (a message's file keeps the
 * name it was sent with, FS-D01), by the person.
 */
export function canRenameFile(file: FileFacts, conversationKind: string, viewer: FilesViewer): boolean {
  return file.messageId === null && file.filedAt !== null && canTidyFile(file, conversationKind, viewer);
}

/**
 * Removing a file deletes it when it is only in Files (FS-06). A message's file stays on its message: a person's is
 * taken out of Files (`unlist`, `files_removed_at`); an agent's is only no longer saved (`unsave`, `filed_at` cleared,
 * FS-17), so agents still reach it as before it was saved.
 */
export function removalOf(
  file: Pick<FileFacts, 'messageId'>,
  uploaderKind?: string | null,
): 'delete' | 'unlist' | 'unsave' {
  if (file.messageId === null) return 'delete';
  return uploaderKind === 'agent' ? 'unsave' : 'unlist';
}

/* Folders (FS-03) ------------------------------------------------------------------------------- */

/**
 * The spelling a folder takes in a conversation: folders compare case-insensitively, so each leading part that matches
 * an existing folder (any letter case) keeps the spelling already there; the rest is as given. `''` stays `''`.
 */
export function canonicalFolder(target: string, existing: readonly string[]): string {
  if (!target) return '';
  const parts = target.split('/');
  const known = existing.filter(Boolean).map((f) => f.split('/'));
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const want = (parts[i] as string).toLowerCase();
    const match = known.find(
      (k) =>
        k.length > i &&
        (k[i] as string).toLowerCase() === want &&
        out.every((seg, j) => (k[j] as string) === seg),
    );
    out.push(match ? (match[i] as string) : (parts[i] as string));
  }
  return out.join('/');
}

/** The distinct folders of a conversation's Files (for `canonicalFolder`), leaving out one file (the one moving). */
export async function filesFolders(db: Db, conversationId: string, exceptId?: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ folder: attachments.folder })
    .from(attachments)
    .leftJoin(messages, eq(messages.id, attachments.messageId))
    .where(
      and(
        eq(attachments.conversationId, conversationId),
        inFiles(),
        sql`${attachments.folder} <> ''`,
        exceptId ? ne(attachments.id, exceptId) : undefined,
      ),
    );
  return rows.map((r) => r.folder).sort();
}

/* Entries --------------------------------------------------------------------------------------- */

/** A file in Files (`FileEntry`): the person moves and removes any, renames one on no message (FS-05). */
export function toFileEntry(file: FileRow): FileEntry {
  const a = file.attachment;
  return {
    attachment: toAttachment(a),
    conversationId: a.conversationId as string,
    folder: a.folder,
    uploadedById: a.uploadedById,
    addedAt: file.addedAt.toISOString(),
    messageId: a.messageId,
    threadRootId: a.messageId ? file.threadRootId : null,
  };
}

/** A file as a dispatch lists it (`DispatchFiles.entries`). */
export function toFileRef(file: FileRow): FileRef {
  const a = file.attachment;
  return {
    id: a.id,
    name: a.name,
    contentType: a.contentType,
    size: a.size,
    kind: a.kind,
    sha256: a.sha256 ?? '',
    folder: a.folder,
    messageId: a.messageId,
    addedAt: file.addedAt.toISOString(),
  };
}
