/**
 * Files: one shared file space per conversation (Whombat files-space.md FS-01…FS-07, contracts 0.49.0 CT-274…;
 * docs/decisions/files-space.md AP-772…). Pure and shared by web and Android: whether Files shows at all, the
 * conversations with files as the list shows them, a space's folders and files at one folder, breadcrumbs, folder
 * names typed by people, the upload rows (reserve → bytes → save into Files) and the words for all of it.
 */
import {
  type Attachment,
  type Bootstrap,
  type ConversationKind,
  type ConversationLink,
  type ConversationSummary,
  FILES_FOLDER_DEPTH_MAX,
  FILES_FOLDER_SEGMENT_MAX,
  type FileEntry,
  type FilesSummaryEntry,
  type FilesSummaryResponse,
  filesFolderKey,
  formatClock,
  formatDate,
  formatFileSize,
  type LinkRef,
  normalizeFilesFolder,
  sameFilesFolder,
} from '@whombat/core';
import { sidebarSummaries } from './conversations';
import type { WhombatClient } from './http/client';
import { ApiError } from './http/errors';
import { UploadError, type UploadSource, uploadFile } from './uploads';

/* Words ------------------------------------------------------------------------------------------ */

export const FILES_COPY = {
  title: 'Files',
  intro: 'Files shared in your conversations. You see the ones in conversations you’re in.',
  noneYet: 'No files yet. Files you and your agent share in a conversation show up here.',
  spaceEmpty: 'No files here yet. Upload one, or attach one to a message.',
  folderEmpty: 'Nothing in this folder yet. It stays once a file is in it.',
  inMessage: 'In a message',
  savedToFiles: 'Saved to Files',
  upload: 'Upload',
  newFolder: 'New folder',
  download: 'Download',
  openMessage: 'Open message',
  rename: 'Rename',
  move: 'Move to folder…',
  remove: 'Remove from Files',
  top: 'Top of Files',
  dropHere: 'Drop files to upload them here',
  loadError: 'Couldn’t load these files. Try again in a moment.',
  listError: 'Couldn’t load your files. Try again in a moment.',
  notHere: 'These files aren’t here, or you’re not in this conversation.',
  saved: 'Saved',
  saving: 'Saving…',
  /** A message's file (AP-834): put it into its conversation's Files, it's there, and the note after a save. */
  saveToFiles: 'Save to Files',
  inFiles: 'In Files',
  savedNote: 'Saved to Files',
  open: 'Open',
  /** The Files home's read states (docs/decisions/final-settings-vault-files-usage.md). */
  loading: 'Loading your files…',
  readFailed: 'Couldn’t read your files',
  readFailedLine: 'There’s no saved copy to show on this device yet.',
  retry: 'Try again',
  emptyTitle: 'No files yet',
  /** Under it, the assistant by its name (`agentWords(…).Name`). */
  emptyLine: (agent: string) => `Files you and ${agent} share in a conversation show up here.`,
  goToChat: 'Go to Chat',
} as const;

/** “1 file”, “12 files”. */
export function filesCountText(count: number): string {
  return count === 1 ? '1 file' : `${count} files`;
}

/** “12 files · 4.1 MB”: a conversation's or a folder's line. */
export function filesSizeLine(count: number, bytes: number): string {
  return `${filesCountText(count)} · ${formatFileSize(bytes)}`;
}

/** “23 Sep 11:20”: when the last file was added, always with its day so a row reads on its own. */
export function filesLastAddedText(at: string, timeZone: string): string {
  return `Last added ${formatDate(at, timeZone, { year: 'never' })} ${formatClock(at, timeZone)}`;
}

/** A conversation's line on the Files home: “4 files · 136 MB · Last added 23 Sep 11:20”. */
export function filesSpaceLine(
  row: { count: number; bytes: number; lastAddedAt: string | null },
  timeZone: string,
): string {
  const size = filesSizeLine(row.count, row.bytes);
  return row.lastAddedAt ? `${size} · ${filesLastAddedText(row.lastAddedAt, timeZone)}` : size;
}

/** Where a file came from: “In a message” or “Saved to Files”. */
export function fileOriginText(entry: Pick<FileEntry, 'messageId'>): string {
  return entry.messageId ? FILES_COPY.inMessage : FILES_COPY.savedToFiles;
}

