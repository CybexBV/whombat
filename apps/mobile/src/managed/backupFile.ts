/**
 * The backup file on the phone (contracts 0.79.0, CT-335; Whombat backup-file.md BF-01…; backup-file-android.md
 * AP-1211…): what the Backup file screen shows, worked out from the shared hooks (`useBackupMaker`,
 * `useBackupRestorer` in `@whombat/client/react`), and the phone's own pieces — where a downloaded file is written (a
 * document Android's “Save as” made, filled chunk by chunk), the picked file to restore, which finished restores were
 * put away, and the question before leaving while a file moves. Every word is the contracts' (`BACKUP_COPY`), the
 * client's (`BACKUP_FILE_TEXT`) or the phone's few in `COPY.backupFile`. Pure: the native pieces are injected
 * (`backupFileSave.ts` binds them), so all of it is unit-tested in Node.
 */
import {
  type BackupDownloadRow,
  type BackupFileSink,
  type BackupProgressView,
  type BackupRestoreLink,
  type BackupRestoreRow,
  backupFileText,
  backupRestoreFileLine,
} from '@whombat/client';
import type { SyncStorage } from '@whombat/client/managed';
import type { BackupMaker, BackupRestorer, DismissedRestores } from '@whombat/client/react';
import {
  type BackupOnDifferent,
  backupCopy,
  backupDownloadLabel,
  backupFileErrorText,
  backupOnDifferentLabels,
} from '@whombat/core/backup';
import { hostRepointWords } from '@whombat/core/domain';
import { managedCopy } from './copy';

/* Download a backup ------------------------------------------------------------------------------------------------ */

/** A button as the panel shows it. */
export interface PanelButton {
  label: string;
  busy: boolean;
}

/** What “Download a backup” shows at each step (AP-1212, AP-1213). */
export type BackupDownloadPanel =
  | {
      step: 'choose';
      rows: BackupDownloadRow[];
      /** “Download · 1.8 MB”: makes the file. */
      make: PanelButton;
      /** The password's own problem, after Download was pressed with one too short; under the field. */
      passwordError: string | null;
      /**
       * “Make these the default” (as the sketch and the web, AP-1188); “These are the default now.” once saved, until a
       * tick changes.
       */
      defaults: { offer: boolean; saving: boolean; saved: string | null };
      /** Why the last file couldn't be made, then the last action's failure. */
      notes: string[];
    }
  | {
      step: 'making';
      /** Its name, “Making the file · Messages · 42 %” and the bar. */
      file: BackupFileCard;
      /** Stops making it (`backups.remove`). */
      cancel: PanelButton;
      error: string | null;
    }
  | {
      step: 'ready';
      /** “Your file is ready.” */
      title: string;
      /** Its name and “1.8 MB · expires in 23 hours”. */
      file: BackupFileCard;
      /** Saving it on the phone: “Downloading · 42 %”; null otherwise. */
      transfer: BackupProgressView | null;
      /** “Saved to your device.” after a download went through. */
      saved: string | null;
      /** “Download · 1.8 MB”, then “Download again” (secondary); null while it downloads (Cancel then). */
      save: (PanelButton & { primary: boolean }) | null;
      remove: PanelButton & { disabled: boolean };
      error: string | null;
    };

type MakerView = Pick<
  BackupMaker,
  | 'rows'
  | 'label'
  | 'starting'
  | 'error'
  | 'defaults'
  | 'file'
  | 'step'
  | 'progress'
  | 'readyLine'
  | 'failure'
  | 'removing'
  | 'download'
  | 'downloaded'
>;

