/**
 * Files: one shared file space per conversation (Whombat `docs/decisions/files-space.md` FS-01…FS-13, contracts 0.49.0,
 * CT-274…CT-279; FS-14…, 0.59, CT-312).
 *
 * A conversation's Files hold every ready file a person sent on a live message there that wasn't removed from Files,
 * the files of messages someone saved (“Save to Files”; an agent's file is in Files only then), and the files saved
 * straight into Files without a message (`files.save` of a ready, unsent upload). Who may see a file is
 * who may read the conversation now; every other conversation or file is “not found”. A file sits in a folder: a path
 * on the file (`FilesFolder`), so a folder exists while a file is in it. Writes go through the commit pipeline and emit
 * `files.changed {conversationId}` to the conversation's members. Feature `files.space`.
 */
import { z } from 'zod';
import { Count, Cursor, Timestamp } from '../domain/common.js';
import { Attachment, AttachmentKind } from '../domain/message.js';
import { AttachmentId, ConversationId, MessageId, PrincipalId } from '../ids.js';
import { ATTACHMENT_NAME_MAX, unsafeNameChar } from './attachments.js';
import { BurrowParam, endpoint, limitQuery } from './endpoint.js';
import { OkResponse } from './errors.js';

/* Folders (FS-03) ---------------------------------------------------------------------------------- */

/** Most segments a folder path has (`A/B/C/D`). */
export const FILES_FOLDER_DEPTH_MAX = 4;
/** Most characters (code points) in one folder segment. */
export const FILES_FOLDER_SEGMENT_MAX = 64;
/** Longest folder path: four full segments and three slashes. */
export const FILES_FOLDER_MAX =
  FILES_FOLDER_DEPTH_MAX * FILES_FOLDER_SEGMENT_MAX + FILES_FOLDER_DEPTH_MAX - 1;

/**
 * The folder a person typed or picked, normalized, or null when it can't be one (FS-03). `''` is the top.
 *
 * Segments are split on `/`; blank segments are dropped, so `/Drawings/`, `Drawings//2024` and `  ` are fine. Each
 * segment follows `safeDisplayName`'s rules: NFC, whitespace collapsed to one space, control, bidi and zero-width
 * characters dropped, no leading dots or spaces. Null for a segment that is `.` or `..`, holds a `\`, ends up empty or
 * longer than `FILES_FOLDER_SEGMENT_MAX`, and for more than `FILES_FOLDER_DEPTH_MAX` segments. Case is kept; compare
 * folders with `filesFolderKey`. Idempotent: a normalized folder normalizes to itself.
 */
export function normalizeFilesFolder(raw: string): string | null {
  const segments: string[] = [];
  for (const part of raw.normalize('NFC').split('/')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed === '.' || trimmed === '..' || trimmed.includes('\\')) return null;
    const segment = [...trimmed]
      .map((c) => (/\s/.test(c) ? ' ' : unsafeNameChar(c.codePointAt(0) ?? 0) ? '' : c))
      .join('')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+/, '')
      .trim();
    if (!segment || [...segment].length > FILES_FOLDER_SEGMENT_MAX) return null;
    segments.push(segment);
  }
  if (segments.length > FILES_FOLDER_DEPTH_MAX) return null;
  return segments.join('/');
}

/** A folder as it travels: `''` (the top) or `A/B`, already normalized (`normalizeFilesFolder` gives it back as is). */
export const FilesFolder = z
  .string()
  .max(FILES_FOLDER_MAX)
  .refine(
    (v) => normalizeFilesFolder(v) === v,
    'Folder names are up to 4 levels of 1–64 characters, without . or ..',
  );
export type FilesFolder = z.infer<typeof FilesFolder>;

/** The key folders compare by (case-insensitive, FS-03): two files whose keys match are in the same folder. */
export function filesFolderKey(folder: string): string {
  return folder.toLowerCase();
}

/** Whether two normalized folders are the same folder (case-insensitive). */
export function sameFilesFolder(a: string, b: string): boolean {
  return filesFolderKey(a) === filesFolderKey(b);
}

/* Entries ------------------------------------------------------------------------------------------ */

/**
 * One file in a conversation's Files, as the viewer may act on it. `messageId` null: saved straight into Files
 * (`files.save`). `threadRootId` is the message's thread
 * root when it is a reply (“Open message” opens the thread), null otherwise. FS-05 for one person (3.0, CT-1586): every
 * file can be moved and removed; only one saved straight into Files (`messageId` null) can be renamed. The `can*` flags
 * went.
 */
export const FileEntry = z.object({
  attachment: Attachment,
  conversationId: ConversationId,
  folder: FilesFolder,
  uploadedById: PrincipalId,
  /** When it came into Files: the message's time, or when it was saved. Lists are newest first by this. */
  addedAt: Timestamp,
  messageId: MessageId.nullable(),
  threadRootId: MessageId.nullable(),
});
export type FileEntry = z.infer<typeof FileEntry>;

/** One conversation in `files.summary`: the viewer is a member of it now and it holds at least one file. */
export const FilesSummaryEntry = z.object({
  conversationId: ConversationId,
  count: Count,
  bytes: Count,
  lastAddedAt: Timestamp,
});
export type FilesSummaryEntry = z.infer<typeof FilesSummaryEntry>;

/** `files.summary`: newest activity first. Empty: no Files in the sidebar (FS-07). */
export const FilesSummaryResponse = z.object({ conversations: z.array(FilesSummaryEntry) });
export type FilesSummaryResponse = z.infer<typeof FilesSummaryResponse>;