/** “Moved to Drawings/2024.” / “Moved to the top of Files.” */
export function movedText(folder: string): string {
  return folder ? `Moved to ${folder}.` : 'Moved to the top of Files.';
}

/** “Renamed to “plan.pdf”.” */
export function renamedText(name: string): string {
  return `Renamed to “${name}”.`;
}

/** “Saved 1 file to Files.” / “Saved 3 files to Drawings.” */
export function uploadedText(count: number, folder: string): string {
  return `Saved ${filesCountText(count)} to ${folder ? folderName(folder) : 'Files'}.`;
}

/** The confirm dialog's sentence: a message's file stays on its message; a saved file is deleted. */
export function removeFileText(entry: Pick<FileEntry, 'messageId'>, where: string): string {
  return entry.messageId
    ? `It stays on its message in ${where}; only Files lets go of it.`
    : `It’s deleted from ${where}. This can’t be undone.`;
}

/** Words for a refused or failed Files write: the Whombat's own for a 4xx, else ours. */
export function filesErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status < 500 && error.message) return error.message;
  return fallback;
}

/* A message's file: Save to Files (contracts 0.59 CT-312, AP-834) ------------------------------- */

/** What a message's file offers besides Download: “Save to Files”, “In Files”, or nothing. */
export type SaveToFilesAction = 'save' | 'saved';

/**
 * “Save to Files” while the file isn't in its conversation's Files (`inFiles: false`: an agent's file nobody saved, or
 * one removed from Files), “In Files” once it is; nothing for a file outside a message (`inFiles` absent).
 */
export function saveActionOf(attachment: Pick<Attachment, 'inFiles'>): SaveToFilesAction | null {
  if (attachment.inFiles === undefined) return null;
  return attachment.inFiles ? 'saved' : 'save';
}

/** The buttons' names for assistive technology: “Save plan.pdf to Files”, “plan.pdf is in Files. Open Files”. */
export function saveToFilesLabel(name: string): string {
  return `Save ${name} to Files`;
}

export function inFilesLabel(name: string): string {
  return `${name} is in Files. Open Files`;
}

/** When the Whombat gives no words of its own for a refused save. */
export const SAVE_TO_FILES_FAILED = 'Couldn’t save it to Files. Try again.';

/**
 * The message with one of its files marked in or out of Files (the click's optimistic flip, a removal in Files); the
 * same message when it has no such file or already says so. A file whose message doesn't say (`inFiles` absent) stays
 * so.
 */
export function withInFiles<M extends { attachments: readonly Attachment[] }>(
  message: M,
  attachmentId: string,
  inFiles: boolean,
): M {
  const at = message.attachments.findIndex(
    (a) => a.id === attachmentId && a.inFiles !== undefined && a.inFiles !== inFiles,
  );
  if (at < 0) return message;
  const attachments = message.attachments.map((a, i) => (i === at ? { ...a, inFiles } : a));
  return { ...message, attachments };
}

/**
 * Where a conversation's Files open (“In Files”, the “Saved to Files” note's Open), from the bootstrap's sidebar; the
 * list of every conversation's Files when the sidebar doesn't list it.
 */
export function conversationFilesPath(
  conversationId: string,
  bootstrap: Pick<Bootstrap, 'sidebar'> | null | undefined,
): string {
  const s = sidebarSummaries(bootstrap?.sidebar).find((c) => c.id === conversationId);
  return s ? filesPath(linkOf(s)) : '/files';
}

/* Visibility (FS-07) ----------------------------------------------------------------------------- */

/** “Files” is in the sidebar (or the phone's list) only while the viewer can see at least one file. */
export function showsFiles(summary: Pick<FilesSummaryResponse, 'conversations'> | null | undefined): boolean {
  return !!summary && summary.conversations.some((c) => c.count > 0);
}

/* Conversations ---------------------------------------------------------------------------------- */

/** One conversation in `/files`: how it is named and drawn, where it opens. */
export interface FilesConversationRow extends FilesSummaryEntry {
  kind: ConversationKind | 'unknown';
  /** “Chat”, “Feedback”, a branch name. */
  label: string;
  /** Where the conversation itself opens (null when the viewer's bootstrap doesn't list it). */
  link: ConversationLink | null;
}

/** A conversation's link, as the sidebar knows it. */
function linkOf(s: ConversationSummary): ConversationLink {
  return s.link as ConversationLink;
}

