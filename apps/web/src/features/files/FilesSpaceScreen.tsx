/**
 * One conversation's Files (`/files/c/:channel`, `/files/dm/:agent`, `/files/direct/:id`, `/files/pr/:number`;
 * docs/decisions/files-space.md AP-774…AP-777): “Files / # private / Drawings” with each step a link, the size and a
 * link to the conversation, New folder and Upload (drag and drop onto the page too), the uploads on their way as the
 * composer's chips, then the open folder: its folders by name, its files newest first. A file row: kind icon, name
 * (opens pictures, PDFs, HTML pages and diagrams in the attachment viewer, downloads the rest), where it came from (“In a message” links to
 * it, “Saved to Files”), size, who added it, when, and its menu — Download, Open message, Rename, Move to folder…,
 * Remove from Files — rename only for a file saved straight into Files (FS-05, CT-1585). Right-click opens the same menu.
 */
import {
  appPath,
  FILES_COPY,
  type FilesConversationRow,
  type FilesPlace,
  type FilesUpload,
  fileMessageLink,
  fileOriginText,
  filesAtFolder,
  filesConversationRows,
  filesCountText,
  filesErrorText,
  filesPath,
  filesSizeLine,
  filesUploadStatusText,
  filesWhereText,
  folderCrumbs,
  folderExists,
  movedText,
  pendingPlaces,
  removeFileText,
  renamedText,
} from '@whombat/client';
import { useFileRemove, useFilesList, useFilesSummary, useFileUpdate } from '@whombat/client/react';
import { attachmentPreview, type FileEntry, formatFileSize, formatRecent, isPageSet } from '@whombat/core';
import {
  FileArchive,
  FileAudio,
  FileCode,
  File as FileIcon,
  FileImage,
  FileText,
  FileVideo,
  Layers,
  type LucideIcon,
} from 'lucide-react';
import { type DragEvent, Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigateHref } from '../../app/routing/navigation';
import { LoadErrorNote } from '../../app/runtime';
import { type ContextMenuItem, useRowMenu } from '../../app/shell/ContextMenu';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { EmptyNote, SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { useToast } from '../../components/Toast';
import { useWebI18n } from '../../i18n/provider';
import composer from '../messaging/Composer.module.css';
import { AttachmentViewer, useDownloadAttachment, viewable } from '../messaging/MessageAttachments';
import { PrincipalAvatar } from '../messaging/PrincipalAvatar';
import { useNow } from '../messaging/useRoom';
import { useBurrowViewer } from '../runs/useBurrowViewer';
import { AppLink } from './AppLink';
import { MoveDialog, NewFolderDialog, RemoveDialog, RenameDialog } from './FileDialogs';
import styles from './Files.module.css';
import { ConversationLabel } from './FilesScreen';
import { useConversationNaming, useFilesPlace } from './useFilesPlace';
import { useFilesUploads } from './useFilesUploads';

export interface FilesSpaceScreenProps {
  burrow: string;
  /** Which conversation (null: an address that names none, which is not here). */
  place: FilesPlace | null;
  /** The open folder (`?folder=`), `''` for the top. */
  folder: string;
}

/**
 * The person's Chat is Files itself: its files show at `/files` under “Files” alone, without the conversation's name,
 * and the other conversations with files (Feedback, branch rooms) sit at its top like folders.
 */
function isHome(place: FilesPlace | null): boolean {
  return place?.type === 'dm' && place.room === 'chat';
}

/** The space's address with a folder open (`?folder=`), keeping a branch room's `?repo=`. */
function folderHref(base: string, folder: string): string {
  if (!folder) return base;
  return `${base}${base.includes('?') ? '&' : '?'}folder=${encodeURIComponent(folder)}`;
}

export function FilesSpaceScreen(props: FilesSpaceScreenProps) {
  const { conversationId, row, missing } = useFilesPlace(props.burrow, props.place);
  if (missing)
    return (
      <Shell title={<FilesCrumb />}>
        <EmptyNote className={styles.empty}>{FILES_COPY.notHere}</EmptyNote>
      </Shell>
    );
  if (!conversationId || !row?.link)
    return (
      <Shell title={<FilesCrumb />}>
        <SkeletonRows count={5} avatarSize={28} lines={2} />
      </Shell>
    );
  return <Space {...props} conversationId={conversationId} row={row} />;
}

function Shell({
  title,
  subtitle,
  tools,
  children,
  dropping,
  dropProps,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  tools?: ReactNode;
  children: ReactNode;
  dropping?: boolean;
  dropProps?: Record<string, (e: DragEvent<HTMLElement>) => void>;
}) {
  return (
    <section
      className={cx(styles.scroll, dropping && styles.dropping)}
      data-screen="files-space"
      aria-labelledby="files-title"
      {...dropProps}
    >
      <div className={styles.page}>
        {dropping && <p className={styles.dropHint}>{FILES_COPY.dropHere}</p>}
        <div className={styles.header}>
          <div className={styles.heading}>
            <h1 id="files-title" className={styles.title}>
              {title}
            </h1>
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </div>
          {tools && <div className={styles.tools}>{tools}</div>}
        </div>
        {children}
      </div>
    </section>
  );
}

function FilesCrumb() {
  return (
    <AppLink href="/files" className={styles.crumb}>
      {FILES_COPY.title}
    </AppLink>
  );
}

const Slash = () => (
  <span className={styles.slash} aria-hidden="true">
    /
  </span>
);

/** The file's kind, from how it would show (`attachmentPreview`) and its name. */
function kindIcon(entry: FileEntry): LucideIcon {
  const preview = attachmentPreview(entry.attachment);
  if (preview === 'image' || preview === 'svg') return FileImage;
  if (preview === 'pdf') return FileText;
  if (preview === 'audio') return FileAudio;
  if (preview === 'video') return FileVideo;
  if (preview === 'html' || preview === 'mermaid') return FileCode;
  if (preview === 'text') return FileText;
  if (isPageSet(entry.attachment)) return Layers;
  if (/\.(zip|tar|gz|tgz|7z|rar|bz2|xz)$/i.test(entry.attachment.name)) return FileArchive;
  return FileIcon;
}

function Space(props: FilesSpaceScreenProps & { conversationId: string; row: FilesConversationRow }) {
  const { tag: uiLocale } = useWebI18n();
  const { burrow, folder: rawFolder, conversationId, row } = props;
  const link = row.link as NonNullable<FilesConversationRow['link']>;
  const home = isHome(props.place);
  const base = home ? '/files' : filesPath(link);
  const where = home ? FILES_COPY.title : filesWhereText(row);
  const shortWhere = home ? FILES_COPY.title : row.label;
  const others = useOtherConversations(burrow, home && !rawFolder ? conversationId : null);
  const navigateHref = useNavigateHref();
  const toast = useToast();
  const viewer = useBurrowViewer(burrow);
  const now = useNow(60_000);
  const list = useFilesList(burrow, conversationId);
  const uploads = useFilesUploads(burrow, conversationId);
  const update = useFileUpdate();
  const remove = useFileRemove(conversationId);
  const download = useDownloadAttachment();
  const menu = useRowMenu();
  const input = useRef<HTMLInputElement>(null);
  const [places, setPlaces] = useState<string[]>([]);
  const [newFolder, setNewFolder] = useState(false);
  const [renaming, setRenaming] = useState<FileEntry | null>(null);
  const [moving, setMoving] = useState<FileEntry | null>(null);
  const [removing, setRemoving] = useState<FileEntry | null>(null);
  const [viewing, setViewing] = useState<FileEntry | null>(null);
  const [dropping, setDropping] = useState(false);
  const depth = useRef(0);

  const entries = list.data?.files ?? [];
  // A new folder is a place of this page until a file is in it (FS-03): then it is a real folder.
  useEffect(() => {
    if (list.data) setPlaces((p) => pendingPlaces(list.data.files, p));
  }, [list.data]);
  // The folder in the address; gone (its last file moved away): the nearest one left.
  const folder = rawFolder;
  const exists = !list.data || folderExists(entries, folder, places);
  useEffect(() => {
    if (exists) return;
    let up = folder;
    while (up && !folderExists(entries, up, places))
      up = up.includes('/') ? up.slice(0, up.lastIndexOf('/')) : '';
    navigateHref(folderHref(base, up), { replace: true });
  }, [exists, folder, entries, places, base, navigateHref]);

  const view = useMemo(() => filesAtFolder(entries, folder, places), [entries, folder, places]);
  const total = useMemo(() => entries.reduce((sum, e) => sum + e.attachment.size, 0), [entries]);
  const crumbs = folderCrumbs(folder);

  const pick = (files: readonly File[]) => {
    if (files.length) uploads.pick(files, folder);
  };
  const dropProps = {
    onDragEnter: (e: DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      depth.current += 1;
      setDropping(true);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDropping(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      depth.current = 0;
      setDropping(false);
      pick([...e.dataTransfer.files]);
    },
  };

  const items = (entry: FileEntry): ContextMenuItem[] => {
    const message = fileMessageLink(entry, link);
    return [
      { label: FILES_COPY.download, onSelect: () => download(entry.attachment) },
      ...(message ? [{ label: FILES_COPY.openMessage, onSelect: () => navigateHref(appPath(message)) }] : []),
      // Every file moves and can be removed; only a saved one (not a message's) is renamed (CT-1585).
      ...(entry.messageId === null ? [{ label: FILES_COPY.rename, onSelect: () => setRenaming(entry) }] : []),
      { label: FILES_COPY.move, onSelect: () => setMoving(entry) },
      { label: FILES_COPY.remove, onSelect: () => setRemoving(entry), separated: true, danger: true },
    ];
  };

  const write = async <T,>(run: () => Promise<{ status: string } & T>, fallback: string) => {
    try {
      const r = await run();
      if (r.status !== 'ok') throw new Error(fallback);
    } catch (e) {
      throw new Error(filesErrorText(e, fallback));
    }
  };

  const title = home ? (
    <>
      {crumbs.length === 0 ? <span className={styles.here}>{FILES_COPY.title}</span> : <FilesCrumb />}
      {crumbs.map((c, i) => (
        <Fragment key={c.path}>
          <Slash />
          {i === crumbs.length - 1 ? (
            <span className={styles.here}>{c.name}</span>
          ) : (
            <AppLink href={folderHref(base, c.path)} className={styles.crumb}>
              {c.name}
            </AppLink>
          )}
        </Fragment>
      ))}
    </>
  ) : (
    <>
      <FilesCrumb />
      <Slash />
      {crumbs.length === 0 ? (
        <span className={styles.here}>
          <ConversationLabel row={row} />
        </span>
      ) : (
        <AppLink href={base} className={styles.crumb}>
          <ConversationLabel row={row} />
        </AppLink>
      )}
      {crumbs.map((c, i) => (
        <Fragment key={c.path}>
          <Slash />
          {i === crumbs.length - 1 ? (
            <span className={styles.here}>{c.name}</span>
          ) : (
            <AppLink href={folderHref(base, c.path)} className={styles.crumb}>
              {c.name}
            </AppLink>
          )}
        </Fragment>
      ))}
    </>
  );

  return (
    <Shell
      title={title}
      subtitle={
        <>
          {list.data ? `${filesSizeLine(entries.length, total)}${home ? '' : ' · '}` : ''}
          {home ? null : <AppLink href={appPath(link)}>Open {shortWhere}</AppLink>}
        </>
      }
      tools={
        <>
          <Button variant="secondary" size="sm" onClick={() => setNewFolder(true)}>
            {FILES_COPY.newFolder}
          </Button>
          <Button variant="primary" size="sm" onClick={() => input.current?.click()} data-files-upload="">
            {FILES_COPY.upload}
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            aria-label={`Upload files to ${folder || where}`}
            onChange={(e) => {
              pick([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
        </>
      }
      dropping={dropping}
      dropProps={dropProps}
    >
      {uploads.items.length > 0 && (
        <UploadChips
          items={uploads.items}
          retryable={uploads.retryable}
          onRetry={uploads.retry}
          onDismiss={uploads.dismiss}
        />
      )}
      {!list.data ? (
        list.error ? (
          <LoadErrorNote
            error={list.error}
            message={FILES_COPY.loadError}
            onRetry={() => void list.refetch()}
          />
        ) : (
          <SkeletonRows count={5} avatarSize={28} lines={2} />
        )
      ) : view.folders.length === 0 && view.files.length === 0 && others.length === 0 ? (
        <EmptyNote className={styles.empty}>
          {folder ? FILES_COPY.folderEmpty : FILES_COPY.spaceEmpty}
        </EmptyNote>
      ) : (
        <div>
          <SectionLabel as="h2" className={styles.groupLabel}>
            {[
              view.folders.length + others.length
                ? view.folders.length + others.length === 1
                  ? '1 FOLDER'
                  : `${view.folders.length + others.length} FOLDERS`
                : '',
              view.files.length ? filesCountText(view.files.length).toUpperCase() : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </SectionLabel>
          <ul
            className={styles.list}
            aria-label={folder ? `Files in ${folder}` : home ? 'Your files' : `Files in ${where}`}
          >
            {others.map((other) => (
              <OtherConversation key={other.conversationId} burrow={burrow} row={other} now={now} />
            ))}
            {view.folders.map((f) => (
              <li key={f.path} className={cx(styles.row, styles.fileRow, styles.folderRow)}>
                <span className={styles.icon} aria-hidden="true">
                  <Icon name="folder" size={15} />
                </span>
                <div className={styles.what}>
                  <AppLink href={folderHref(base, f.path)} className={styles.rowLink} data-files-folder="">
                    {f.name}
                  </AppLink>
                  <span className={styles.meta}>{f.empty ? 'New folder' : filesCountText(f.count)}</span>
                </div>
                <span className={cx(styles.cell, styles.cellEnd)}>
                  {f.empty ? '' : formatFileSize(f.bytes)}
                </span>
                <span className={cx(styles.cell, styles.fileWho)} />
                <span className={cx(styles.cell, styles.cellEnd, styles.fileWhen)}>
                  {f.lastAddedAt ? formatRecent(f.lastAddedAt, now, viewer.timeZone, uiLocale) : ''}
                </span>
                <span />
              </li>
            ))}
            {view.files.map((entry) => {
              const key = `file:${entry.attachment.id}`;
              const KindIcon = kindIcon(entry);
              const who = viewer.principal(entry.uploadedById);
              const message = fileMessageLink(entry, link);
              const name = entry.attachment.name;
              const opens = viewable(entry.attachment);
              return (
                <li
                  key={entry.attachment.id}
                  className={cx(styles.row, styles.fileRow, menu.openKey === key && styles.rowMenuOpen)}
                  onContextMenu={(e) => menu.open(e, key, name, items(entry))}
                  data-files-file=""
                >
                  <span className={styles.icon} aria-hidden="true">
                    <Icon icon={KindIcon} size={15} />
                  </span>
                  <div className={styles.what}>
                    <button
                      type="button"
                      className={styles.nameButton}
                      title={name}
                      aria-label={opens ? `Open ${name}` : `Download ${name}`}
                      onClick={() => (opens ? setViewing(entry) : download(entry.attachment))}
                    >
                      {name}
                    </button>
                    {message ? (
                      <AppLink href={appPath(message)} className={styles.origin}>
                        {fileOriginText(entry)}
                      </AppLink>
                    ) : (
                      <span className={styles.meta}>{fileOriginText(entry)}</span>
                    )}
                  </div>
                  <span className={cx(styles.cell, styles.cellEnd)}>
                    {formatFileSize(entry.attachment.size)}
                  </span>
                  <span className={cx(styles.who, styles.fileWho)}>
                    <PrincipalAvatar principal={who} size={20} />
                    <span className={styles.whoName}>
                      {who?.name ?? viewer.shortName(entry.uploadedById)}
                    </span>
                  </span>
                  <span className={cx(styles.cell, styles.cellEnd, styles.fileWhen)} title={entry.addedAt}>
                    {formatRecent(entry.addedAt, now, viewer.timeZone, uiLocale)}
                  </span>
                  <button
                    type="button"
                    className={cx(styles.more, menu.openKey === key && styles.moreOpen)}
                    aria-label={`More for ${name}`}
                    title="More"
                    aria-haspopup="menu"
                    aria-expanded={menu.openKey === key}
                    onClick={(e) => menu.openFrom(e.currentTarget, key, name, items(entry), 'end')}
                  >
                    <Icon name="more" size={16} />
                  </button>
                </li>
              );
            })}
          </ul>
          {list.data.truncated && (
            <p className={styles.note}>Showing the newest 10,000 files. Search finds the rest.</p>
          )}
        </div>
      )}
      {menu.element}
      <AttachmentViewer attachment={viewing?.attachment ?? null} onClose={() => setViewing(null)} />
      <NewFolderDialog
        open={newFolder}
        parent={folder}
        where={shortWhere}
        onClose={() => setNewFolder(false)}
        onCreate={(path) => {
          setPlaces((p) => [...p, path]);
          navigateHref(folderHref(base, path));
        }}
      />
      <RenameDialog
        file={renaming}
        onClose={() => setRenaming(null)}
        onRename={async (file, name) => {
          await write(
            () =>
              update.mutateAsync({ params: { burrow, attachmentId: file.attachment.id }, body: { name } }),
            'Couldn’t rename it. Try again.',
          );
          toast.show(renamedText(name));
        }}
      />
      <MoveDialog
        file={moving}
        entries={entries}
        places={places}
        onClose={() => setMoving(null)}
        onMove={async (file, to) => {
          await write(
            () =>
              update.mutateAsync({
                params: { burrow, attachmentId: file.attachment.id },
                body: { folder: to },
              }),
            'Couldn’t move it. Try again.',
          );
          toast.show(movedText(to));
        }}
      />
      <RemoveDialog
        file={removing}
        where={where}
        text={(file) => removeFileText(file, home ? (file.messageId ? 'your Chat' : 'Files') : where)}
        onClose={() => setRemoving(null)}
        onRemove={async (file) => {
          await write(
            () => remove.mutateAsync({ params: { burrow, attachmentId: file.attachment.id } }),
            'Couldn’t remove it. Try again.',
          );
          toast.show('Removed from Files.');
        }}
      />
    </Shell>
  );
}

/** The conversations with files other than the one open (`files.summary`), newest first; none for null. */
function useOtherConversations(burrow: string, except: string | null): FilesConversationRow[] {
  const { data } = useFilesSummary(except ? { params: { burrow } } : null, { retry: false });
  const viewer = useBurrowViewer(burrow);
  return useMemo(
    () =>
      except ? filesConversationRows(data, viewer.bootstrap).filter((r) => r.conversationId !== except) : [],
    [except, data, viewer.bootstrap],
  );
}

/**
 * Another conversation's Files at the top of yours, drawn as a folder: its mark and name over how many files, their
 * size and when the last was added. A task chat the sidebar doesn't list is named from the conversation itself.
 */
function OtherConversation({ burrow, row, now }: { burrow: string; row: FilesConversationRow; now: number }) {
  const { tag: uiLocale } = useWebI18n();
  const viewer = useBurrowViewer(burrow);
  const named = useConversationNaming(burrow, row.kind === 'unknown' ? row.conversationId : null);
  const shown = named
    ? { ...row, ...named, count: row.count, bytes: row.bytes, lastAddedAt: row.lastAddedAt }
    : row;
  if (!shown.link) return null;
  return (
    <li className={cx(styles.row, styles.fileRow, styles.folderRow)} data-files-conversation="">
      <span className={styles.icon} aria-hidden="true">
        <Icon name={shown.kind === 'branch' ? 'branch' : 'folder'} size={15} />
      </span>
      <div className={styles.what}>
        <AppLink href={filesPath(shown.link)} className={styles.rowLink}>
          <ConversationLabel row={shown} />
        </AppLink>
        <span className={styles.meta}>{filesCountText(shown.count)}</span>
      </div>
      <span className={cx(styles.cell, styles.cellEnd)}>{formatFileSize(shown.bytes)}</span>
      <span className={cx(styles.cell, styles.fileWho)} />
      <span className={cx(styles.cell, styles.cellEnd, styles.fileWhen)}>
        {formatRecent(shown.lastAddedAt, now, viewer.timeZone, uiLocale)}
      </span>
      <span />
    </li>
  );
}

/** Uploads on their way, as the composer's chips (BP-A12): name, status, a progress bar, Retry and ×. */
function UploadChips({
  items,
  retryable,
  onRetry,
  onDismiss,
}: {
  items: readonly FilesUpload[];
  retryable: (item: FilesUpload) => boolean;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <ul className={composer.attachments} aria-label="Uploads">
      {items.map((a) => {
        const pct = Math.round(a.progress * 100);
        return (
          <li key={a.localId} className={cx(composer.attachment, a.state === 'failed' && composer.failed)}>
            <span className={composer.attachmentName} title={a.name}>
              {a.name}
            </span>
            {a.folder && <span className={composer.attachmentStatus}>→ {a.folder}</span>}
            <span className={composer.attachmentStatus} role={a.state === 'failed' ? 'alert' : undefined}>
              {filesUploadStatusText(a)}
            </span>
            {a.state === 'uploading' && (
              <span
                className={composer.progress}
                role="progressbar"
                aria-label={`Uploading ${a.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
              >
                <span className={composer.progressFill} style={{ width: `${pct}%` }} />
              </span>
            )}
            {a.state === 'failed' && retryable(a) && (
              <button
                type="button"
                className={composer.retryAttachment}
                aria-label={`Retry ${a.name}`}
                onClick={() => onRetry(a.localId)}
              >
                Retry
              </button>
            )}
            {a.state !== 'saving' && (
              <button
                type="button"
                className={composer.removeAttachment}
                aria-label={`${a.state === 'uploading' ? 'Cancel' : 'Dismiss'} ${a.name}`}
                title={a.state === 'uploading' ? 'Cancel' : 'Dismiss'}
                onClick={() => onDismiss(a.localId)}
              >
                ×
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