export function backupDownloadPanel(maker: MakerView, locale?: string | null): BackupDownloadPanel {
  const BACKUP_COPY = backupCopy(locale);
  const BACKUP_FILE_TEXT = backupFileText(locale);
  const passwordShort = maker.error === BACKUP_COPY.download.passwordShort;
  if (maker.step === 'making' && maker.file) {
    const progress = maker.progress ?? { pct: 0, text: BACKUP_COPY.download.making };
    return {
      step: 'making',
      file: { name: maker.file.name, line: progress.text, pct: progress.pct },
      cancel: { label: BACKUP_COPY.restore.cancel, busy: maker.removing },
      error: maker.error,
    };
  }
  if (maker.step === 'ready' && maker.file) {
    const d = maker.download;
    const downloading = d.status === 'downloading';
    return {
      step: 'ready',
      title: BACKUP_COPY.download.ready,
      file: { name: maker.file.name, line: maker.readyLine, pct: null },
      transfer: downloading ? { pct: d.pct, text: BACKUP_FILE_TEXT.downloading(d.pct) } : null,
      saved: d.status === 'saved' ? BACKUP_FILE_TEXT.saved : null,
      // As on the web: the same button after a failed download (the reason is said under it).
      save: downloading
        ? null
        : {
            label: maker.downloaded
              ? BACKUP_COPY.download.downloadAgain
              : backupDownloadLabel(maker.file.size ?? 0, locale),
            busy: false,
            primary: !maker.downloaded,
          },
      remove: { label: BACKUP_COPY.download.remove, busy: maker.removing, disabled: downloading },
      error: d.error ?? maker.error,
    };
  }
  return {
    step: 'choose',
    rows: maker.rows,
    make: { label: maker.label, busy: maker.starting },
    passwordError: passwordShort ? maker.error : null,
    defaults: {
      offer: !maker.defaults.saved,
      saving: maker.defaults.saving,
      saved: maker.defaults.saved ? BACKUP_COPY.download.defaultSaved : null,
    },
    notes: [maker.failure, passwordShort ? null : maker.error].filter((n): n is string => !!n),
  };
}

/** TalkBack’s name for a category tick: “The agent, 12 KB. Its name, face, model and keys”. */
export function downloadRowLabel(row: Pick<BackupDownloadRow, 'label' | 'size' | 'meta'>): string {
  const head = row.size ? `${row.label}, ${row.size}` : row.label;
  return row.meta ? `${head}. ${row.meta}` : head;
}

/* Restore from a file ---------------------------------------------------------------------------------------------- */

/** The chosen file's card: its name and one line (uploading, uploaded, or who made it where). */
export interface BackupFileCard {
  name: string;
  line: string | null;
  /** The upload's bar, 0–100; null when nothing moves. */
  pct: number | null;
}

/** What “Restore from a file” shows at each step (AP-1216, AP-1217). */
export type BackupRestorePanel =
  | {
      step: 'choose';
      choose: PanelButton;
      /** An upload that stopped part-way: its name and “Uploading stopped at 42 %. Choose the same file to go on.” */
      stopped: BackupFileCard | null;
      error: string | null;
    }
  | { step: 'uploading'; file: BackupFileCard; cancel: PanelButton }
  | {
      step: 'password';
      file: BackupFileCard;
      /** Open, off until a password is typed. */
      open: PanelButton & { disabled: boolean };
      /** “That password doesn’t open this file.” under the field. */
      passwordError: string | null;
      cancel: PanelButton;
      error: string | null;
    }
  | {
      step: 'preview';
      file: BackupFileCard;
      /** Notes about the whole file, one sentence each. */
      notes: string[];
      rows: BackupRestoreRow[];
      /** “When something is different”: shown when a ticked category has something that differs. */
      different: {
        show: boolean;
        value: BackupOnDifferent;
        options: { value: BackupOnDifferent; label: string }[];
      };
      /**
       * The address question (BF-15; AP-4420): “Your servers look for your Whombat at … This Whombat is at …” over Point
       * them here · Leave them, while the servers are ticked and the file's Whombat was elsewhere; null otherwise.
       */
      address: {
        text: string;
        value: ServersAnswer;
        options: { value: ServersAnswer; label: string }[];
      } | null;
      /** Restore, off while nothing is ticked. */
      restore: PanelButton & { disabled: boolean };
      cancel: PanelButton;
      error: string | null;
    }
  | {
      step: 'restoring';
      /** Its name, “Restoring · Automations · 42 %” and the bar. */
      file: BackupFileCard;
    }
  | {
      step: 'outcome';
      /** The restored file: its name and “Made 11 Oct 2026 on Lumio BV”. */
      file: BackupFileCard | null;
      failed: boolean;
      /** “Restored”, or why it stopped. */
      title: string;
      lines: string[];
      links: { link: BackupRestoreLink; label: string }[];
      /**
       * Servers still looking for the old address (BF-15; AP-4420): each with “Point it here”, which opens Add a server
       * filled in with its address.
       */
      toPoint: { id: string; name: string; address: string | null; label: string }[];
      /** “Done”, or “Try again” after a failure: puts it away. */
      dismiss: string;
    };