/**
 * The conversations with files the viewer may see (`files.summary`), named as the sidebar names them, newest activity
 * first. A conversation the bootstrap doesn't list (an archived channel) is `unknown` with its id; screens may look it
 * up themselves.
 */
export function filesConversationRows(
  summary: Pick<FilesSummaryResponse, 'conversations'> | null | undefined,
  bootstrap: Pick<Bootstrap, 'sidebar'> | null | undefined,
): FilesConversationRow[] {
  if (!summary) return [];
  const byId = new Map(sidebarSummaries(bootstrap?.sidebar).map((s) => [s.id, s]));
  return summary.conversations
    .filter((c) => c.count > 0)
    .map((c): FilesConversationRow => {
      const s = byId.get(c.conversationId);
      if (!s) return { ...c, kind: 'unknown', label: '', link: null };
      return { ...c, kind: s.kind, label: s.title, link: linkOf(s) };
    })
    .sort((a, b) => Date.parse(b.lastAddedAt) - Date.parse(a.lastAddedAt));
}

/** The conversation in a sentence: “your Chat”, “your Feedback”, a branch name. */
export function filesWhereText(row: Pick<FilesConversationRow, 'kind' | 'label'>): string {
  switch (row.kind) {
    case 'dm':
      return `your ${row.label}`;
    case 'branch':
      return row.label;
    default:
      return 'this conversation';
  }
}

/** A conversation's Files as an address, in the conversations' own style: `/files/dm/chat`, `/files/pr/482`. */
export function filesPath(link: ConversationLink): string {
  switch (link.type) {
    case 'dm':
      return `/files/dm/${link.room ?? 'chat'}`;
    // A task chat (contracts 0.80.1 `ChatLink`): its Files by the conversation id.
    case 'chat':
      return `/files/direct/${encodeURIComponent(link.id)}`;
    case 'pr':
      return `/files/pr/${link.number}${link.repo ? `?repo=${encodeURIComponent(link.repo)}` : ''}`;
  }
}

/** Which conversation a Files address names (`filesPath` read back). */
export type FilesPlace =
  /** Chat or the Feedback room. */
  | { type: 'dm'; room: 'chat' | 'feedback' }
  /** A task chat, by its id. */
  | { type: 'direct'; id: string }
  | { type: 'pr'; number: number; repo?: string };

/** The conversation id of a place, from the bootstrap's sidebar (a task chat carries it); null if unknown. */
export function filesConversationId(
  place: FilesPlace,
  bootstrap: Pick<Bootstrap, 'sidebar'> | null | undefined,
): string | null {
  if (place.type === 'direct') return place.id;
  for (const s of sidebarSummaries(bootstrap?.sidebar)) {
    const link = s.link as ConversationLink;
    if (place.type === 'dm' && link.type === 'dm' && (link.room ?? 'chat') === place.room) return s.id;
    if (
      place.type === 'pr' &&
      link.type === 'pr' &&
      link.number === place.number &&
      (!place.repo || !link.repo || link.repo === place.repo)
    )
      return s.id;
  }
  return null;
}

/** “Open message”: the message in its conversation, or its thread when it is a reply. */
export function fileMessageLink(
  entry: Pick<FileEntry, 'messageId' | 'threadRootId'>,
  where: ConversationLink,
): LinkRef | null {
  if (!entry.messageId) return null;
  const inLink =
    where.type === 'pr'
      ? { type: 'pr' as const, number: where.number, ...(where.repo ? { repo: where.repo } : {}) }
      : where;
  return {
    type: 'message',
    in: inLink,
    messageId: entry.messageId,
    ...(entry.threadRootId && entry.threadRootId !== entry.messageId
      ? { threadRootId: entry.threadRootId }
      : {}),
  };
}

/* Folders (FS-03) -------------------------------------------------------------------------------- */

/** A folder's last segment: “2024” for `Drawings/2024`; “Files” for the top. */
export function folderName(folder: string): string {
  return folder ? (folder.split('/').pop() ?? folder) : FILES_COPY.title;
}

/** The folder above (`''` above a top-level folder and above the top). */
export function parentFolder(folder: string): string {
  const at = folder.lastIndexOf('/');
  return at < 0 ? '' : folder.slice(0, at);
}

