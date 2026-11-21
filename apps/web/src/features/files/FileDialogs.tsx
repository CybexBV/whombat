/**
 * Files' dialogs (docs/decisions/files-space.md AP-777, AP-775): Rename, Move to folder…, New folder in the channel
 * settings form's language (mono kicker, 23px title, labelled field, the Whombat's refusal under it, Cancel / action),
 * and Remove from Files in `ConfirmDialog`'s.
 */
import {
  allFolders,
  childFolder,
  existingFolderSpelling,
  FILES_COPY,
  folderName,
  folderNameProblem,
  folderPathProblem,
  type Problem,
  problemOf,
} from '@whombat/client';
import { type FileEntry, normalizeFilesFolder, sameFilesFolder } from '@whombat/core';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { MoreDetail } from '../../components/MoreDetail';
import { SectionLabel } from '../../components/SectionLabel';
import { ConfirmDialog } from '../conversations/ConfirmDialog';
import confirm from '../conversations/Conversations.module.css';
import styles from './Files.module.css';

function FormDialog({
  open,
  onClose,
  kicker,
  title,
  description,
  children,
  error,
  action,
  busy,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  kicker: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** The Whombat's refusal, or what went wrong in words with its raw detail folded under it. */
  error: string | Problem | null;
  action: string;
  busy: boolean;
  onSubmit: () => void;
}) {
  const errorId = useId();
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} width="md">
      <form
        className={styles.form}
        noValidate
        aria-describedby={error ? errorId : undefined}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <div className={confirm.confirmHeading}>
          <SectionLabel tone="mut">{kicker}</SectionLabel>
          <ModalTitle className={confirm.confirmTitle}>{title}</ModalTitle>
          {description && <ModalDescription className={styles.hint}>{description}</ModalDescription>}
        </div>
        {children}
        {error && (
          <div id={errorId} role="alert">
            <p className={confirm.error}>{typeof error === 'string' ? error : error.text}</p>
            {typeof error === 'string' ? null : <MoreDetail detail={error.detail} />}
          </div>
        )}
        <div className={confirm.actions}>
          <ModalClose asChild>
            <Button variant="secondary" size="xl">
              Cancel
            </Button>
          </ModalClose>
          <Button type="submit" variant="primary" size="xl" padX={20} disabled={busy}>
            {action}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export interface RenameDialogProps {
  file: FileEntry | null;
  onClose: () => void;
  /** Rejects with the words to show. */
  onRename: (file: FileEntry, name: string) => Promise<void>;
}

/** Rename a file saved straight into Files (FS-05): the name with its extension, the Whombat's refusal kept here. */
export function RenameDialog({ file, onClose, onRename }: RenameDialogProps) {
  const id = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | Problem | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(file?.attachment.name ?? '');
    setError(null);
  }, [file]);
  return (
    <FormDialog
      open={!!file}
      onClose={onClose}
      kicker="RENAME"
      title={`Rename “${file?.attachment.name ?? ''}”`}
      error={error}
      action="Rename"
      busy={busy}
      onSubmit={() => {
        if (!file) return;
        const next = name.trim();
        if (!next) return setError('Give the file a name.');
        if (next === file.attachment.name) return onClose();
        setBusy(true);
        onRename(file, next)
          .then(onClose)
          .catch((e: unknown) => setError(problemOf(e)))
          .finally(() => setBusy(false));
      }}
    >
      <div className={styles.field}>
        <SectionLabel as="label" htmlFor={id}>
          NAME
        </SectionLabel>
        <Input
          id={id}
          value={name}
          maxLength={255}
          invalid={!!error}
          autoComplete="off"
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
      </div>
    </FormDialog>
  );
}

export interface MoveDialogProps {
  file: FileEntry | null;
  /** Every file of the space (its folders) and the client's new folders. */
  entries: readonly FileEntry[];
  places: readonly string[];
  onClose: () => void;
  onMove: (file: FileEntry, folder: string) => Promise<void>;
}

/**
 * Move to folder… (FS-05): the space's folders to pick from (the top first, the file's own marked), or a folder path
 * typed in (`Drawings/2024`, made on the way; an existing folder's spelling is taken over).
 */