/** The address question's two answers (BF-15). */
export type ServersAnswer = 'here' | 'leave';

type RestorerView = Pick<
  BackupRestorer,
  | 'step'
  | 'password'
  | 'ticked'
  | 'upload'
  | 'stopped'
  | 'uploading'
  | 'opening'
  | 'preview'
  | 'madeLine'
  | 'rows'
  | 'fileNotes'
  | 'hasDifferent'
  | 'onDifferent'
  | 'serversQuestion'
  | 'pointHere'
  | 'starting'
  | 'cancelling'
  | 'restoreView'
  | 'progress'
  | 'outcome'
  | 'error'
  | 'errorCode'
>;

function linkLabels(locale?: string | null): Record<BackupRestoreLink, string> {
  const text = backupFileText(locale);
  return { connections: text.openConnections, automations: text.openAutomations };
}

/** What the restore panel shows; `timeZone` (the viewer's) dates a running or finished restore's file. */
export function backupRestorePanel(
  restorer: RestorerView,
  timeZone: string,
  locale?: string | null,
): BackupRestorePanel {
  const BACKUP_COPY = backupCopy(locale);
  const BACKUP_FILE_TEXT = backupFileText(locale);
  const HOST_REPOINT_WORDS = hostRepointWords(locale);
  const cancel = { label: BACKUP_COPY.restore.cancel, busy: restorer.cancelling };
  const r = restorer.restoreView;
  switch (restorer.step) {
    case 'uploading': {
      const u = restorer.uploading;
      // Before the first byte goes (a managed Whombat's upload hashes the file first) it says “Uploading…”.
      const started = !!u && u.done > 0;
      return {
        step: 'uploading',
        file: {
          name: u?.fileName ?? '',
          line: started ? BACKUP_FILE_TEXT.uploading(u.pct) : BACKUP_COPY.restore.uploading,
          pct: started ? u.pct : 0,
        },
        cancel,
      };
    }
    case 'password': {
      const wrong = restorer.errorCode === 'wrong_password';
      return {
        step: 'password',
        file: {
          name: restorer.upload?.fileName ?? '',
          line: restorer.upload ? BACKUP_FILE_TEXT.uploaded(restorer.upload.size) : null,
          pct: null,
        },
        open: {
          label: restorer.opening ? BACKUP_COPY.restore.opening : BACKUP_COPY.restore.open,
          busy: restorer.opening,
          disabled: restorer.password.length === 0,
        },
        passwordError: wrong ? restorer.error : null,
        cancel,
        error: wrong ? null : restorer.error,
      };
    }
    case 'preview':
      return {
        step: 'preview',
        file: {
          name: restorer.preview?.fileName ?? restorer.upload?.fileName ?? '',
          line: restorer.madeLine,
          pct: null,
        },
        notes: restorer.fileNotes,
        rows: restorer.rows,
        different: {
          show: restorer.hasDifferent,
          value: restorer.onDifferent,
          options: (['keep', 'replace'] as const).map((value) => ({
            value,
            label: backupOnDifferentLabels(locale)[value],
          })),
        },
        address: restorer.serversQuestion
          ? {
              text: restorer.serversQuestion,
              value: restorer.pointHere ? 'here' : 'leave',
              options: [
                { value: 'here', label: HOST_REPOINT_WORDS.pointThemHere },
                { value: 'leave', label: HOST_REPOINT_WORDS.leaveThem },
              ],
            }
          : null,
        restore: {
          label: restorer.starting ? BACKUP_COPY.restore.restoring : BACKUP_COPY.restore.restore,
          busy: restorer.starting,
          disabled: restorer.ticked.length === 0,
        },
        cancel,
        error: restorer.error,
      };
    case 'restoring': {
      const progress = restorer.progress ?? { pct: 0, text: BACKUP_COPY.restore.restoring };
      return {
        step: 'restoring',
        file: { name: r?.fileName ?? '', line: progress.text, pct: progress.pct },
      };
    }
    case 'done':
    case 'failed': {
      const o = restorer.outcome;
      const failed = o?.failed ?? restorer.step === 'failed';
      return {
        step: 'outcome',
        file: r ? { name: r.fileName, line: backupRestoreFileLine(r, timeZone, locale), pct: null } : null,
        failed,
        title:
          o?.title ?? (failed ? backupFileErrorText('restore_failed', locale) : BACKUP_COPY.restore.done),
        lines: o?.lines ?? [],
        links: (o?.links ?? []).map((link) => ({ link, label: linkLabels(locale)[link] })),
        toPoint: (o?.toPoint ?? []).map((server) => ({
          id: server.id,
          name: server.name,
          address: server.address ?? null,
          label: HOST_REPOINT_WORDS.pointItHere,
        })),
        dismiss: failed ? BACKUP_FILE_TEXT.tryAgain : BACKUP_FILE_TEXT.done,
      };
    }
    default: {
      const s = restorer.stopped;
      return {
        step: 'choose',
        choose: { label: BACKUP_COPY.restore.choose, busy: false },
        stopped: s
          ? { name: s.fileName, line: BACKUP_FILE_TEXT.stopped(stoppedPct(s.received, s.size)), pct: null }
          : null,
        error: restorer.error,
      };
    }
  }
}