/** True when `folder` is `ancestor` or inside it (case-insensitive); everything is inside the top. */
export function isInFolder(folder: string, ancestor: string): boolean {
  if (!ancestor) return true;
  const f = filesFolderKey(folder);
  const a = filesFolderKey(ancestor);
  return f === a || f.startsWith(`${a}/`);
}

export interface FolderCrumb {
  name: string;
  /** The folder this crumb opens. */
  path: string;
}

/** The folders on the way down to `folder`, top first (none for the top). */
export function folderCrumbs(folder: string): FolderCrumb[] {
  if (!folder) return [];
  const parts = folder.split('/');
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
}

/** Why a folder name a person typed can't be one, or null when it can (FS-03). */
export function folderNameProblem(raw: string, parent: string): string | null {
  const name = raw.trim();
  if (!name) return 'Give the folder a name.';
  if (name.includes('/')) return 'A folder name can’t hold a /. Make the folder, then one inside it.';
  if (name === '.' || name === '..' || name.includes('\\'))
    return 'A folder can’t be called . or .., or hold a \\.';
  if ([...name].length > FILES_FOLDER_SEGMENT_MAX)
    return `A folder name is at most ${FILES_FOLDER_SEGMENT_MAX} characters.`;
  const path = normalizeFilesFolder(parent ? `${parent}/${name}` : name);
  if (path === null) {
    if (parent.split('/').length >= FILES_FOLDER_DEPTH_MAX)
      return `Folders go at most ${FILES_FOLDER_DEPTH_MAX} levels deep.`;
    return 'That can’t be a folder name.';
  }
  if (!path || sameFilesFolder(path, parent)) return 'That can’t be a folder name.';
  return null;
}

/** Why a folder path a person typed (the Move dialog) can’t be a folder; null when it can. */
export function folderPathProblem(raw: string): string | null {
  if (normalizeFilesFolder(raw) !== null) return null;
  if (raw.split('/').filter((s) => s.trim()).length > FILES_FOLDER_DEPTH_MAX)
    return `Folders go at most ${FILES_FOLDER_DEPTH_MAX} levels deep.`;
  return `Each folder name is 1–${FILES_FOLDER_SEGMENT_MAX} characters, not . or .., without a \\.`;
}

/** `parent/name`, normalized (null when it can't be a folder). */
export function childFolder(parent: string, name: string): string | null {
  if (folderNameProblem(name, parent)) return null;
  return normalizeFilesFolder(parent ? `${parent}/${name}` : name);
}

/**
 * The spelling a folder already has in this space, so “drawings” lands in “Drawings” (folders compare
 * case-insensitively, FS-03); each existing prefix is taken over, the rest kept as typed.
 */
export function existingFolderSpelling(folder: string, known: readonly string[]): string {
  if (!folder) return folder;
  const byKey = new Map(known.map((k) => [filesFolderKey(k), k]));
  const parts = folder.split('/');
  let out = '';
  for (let i = 0; i < parts.length; i += 1) {
    const path = parts.slice(0, i + 1).join('/');
    const found = byKey.get(filesFolderKey(path));
    const segment = found ? (found.split('/').pop() ?? parts[i]) : parts[i];
    out = out ? `${out}/${segment}` : (segment ?? '');
  }
  return out;
}

/**
 * Every folder of a space (each with its ancestors), plus the client's new places, once each (case-insensitive, the
 * spelling of the newest file), sorted by path: the Move dialog's list. The top (`''`) is not in it.
 */
