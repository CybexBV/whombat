/**
 * Files on Android (Whombat files-space.md FS-01…FS-07; docs/decisions/files-space.md AP-772…): the phone's view
 * models over the shared helpers in `@whombat/client` (`FILES_COPY`, `filesConversationRows`, `filesAtFolder`, the
 * folder rules). What is the phone's own: the list's rows (the person's Chat and Feedback room, a task chat, a branch
 * room: Whombat one-agent.md OA-04; app one-agent.md AP-4983), one file's row and its action sheet, the confirm before
 * removing, the Move and New folder sheets' choices and checks, and which conversation a Files screen's params name.
 * Pure: no React Native imports, unit-tested.
 */
import {
  allFolders,
  childFolder,
  existingFolderSpelling,
  FILES_COPY,
  type FilesConversationRow,
  type FilesPlace,
  filesConversationId,
  filesConversationRows,
  filesSizeLine,
  filesSpaceLine,
  filesWhereText,
  folderExists,
  folderNameProblem,
  folderPathProblem,
  parentFolder,
  removeFileText,
} from '@whombat/client';
import {
  type Bootstrap,
  type ConversationSummary,
  type FileEntry,
  filesFolderKey,
  formatFileSize,
  formatRecent,
  normalizeFilesFolder,
} from '@whombat/core';
import { formatLocaleBytes, resolveDisplayLanguage } from '@whombat/core/i18n';
import { formatClock, formatDate } from '@whombat/core/text';
import { mobileTranslator } from '../i18n/translate';
import { filesCopy } from './filesCopy';
import type { ViewContext } from './people';

/* The entry point ------------------------------------------------------------------------------- */

/* The list of conversations with files ---------------------------------------------------------- */

/**
 * One conversation's Files row from a summary the bootstrap's sidebar doesn't list (a task chat, a room the screen
 * fetched itself): named exactly as `filesConversationRows` names sidebar conversations.
 */
export function filesRowFor(
  summary: ConversationSummary,
  entry: { count: number; bytes: number; lastAddedAt: string } = { count: 1, bytes: 0, lastAddedAt: '' },
): FilesConversationRow {
  const [row] = filesConversationRows(
    { conversations: [{ conversationId: summary.id, ...entry, count: Math.max(1, entry.count) }] },
    { sidebar: { branchRooms: [], dms: [summary], counts: { canvases: 0, needsYou: 0 } } },
  );
  return { ...(row as FilesConversationRow), count: entry.count };
}

/** The row's title: “Chat”, “Feedback”, a branch's name. */
export function filesRowTitle(row: Pick<FilesConversationRow, 'label'>): string {
  return row.label || 'A conversation';
}

/**
 * Where a file is, in a sentence (the shared `filesWhereText`): “your Chat”, “your Feedback”, a branch's name; “this
 * conversation” while it isn't named yet.
 */
export function filesWhere(row: Pick<FilesConversationRow, 'kind' | 'label'> | null | undefined): string {
  return row?.label ? filesWhereText(row) : 'this conversation';
}

/** The kicker over a conversation's Files: “Chat”, “Feedback”, a branch's name. */
export function filesKicker(row: Pick<FilesConversationRow, 'kind' | 'label'> | null | undefined): string {
  return row?.label ?? '';
}

export interface FilesListRow {
  row: FilesConversationRow;
  title: string;
  /** “4 files · 136 MB · Last added 23 Sep 11:20” (the final Files home, final-settings-vault-files-usage.md). */
  meta: string;
  /** When the newest file came: “11:20”, “Yesterday”. */
  time: string;
  accessibilityLabel: string;
}

/** `/files` on the phone: each conversation with files, newest first (the order `filesConversationRows` gives). */
export function filesListRow(
  row: FilesConversationRow,
  ctx: Pick<ViewContext, 'now' | 'timeZone' | 'locale'>,
): FilesListRow {
  const title = filesRowTitle(row);
  const { t } = mobileTranslator(ctx.locale);
  const meta =
    resolveDisplayLanguage(ctx.locale) === 'en'
      ? filesSpaceLine(row, ctx.timeZone)
      : [
          t('files.count', { count: row.count }),
          formatLocaleBytes(row.bytes, ctx.locale),
          row.lastAddedAt &&
            t('files.lastAdded', {
              date: formatDate(row.lastAddedAt, ctx.timeZone, { year: 'never' }, ctx.locale),
              time: formatClock(row.lastAddedAt, ctx.timeZone),
            }),
        ]
          .filter(Boolean)
          .join(' · ');
  const time = row.lastAddedAt ? formatRecent(row.lastAddedAt, ctx.now, ctx.timeZone, ctx.locale) : '';
  const kind = row.kind === 'branch' ? 'branch room' : null;
  return {
    row,
    title,
    meta,
    time,
    accessibilityLabel: [title, kind, meta].filter(Boolean).join(', '),
  };
}