function stoppedPct(received: number, size: number): number {
  if (size <= 0) return 0;
  return Math.min(99, Math.floor((received / size) * 100));
}

/**
 * TalkBack's name for a category in the preview: “Memories. 130 new, 12 already here, 3 different”, line, notes (a row
 * that can't come back says so in its chip and line: “Servers. Can’t come back. This Whombat already watches …”).
 */
export function restoreRowLabel(row: Pick<BackupRestoreRow, 'label' | 'chips' | 'hint' | 'notes'>): string {
  return [row.label, row.chips.map((c) => c.label).join(', '), row.hint, ...row.notes]
    .filter((part): part is string => !!part)
    .join('. ');
}

/* Leaving while a file moves -------------------------------------------------------------------------------------- */

/** What to ask before leaving while a file downloads or uploads (leaving stops it); null when nothing moves. */
export function backupLeaveQuestion(
  state: {
    downloading: boolean;
    uploading: boolean;
  },
  locale?: string,
): { title: string; text: string; stay: string; stop: string } | null {
  const T = managedCopy(locale).backupFile;
  if (state.downloading)
    return {
      title: T.leave.downloadTitle,
      text: T.leave.downloadText,
      stay: T.leave.stay,
      stop: T.leave.stop,
    };
  if (state.uploading)
    return { title: T.leave.uploadTitle, text: T.leave.uploadText, stay: T.leave.stay, stop: T.leave.stop };
  return null;
}

/* Where a download goes ------------------------------------------------------------------------------------------- */

/**
 * The type a saved file is created with (AP-1214): Android's own name for a file it doesn't know, so no document
 * provider adds an extension of its own to `lumio-bv-2026-10-11.wbk` (the contracts' `application/vnd.whombat.backup`
 * is unknown to Android).
 */