export function allFolders(
  entries: readonly Pick<FileEntry, 'folder' | 'addedAt'>[],
  places: readonly string[] = [],
): string[] {
  const byKey = new Map<string, string>();
  const newestFirst = [...entries].sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt));
  for (const folder of [...newestFirst.map((e) => e.folder), ...places]) {
    const parts = folder ? folder.split('/') : [];
    for (let i = 1; i <= parts.length; i += 1) {
      const path = parts.slice(0, i).join('/');
      const key = filesFolderKey(path);
      if (!byKey.has(key)) byKey.set(key, existingFolderSpelling(path, [...byKey.values()]));
    }
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

export interface FilesFolderRow {
  /** The whole path (`Drawings/2024`). */
  path: string;
  /** Its last segment (`2024`). */
  name: string;
  /** Files in it and below. */
  count: number;
  bytes: number;
  /** Newest file in it or below; null for a new, empty place. */
  lastAddedAt: string | null;
  /** A “New folder” place of this client that holds nothing yet (FS-03). */
  empty: boolean;
}

export interface FilesFolderView {
  folder: string;
  /** Folders right inside `folder`, by name. */
  folders: FilesFolderRow[];
  /** Files right in `folder`, newest first. */
  files: FileEntry[];
}

/**
 * One folder of a space: its folders first (by name, with what is in and below them), then its own files newest first
 * (`files.list` gives every folder; clients group, FS-04). `places` are the client's “New folder”s: shown as empty
 * folders until a file is in them.
 */
export function filesAtFolder(
  entries: readonly FileEntry[],
  folder: string,
  places: readonly string[] = [],
): FilesFolderView {
  const depth = folder ? folder.split('/').length : 0;
  const rows = new Map<string, FilesFolderRow>();
  const files: FileEntry[] = [];
  const newestFirst = [...entries].sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt));
  for (const e of newestFirst) {
    if (!isInFolder(e.folder, folder)) continue;
    if (sameFilesFolder(e.folder, folder)) {
      files.push(e);
      continue;
    }
    const name = e.folder.split('/')[depth] ?? '';
    const path = folder ? `${folder}/${name}` : name;
    const key = filesFolderKey(path);
    const row = rows.get(key);
    if (row) {
      row.count += 1;
      row.bytes += e.attachment.size;
    } else
      rows.set(key, {
        path,
        name,
        count: 1,
        bytes: e.attachment.size,
        lastAddedAt: e.addedAt,
        empty: false,
      });
  }
  for (const place of places) {
    if (!isInFolder(place, folder) || sameFilesFolder(place, folder)) continue;
    const name = place.split('/')[depth];
    if (!name) continue;
    const path = folder ? `${folder}/${name}` : name;
    const key = filesFolderKey(path);
    if (!rows.has(key)) rows.set(key, { path, name, count: 0, bytes: 0, lastAddedAt: null, empty: true });
  }
  const folders = [...rows.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
  return { folder, folders, files };
}

/** Whether a folder exists in the space or as one of the client's places (an address to a gone folder goes up). */
export function folderExists(
  entries: readonly Pick<FileEntry, 'folder'>[],
  folder: string,
  places: readonly string[] = [],
): boolean {
  if (!folder) return true;
  return [...entries.map((e) => e.folder), ...places].some((f) => isInFolder(f, folder));
}

/** The places still worth keeping: those no file has reached yet (a place with a file in it is a real folder). */
export function pendingPlaces(
  entries: readonly Pick<FileEntry, 'folder'>[],
  places: readonly string[],
): string[] {
  return places.filter((p) => !entries.some((e) => isInFolder(e.folder, p)));
}

/* Uploads into Files (FS-04 files.save) ---------------------------------------------------------- */

export type FilesUploadState = 'uploading' | 'saving' | 'saved' | 'failed';

export interface FilesUpload {
  localId: string;
  name: string;
  size: number;
  /** The folder it goes into. */
  folder: string;
  state: FilesUploadState;
  /** 0…1 while the bytes go. */
  progress: number;
  /** The upload once its bytes are there: a retry after a failed save only saves again. */
  attachment: Attachment | null;
  error: string | null;
}

export type FilesUploadAction =
  | { type: 'add'; item: Pick<FilesUpload, 'localId' | 'name' | 'size' | 'folder'> }
  /** Refused before it started (larger than the Whombat takes). */
  | { type: 'refuse'; item: Pick<FilesUpload, 'localId' | 'name' | 'size' | 'folder'>; error: string }
  | { type: 'progress'; localId: string; progress: number }
  | { type: 'uploaded'; localId: string; attachment: Attachment }
  | { type: 'saved'; localId: string }
  | { type: 'failed'; localId: string; error: string }
  | { type: 'retry'; localId: string }
  | { type: 'dismiss'; localId: string }
  | { type: 'clearSaved' };