/* One file ---------------------------------------------------------------------------------------- */

export interface FileRowView {
  entry: FileEntry;
  name: string;
  /** “2.4 MB”. */
  size: string;
  /** When it was added: “11:20”, “Yesterday”. */
  time: string;
  uploaderId: string;
  uploader: string;
  /** “In a message” / “Saved to Files”. */
  origin: string;
  accessibilityLabel: string;
}

export function fileRowView(
  entry: FileEntry,
  ctx: Pick<ViewContext, 'people' | 'now' | 'timeZone' | 'locale'>,
): FileRowView {
  const size =
    resolveDisplayLanguage(ctx.locale) === 'en'
      ? formatFileSize(entry.attachment.size)
      : formatLocaleBytes(entry.attachment.size, ctx.locale);
  const time = formatRecent(entry.addedAt, ctx.now, ctx.timeZone, ctx.locale);
  const uploader = ctx.people.name(entry.uploadedById);
  const copy = filesCopy(ctx.locale);
  const origin = entry.messageId ? copy.inMessage : copy.savedToFiles;
  return {
    entry,
    name: entry.attachment.name,
    size,
    time,
    uploaderId: entry.uploadedById,
    uploader,
    origin,
    accessibilityLabel: `${entry.attachment.name}, ${size}, ${uploader}, ${time}, ${origin}`,
  };
}

/** A folder's row: “Drawings, folder, 3 files · 2.1 MB”; a new, empty place says it holds nothing yet. */
export function folderRowMeta(row: { count: number; bytes: number; empty: boolean }): string {
  return row.empty ? '0 files' : filesSizeLine(row.count, row.bytes);
}

export type FileActionKind = 'download' | 'open_message' | 'rename' | 'move' | 'remove';

export interface FileAction {
  kind: FileActionKind;
  label: string;
  destructive: boolean;
  /** What TalkBack adds after the label. */
  accessibilityHint: string;
}

/**
 * A file's action sheet (FS-07): Download (the phone downloads it and opens the share sheet, where Save is), Open
 * message for a message's file, then Rename (a file saved straight into Files; a message's keeps its message's name),
 * Move to folder… and Remove from Files, Remove last in the bad tone. Every file is yours (contracts 3.0 dropped
 * `canRename`, `canMove` and `canRemove`; one-person-android.md AP-5770).
 */
export function fileActions(entry: Pick<FileEntry, 'messageId'>, locale?: string): FileAction[] {
  const copy = filesCopy(locale);
  const { t } = mobileTranslator(locale);
  const actions: FileAction[] = [
    {
      kind: 'download',
      label: copy.download,
      destructive: false,
      accessibilityHint: t('files.downloadHint'),
    },
  ];
  if (entry.messageId)
    actions.push({
      kind: 'open_message',
      label: copy.openMessage,
      destructive: false,
      accessibilityHint: t('files.openHint'),
    });
  if (entry.messageId === null)
    actions.push({
      kind: 'rename',
      label: copy.rename,
      destructive: false,
      accessibilityHint: t('files.renameHint'),
    });
  actions.push(
    {
      kind: 'move',
      label: copy.move,
      destructive: false,
      accessibilityHint: t('files.moveHint'),
    },
    {
      kind: 'remove',
      label: copy.remove,
      destructive: true,
      accessibilityHint: t('files.removeHint'),
    },
  );
  return actions;
}

/**
 * The confirm before Remove from Files (FS-06): a message's file only leaves Files (“Remove”), a file saved straight
 * into Files is deleted (“Delete”).
 */
export function removeConfirm(
  entry: Pick<FileEntry, 'messageId' | 'attachment'>,
  where: string,
): { title: string; body: string; cta: string } {
  return {
    title: entry.messageId
      ? `Remove “${entry.attachment.name}” from Files?`
      : `Delete “${entry.attachment.name}”?`,
    body: removeFileText(entry, where),
    cta: entry.messageId ? 'Remove' : 'Delete',
  };
}