export function MoveDialog({ file, entries, places, onClose, onMove }: MoveDialogProps) {
  const id = useId();
  const [picked, setPicked] = useState<string>('');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const folders = allFolders(entries, places);
  useEffect(() => {
    setPicked(file?.folder ?? '');
    setTyped('');
    setError(null);
  }, [file]);
  const choices = ['', ...folders];
  return (
    <FormDialog
      open={!!file}
      onClose={onClose}
      kicker="MOVE TO FOLDER"
      title={`Move “${file?.attachment.name ?? ''}”`}
      description="Everyone in this conversation sees it in its new folder."
      error={error}
      action="Move"
      busy={busy}
      onSubmit={() => {
        if (!file) return;
        let folder = picked;
        if (typed.trim()) {
          const problem = folderPathProblem(typed);
          const normalized = normalizeFilesFolder(typed);
          if (problem || normalized === null) return setError(problem ?? 'That can’t be a folder.');
          folder = existingFolderSpelling(normalized, folders);
        }
        if (sameFilesFolder(folder, file.folder)) return onClose();
        setBusy(true);
        onMove(file, folder)
          .then(onClose)
          .catch((e: unknown) => setError(problemOf(e)))
          .finally(() => setBusy(false));
      }}
    >
      <div className={styles.field}>
        <SectionLabel as="span">FOLDER</SectionLabel>
        <ul className={styles.folderChoices} aria-label="Folders">
          {choices.map((folder) => (
            <li key={folder || 'top'}>
              <button
                type="button"
                className={styles.folderChoice}
                aria-pressed={!typed.trim() && sameFilesFolder(folder, picked)}
                onClick={() => {
                  setPicked(folder);
                  setTyped('');
                  setError(null);
                }}
              >
                <Icon name="folder" size={15} />
                <span>{folder ? folder.split('/').join(' / ') : FILES_COPY.top}</span>
                {file && sameFilesFolder(folder, file.folder) && (
                  <span className={styles.folderChoiceCurrent}>now</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className={styles.field}>
        <SectionLabel as="label" htmlFor={id}>
          OR A NEW FOLDER
        </SectionLabel>
        <Input
          id={id}
          value={typed}
          placeholder="Drawings/2024"
          invalid={!!error}
          autoComplete="off"
          onChange={(e) => {
            setTyped(e.target.value);
            setError(null);
          }}
        />
        <span className={styles.hint}>Up to 4 levels, separated by /.</span>
      </div>
    </FormDialog>
  );
}

export interface NewFolderDialogProps {
  open: boolean;
  /** The folder it goes in (`''`: the top). */
  parent: string;
  /** “# private”, for the title. */
  where: string;
  onClose: () => void;
  /** The new folder's whole path. */
  onCreate: (folder: string) => void;
}

/** New folder (FS-03): a place to upload or move into; it stays once a file is in it. */
export function NewFolderDialog({ open, parent, where, onClose, onCreate }: NewFolderDialogProps) {
  const id = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | Problem | null>(null);
  useEffect(() => {
    if (open) {
      setName('');
      setError(null);
    }
  }, [open]);
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      kicker="NEW FOLDER"
      title={`New folder in ${parent ? folderName(parent) : where}`}
      description="It stays once a file is in it."
      error={error}
      action="Create"
      busy={false}
      onSubmit={() => {
        const problem = folderNameProblem(name, parent);
        const folder = childFolder(parent, name);
        if (problem || folder === null) return setError(problem ?? 'That can’t be a folder name.');
        onCreate(folder);
        onClose();
      }}
    >
      <div className={styles.field}>
        <SectionLabel as="label" htmlFor={id}>
          NAME
        </SectionLabel>
        <Input
          id={id}
          value={name}
          placeholder="Drawings"
          invalid={!!error}
          autoComplete="off"
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
      </div>
    </FormDialog>
  );
}

export interface RemoveDialogProps {
  file: FileEntry | null;
  /** “#private”, “your DM with Dusty”. */
  where: string;
  onClose: () => void;
  onRemove: (file: FileEntry) => Promise<void>;
  /** The sentence, from the client (`removeFileText`). */
  text: (file: FileEntry) => string;
}

/** Remove from Files (FS-06): a message's file stays on its message; a saved one is deleted for everyone. */
export function RemoveDialog({ file, where, onClose, onRemove, text }: RemoveDialogProps) {
  const [error, setError] = useState<string | Problem | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (file) setError(null);
  }, [file]);
  return (
    <ConfirmDialog
      open={!!file}
      onOpenChange={(o) => !o && onClose()}
      kicker="REMOVE FROM FILES"
      title={`Remove “${file?.attachment.name ?? ''}” from Files?`}
      confirmLabel={FILES_COPY.remove}
      busy={busy}
      error={typeof error === 'string' ? error : (error?.text ?? null)}
      onConfirm={() => {
        if (!file) return;
        setBusy(true);
        onRemove(file)
          .then(onClose)
          .catch((e: unknown) => setError(problemOf(e)))
          .finally(() => setBusy(false));
      }}
    >
      {file ? text(file) : where}
    </ConfirmDialog>
  );
}