export function filesUploadsReducer(items: readonly FilesUpload[], action: FilesUploadAction): FilesUpload[] {
  const patch = (localId: string, change: Partial<FilesUpload>) =>
    items.map((i) => (i.localId === localId ? { ...i, ...change } : i));
  const find = (localId: string) => items.find((i) => i.localId === localId);
  switch (action.type) {
    case 'add':
      return [...items, { ...action.item, state: 'uploading', progress: 0, attachment: null, error: null }];
    case 'refuse':
      return [
        ...items,
        { ...action.item, state: 'failed', progress: 0, attachment: null, error: action.error },
      ];
    case 'progress': {
      if (find(action.localId)?.state !== 'uploading') return [...items];
      return patch(action.localId, { progress: Math.max(0, Math.min(1, action.progress)) });
    }
    case 'uploaded':
      if (find(action.localId)?.state !== 'uploading') return [...items];
      return patch(action.localId, { state: 'saving', progress: 1, attachment: action.attachment });
    case 'saved':
      if (find(action.localId)?.state !== 'saving') return [...items];
      return patch(action.localId, { state: 'saved', progress: 1, error: null });
    case 'failed':
      if (find(action.localId)?.state === 'saved') return [...items];
      return patch(action.localId, { state: 'failed', error: action.error });
    case 'retry': {
      const item = find(action.localId);
      if (item?.state !== 'failed') return [...items];
      // The bytes are there already: only the save is tried again.
      return item.attachment
        ? patch(action.localId, { state: 'saving', error: null })
        : patch(action.localId, { state: 'uploading', progress: 0, error: null });
    }
    case 'dismiss':
      return items.filter((i) => i.localId !== action.localId);
    case 'clearSaved':
      return items.filter((i) => i.state !== 'saved');
  }
}

/** Something is still on its way (Upload stays usable; leaving the page would stop it). */
export function filesUploading(items: readonly FilesUpload[]): boolean {
  return items.some((i) => i.state === 'uploading' || i.state === 'saving');
}

/** The row's status: “Uploading 42%”, “Saving…”, “Saved · 2.4 MB”, or why it failed. */
export function filesUploadStatusText(item: FilesUpload): string {
  switch (item.state) {
    case 'uploading':
      return `Uploading ${Math.round(item.progress * 100)}%`;
    case 'saving':
      return FILES_COPY.saving;
    case 'saved':
      return `${FILES_COPY.saved} · ${formatFileSize(item.attachment?.size ?? item.size)}`;
    case 'failed':
      return item.error ?? 'Upload failed. Try again.';
  }
}

/** A file larger than the Whombat takes (its reservation's `maxBytes`), said before anything is sent. */
export function tooLargeText(name: string, maxBytes: number): string {
  return `${name} is larger than ${formatFileSize(maxBytes)}, the most this Whombat takes.`;
}

export const SAVE_FAILED = 'Uploaded, but couldn’t save it to Files. Try again.';

export interface FilesUploadOptions {
  burrow: string;
  conversationId: string;
  folder: string;
  file: UploadSource;
  onProgress?: (fraction: number) => void;
  /** The reservation: its id (a cancel discards it) and this Whombat's per-file limit. */
  onReserved?: (attachmentId: string, maxBytes: number) => void;
  /** The bytes are there; the save into Files follows. */
  onUploaded?: (attachment: Attachment) => void;
  signal?: AbortSignal;
  /** The bytes are already up (a retry after a failed save): only save. */
  uploaded?: Attachment;
}

/**
 * Upload into Files: `uploads.create` → the bytes → `files.save` with the folder (FS-04). Resolves to the saved entry;
 * rejects with `UploadError` (cancelled, or the save's refusal in words) or `ApiError`.
 */
export async function uploadToFiles(client: WhombatClient, options: FilesUploadOptions): Promise<FileEntry> {
  const attachment =
    options.uploaded ??
    (await uploadFile(client, {
      burrow: options.burrow,
      conversationId: options.conversationId,
      file: options.file,
      ...(options.onProgress && { onProgress: options.onProgress }),
      ...(options.onReserved && { onReserved: options.onReserved }),
      ...(options.signal && { signal: options.signal }),
    }));
  options.onUploaded?.(attachment);
  if (options.signal?.aborted) throw new UploadError('Cancelled.', null, true);
  let saved: Awaited<ReturnType<WhombatClient['files']['save']>>;
  try {
    saved = await client.files.save({
      params: { burrow: options.burrow },
      body: { attachmentId: attachment.id, folder: options.folder },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status < 500 && error.message)
      throw new UploadError(error.message, error.status);
    throw new UploadError(SAVE_FAILED, null);
  }
  if (saved.status !== 'ok') throw new UploadError(SAVE_FAILED, null);
  return saved.data.file;
}