/** Why a typed name can't be a file's (null when it can); the Whombat checks the rest and says so. */
export function renameProblem(draft: string): string | null {
  const name = draft.trim();
  if (!name) return 'Give the file a name.';
  if (/[/\\]/.test(name)) return 'A file name can’t hold a / or a \\.';
  return null;
}

/** Whether Save is on in the Rename sheet: a name that differs and can be one. */
export function canRename(draft: string, original: string): boolean {
  return !renameProblem(draft) && draft.trim() !== original;
}

/* Folders ---------------------------------------------------------------------------------------- */

export interface MoveChoice {
  /** `''` for the top. */
  path: string;
  /** “Top of Files”, else the folder's last segment. */
  label: string;
  /** How deep it sits (0 for the top and top-level folders), for the indent. */
  depth: number;
  /** The file is there now. */
  current: boolean;
}

/** The Move sheet's list: the top, then every folder of the space and the phone's new places, the file's own marked. */
export function moveChoices(
  entries: readonly Pick<FileEntry, 'folder' | 'addedAt'>[],
  places: readonly string[],
  current: string,
): MoveChoice[] {
  const key = filesFolderKey(current);
  return [
    { path: '', label: FILES_COPY.top, depth: 0, current: current === '' },
    ...allFolders(entries, places).map((path) => {
      const parts = path.split('/');
      return {
        path,
        label: parts[parts.length - 1] ?? path,
        depth: parts.length - 1,
        current: filesFolderKey(path) === key,
      };
    }),
  ];
}

/**
 * The folder a person typed in the Move sheet (“drawings/2024”), in the spelling the space already has (“Drawings/2024”,
 * FS-03), or why it can't be one. Blank is the top.
 */
export function typedFolder(
  raw: string,
  entries: readonly Pick<FileEntry, 'folder' | 'addedAt'>[],
  places: readonly string[],
): { folder: string } | { problem: string } {
  const folder = normalizeFilesFolder(raw);
  if (folder === null) return { problem: folderPathProblem(raw) ?? 'That can’t be a folder.' };
  return { folder: existingFolderSpelling(folder, allFolders(entries, places)) };
}

/**
 * “New folder” inside `parent` (FS-03: a place on the phone until a file is in it): the folder to open, in the spelling
 * the space already has when one by that name exists, or why the name can't be one.
 */
export function newFolder(
  raw: string,
  parent: string,
  entries: readonly Pick<FileEntry, 'folder' | 'addedAt'>[],
  places: readonly string[],
): { folder: string } | { problem: string } {
  const problem = folderNameProblem(raw, parent);
  if (problem) return { problem };
  const path = childFolder(parent, raw);
  if (path === null) return { problem: 'That can’t be a folder name.' };
  return { folder: existingFolderSpelling(path, allFolders(entries, places)) };
}

/** The folder to show for `folder`: itself while it exists, else the nearest one above it that does (or the top). */
export function reachableFolder(
  entries: readonly Pick<FileEntry, 'folder'>[],
  folder: string,
  places: readonly string[],
): string {
  let at = folder;
  while (at && !folderExists(entries, at, places)) at = parentFolder(at);
  return at;
}

/* Which conversation ----------------------------------------------------------------------------- */

/**
 * A conversation's Files screen: by id (the menu, the list, a task chat's `/files/direct/<id>`), or by what a `/files/…`
 * address names — the person's Chat or Feedback room (`/files/dm/chat`), a branch room (`/files/pr/482`).
 */
export type ConversationFilesTarget =
  | { conversationId: string }
  | { room: string }
  | { prNumber: number; repo?: string };

/** The place a Files screen's params name (null for an id, which needs no lookup, or a room that isn't one). */
export function filesPlaceOf(params: ConversationFilesTarget): FilesPlace | null {
  if ('conversationId' in params) return null;
  if ('room' in params)
    return params.room === 'chat' || params.room === 'feedback' ? { type: 'dm', room: params.room } : null;
  return { type: 'pr', number: Number(params.prNumber), ...(params.repo ? { repo: params.repo } : {}) };
}

/** The conversation id a Files screen's params name, from the sidebar for an address; null when unknown. */
export function filesTargetId(
  params: ConversationFilesTarget,
  bootstrap: Pick<Bootstrap, 'sidebar'>,
): string | null {
  if ('conversationId' in params) return params.conversationId || null;
  const place = filesPlaceOf(params);
  return place ? filesConversationId(place, bootstrap) : null;
}