export const BACKUP_SAVE_MIME = 'application/octet-stream';

/** The native pieces of choosing where a download goes. */
export interface SaveTargetApi {
  /** Android's “Save as” (`whombat-transfer`): the new document's URI, null when backed out; null without it. */
  saveAs: ((name: string, mimeType: string) => Promise<string | null>) | null;
  /** expo-file-system's folder picker: the folder, null when backed out. */
  pickFolder: () => Promise<{ createFile(name: string, mimeType: string): { uri: string } } | null>;
}

/** Asks where to save `name` (“Save as”, else a folder and a new file in it); the document's URI, or null. */
export async function pickSaveTarget(api: SaveTargetApi, name: string): Promise<string | null> {
  if (api.saveAs) return api.saveAs(name, BACKUP_SAVE_MIME);
  const folder = await api.pickFolder();
  return folder ? folder.createFile(name, BACKUP_SAVE_MIME).uri : null;
}

/** Writing into a document by its URI (expo-file-system's file handle on `content://`, in the app). */
export interface WritableDocuments {
  openWrite(uri: string): { writeBytes(bytes: Uint8Array): void; close(): void };
  remove(uri: string): void;
}

/**
 * The download's sink (AP-1214): every chunk goes straight into the document as it arrives (opened on the first one),
 * never the whole file in memory; a download that fails or is cancelled closes it and deletes it, so no half file
 * stays where the person saved it.
 */
export function documentSink(docs: WritableDocuments, uri: string): BackupFileSink {
  let handle: ReturnType<WritableDocuments['openWrite']> | null = null;
  return {
    write(chunk) {
      handle ??= docs.openWrite(uri);
      handle.writeBytes(chunk);
    },
    close() {
      (handle ?? docs.openWrite(uri)).close();
      handle = null;
    },
    abort() {
      try {
        handle?.close();
      } catch {
        // already closed
      }
      handle = null;
      try {
        docs.remove(uri);
      } catch {
        // The provider wouldn't delete it: nothing more to do.
      }
    },
  };
}

/* The file to restore --------------------------------------------------------------------------------------------- */

/** The picked document (`expo-document-picker`, not copied) as an upload source, or why it can't be one. */
export function pickedBackupFile(
  asset: {
    uri: string;
    name?: string | null;
    size?: number | null;
    mimeType?: string | null;
  },
  locale?: string,
): { file: { uri: string; name: string; type: string; size: number } } | { problem: string } {
  // The size is staged before the first byte (BF-10); a provider that doesn't say it can't be uploaded from.
  if (!asset.size || asset.size <= 0) return { problem: managedCopy(locale).backupFile.noSize };
  return {
    file: {
      uri: asset.uri,
      name: asset.name?.trim() || 'backup.wbk',
      type: asset.mimeType ?? BACKUP_SAVE_MIME,
      size: asset.size,
    },
  };
}

/* Restores put away ----------------------------------------------------------------------------------------------- */

const DISMISSED_KEY = 'backup.dismissedRestores';
/** More than `backups.list` ever shows (`BACKUP_RESTORES_LISTED`, 10). */
const DISMISSED_KEPT = 20;

/**
 * The restores this person put away on this phone (“Done”), kept in a small file so a finished restore's summary
 * isn't shown again after the app restarts (AP-1219; the web keeps them in local storage). Ids only, newest last.
 */
export function storedDismissedRestores(storage: SyncStorage): DismissedRestores {
  const read = (): string[] => {
    try {
      const v = JSON.parse(storage.getItem(DISMISSED_KEY) ?? '[]') as unknown;
      return Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  };
  return {
    read: () => new Set(read()),
    add(id) {
      const ids = [...read().filter((x) => x !== id), id].slice(-DISMISSED_KEPT);
      storage.setItem(DISMISSED_KEY, JSON.stringify(ids));
    },
  };
}