/** Most files one `files.list` page holds, and the default. */
export const FILES_LIST_MAX = 200;
export const FILES_LIST_DEFAULT = 100;

export const FilesListQuery = z.object({
  cursor: Cursor.optional(),
  limit: limitQuery(FILES_LIST_DEFAULT, FILES_LIST_MAX),
});
export type FilesListQuery = z.infer<typeof FilesListQuery>;

/** `files.list`: one page, newest first, every folder (clients group). `nextCursor` null on the last page. */
export const FilesListResponse = z.object({
  files: z.array(FileEntry).max(FILES_LIST_MAX),
  nextCursor: Cursor.nullable(),
});
export type FilesListResponse = z.infer<typeof FilesListResponse>;

/**
 * `files.save`: a ready, unsent upload of the caller (`uploads.create` for that conversation) goes into Files; since
 * 0.59 (CT-312, feature `files.save_from_messages`) also a file on a live message of a conversation the caller is in
 * (“Save to Files” in the chat; people only): an agent's file comes into Files, a file removed from Files comes back.
 * A file already in Files is answered as it is.
 */
export const SaveFileBody = z.object({
  attachmentId: AttachmentId,
  folder: FilesFolder.default(''),
});
export type SaveFileBody = z.infer<typeof SaveFileBody>;

/**
 * `files.update`: rename (files saved straight into Files only; the runtime applies `safeDisplayName`) and/or move to a
 * folder. At least one of the two.
 */
export const UpdateFileBody = z
  .object({
    name: z.string().trim().min(1).max(ATTACHMENT_NAME_MAX).optional(),
    folder: FilesFolder.optional(),
  })
  .refine((b) => b.name !== undefined || b.folder !== undefined, 'Change the name or the folder.');
export type UpdateFileBody = z.infer<typeof UpdateFileBody>;

export const FileResponse = z.object({ file: FileEntry });
export type FileResponse = z.infer<typeof FileResponse>;

const B = z.object({ burrow: BurrowParam });

export const filesEndpoints = {
  summary: endpoint({
    id: 'files.summary',
    method: 'GET',
    path: '/burrows/:burrow/files',
    summary: 'The conversations that hold at least one file, newest activity first: “Files” in the sidebar.',
    params: B,
    response: FilesSummaryResponse,
  }),
  list: endpoint({
    id: 'files.list',
    method: 'GET',
    path: '/burrows/:burrow/conversations/:conversationId/files',
    summary: 'One conversation’s Files, newest first, every folder.',
    params: B.extend({ conversationId: ConversationId }),
    query: FilesListQuery,
    response: FilesListResponse,
  }),
  save: endpoint({
    id: 'files.save',
    method: 'POST',
    path: '/burrows/:burrow/files',
    summary:
      'Put a ready, unsent upload of yours into its conversation’s Files, in a folder, without a message; or (0.59) a file on a message of a conversation you are in: “Save to Files”.',
    params: B,
    body: SaveFileBody,
    response: FileResponse,
  }),
  update: endpoint({
    id: 'files.update',
    method: 'PATCH',
    path: '/burrows/:burrow/files/:attachmentId',
    summary: 'Rename a file saved straight into Files, or move a file to another folder.',
    params: B.extend({ attachmentId: AttachmentId }),
    body: UpdateFileBody,
    response: FileResponse,
  }),
  remove: endpoint({
    id: 'files.remove',
    method: 'DELETE',
    path: '/burrows/:burrow/files/:attachmentId',
    summary:
      'Remove from Files: a file saved straight into Files is deleted; a message’s file only leaves Files (the message keeps it, with “Save to Files” again).',
    params: B.extend({ attachmentId: AttachmentId }),
    response: OkResponse,
  }),
};

/* Agents (FS-08…FS-11) ----------------------------------------------------------------------------- */

/** Most files a dispatch lists (`DispatchFiles.entries`), newest first. */
export const FILES_DISPATCH_MAX = 500;
/** Largest file a turn copies for its commands or into a scratch folder (FS-09). */
export const FILES_TURN_FILE_MAX_BYTES = 250 * 1024 * 1024;
/** Most bytes a turn copies in total, newest files first (FS-09). */
export const FILES_TURN_TOTAL_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Where a turn's commands find the conversation's Files, read-only: `~/files` (`files/` in a scratch folder). */
export const FILES_HOME_LINK = 'files';

/** One file of the dispatch's conversation the runner may fetch (`ATTACHMENT_TRANSFER.runnerFetch`). */
export const FileRef = z.object({
  id: AttachmentId,
  name: z.string().min(1).max(ATTACHMENT_NAME_MAX),
  contentType: z.string().min(1).max(120),
  size: Count,
  kind: AttachmentKind,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  folder: FilesFolder,
  /** Null: saved straight into Files. */
  messageId: MessageId.nullable(),
  addedAt: Timestamp,
});
export type FileRef = z.infer<typeof FileRef>;

/**
 * The files of the dispatch's conversation only (FS-08), never another conversation's: its Files and, since 0.59, the
 * files agents posted there that nobody saved into Files (FS-15). `count` and `totalBytes` cover every file; `entries`
 * the newest `FILES_DISPATCH_MAX`, `truncated` when there are more.
 */
export const DispatchFiles = z.object({
  conversationId: ConversationId,
  count: Count,
  totalBytes: Count,
  truncated: z.boolean(),
  entries: z.array(FileRef).max(FILES_DISPATCH_MAX),
});
export type DispatchFiles = z.infer<typeof DispatchFiles>;
