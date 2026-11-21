/**
 * Backup files in React (contracts 0.79.0, CT-335; app docs/decisions/backup-file.md AP-1181…): the two panels of
 * Settings → This Whombat → BACKUP FILE as hooks, the same on the web and on Android. `useBackupMaker` is “Download a
 * backup” (ticks, password, make, follow, download, remove, “Make these the default”); `useBackupRestorer` is “Restore
 * from a file” (upload, password, preview, restore, follow, what it did). The platform brings only its pieces: a
 * `BackupFileSink` to download into and a `ChunkSource` to upload from. The password lives in the hook's state while
 * it is needed and nowhere else (BF-06).
 */
import { useQueryClient } from '@tanstack/react-query';
import type { BackupCategoryId, BackupOnDifferent, BackupRestorePreview } from '@whombat/core/backup';
import { backupFileErrorText } from '@whombat/core/backup';
import type {
  BackupDefaults,
  BackupFileView,
  BackupListResponse,
  BackupRestoreView,
  BackupUploadView,
} from '@whombat/core/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type BackupDownloadRow,
  type BackupMakeStep,
  type BackupProgressView,
  type BackupRestoreOutcome,
  type BackupRestoreRow,
  type BackupRestoreStep,
  backupChosenBytes,
  backupDownloadRows,
  backupFileFailure,
  backupFileProgress,
  backupFileReadyLine,
  backupMakeLabel,
  backupMakeProblem,
  backupMakeStep,
  backupProblem,
  backupRestoreBlocked,
  backupRestoreFileNotes,
  backupRestoreHasDifferent,
  backupRestoreMadeLine,
  backupRestoreOutcome,
  backupRestoreProgress,
  backupRestoreRows,
  backupRestoreStartingTicks,
  backupRestoreStep,
  backupServersQuestion,
  backupShownTicks,
  backupStartingTicks,
  backupsBusy,
  backupTransferPct,
  currentBackupFile,
  currentBackupRestore,
  currentBackupUpload,
  resumableBackupUpload,
  sameBackupCategories,
  toggleBackupCategory,
} from '../backup/model';
import {
  type BackupFileSink,
  type BackupTransferProgress,
  downloadBackupFile,
  uploadBackupFile,
} from '../backup/transfer';
import { unwrap } from '../http/client';
import { invalidateBackups } from '../query/apply';
import { queryKeys } from '../query/keys';
import type { ChunkSource } from '../session/types';
import { useWhombat } from './context';
import { useBackupDefaults, useBackupEstimate, useBackupList } from './queries';

/** How often the list is read while a file is made or a restore runs (the server's progress comes once a second). */
export const BACKUP_POLL_MS = 1000;

/**
 * The person's backup files, uploads and restores (`backups.list`); read every `BACKUP_POLL_MS` while a file is being
 * made or a restore runs, so progress moves where no realtime frame arrives. Null `burrow` waits.
 */
export function useBackupFiles(burrow: string | null) {
  return useBackupList(burrow ? { params: { burrow } } : null, {
    refetchInterval: (query) => (backupsBusy(query.state.data) ? BACKUP_POLL_MS : false),
  });
}

/** A download into the platform's sink, as the panel shows it. */
export interface BackupDownloadState {
  status: 'idle' | 'downloading' | 'saved' | 'failed';
  done: number;
  total: number;
  /** 0–100. */
  pct: number;
  error: string | null;
}

const IDLE_DOWNLOAD: BackupDownloadState = { status: 'idle', done: 0, total: 0, pct: 0, error: null };

export interface BackupMaker {
  /** The estimate is being read (sizes and meta lines aren't in yet). */
  loading: boolean;
  /** The estimate couldn't be read (the ticks still work; sizes are missing). */
  loadError: unknown;
  rows: BackupDownloadRow[];
  ticked: BackupCategoryId[];
  toggle(id: BackupCategoryId, on?: boolean): void;
  password: string;
  setPassword(password: string): void;
  /** Why Download can't run now, in the contracts' words; null when it can. */
  problem: string | null;
  /** “Download · 1.8 MB”. */
  label: string;
  /** Estimated bytes of the ticked categories (null until the estimate is in). */
  bytes: number | null;
  /** Starts making the file (`backups.create`); the password is cleared once it is sent. */
  make(): Promise<void>;
  /** `backups.create` is on its way. */
  starting: boolean;
  /** The last action's failure (make, remove, defaults), in words; null otherwise. */
  error: string | null;
  /** “Make these the default”: shown while the ticks differ from the burrow's defaults. */
  defaults: { differ: boolean; saving: boolean; saved: boolean; save(): Promise<void> };
  /** The file the panel shows: being made, ready, or failed (`failure` then says why); null before any. */
  file: BackupFileView | null;
  step: BackupMakeStep;
  /** While it is made: “Making the file · Messages · 42 %”. */
  progress: BackupProgressView | null;
  /** When it is ready, under its name: “1.8 MB · expires in 23 hours”. */
  readyLine: string | null;
  /** Why the newest file failed: “The file couldn’t be made. …”. */
  failure: string | null;
  remove(): Promise<void>;
  removing: boolean;
  download: BackupDownloadState;
  /** Downloads the ready file into `sink` (resumable, checked); `download` follows it. */
  startDownload(sink: BackupFileSink): Promise<void>;
  cancelDownload(): void;
  /** This file was saved here once already (“Download again”). */
  downloaded: boolean;
  /** Marks the ready file as saved here (a platform that hands the download to the browser, e.g. a link). */
  markDownloaded(): void;
}

/**
 * “Download a backup” (AP-1188…AP-1191). Starts from the burrow's default ticks, sizes and meta lines from
 * `backups.estimate`; Download makes the file, which the panel then follows until it is ready (or failed); Download
 * then saves it, Remove deletes it. `now` is for the ready file's expiry (default `Date.now`).
 */
export function useBackupMaker(burrow: string | null, options: { now?: () => number } = {}): BackupMaker {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const input = burrow ? { params: { burrow } } : null;
  const defaults = useBackupDefaults(input);
  const estimate = useBackupEstimate(input);
  const list = useBackupFiles(burrow);
  const [chosen, setChosen] = useState<BackupCategoryId[] | null>(null);
  const [password, setPassword] = useState('');
  const [starting, setStarting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [download, setDownload] = useState<BackupDownloadState>(IDLE_DOWNLOAD);
  const [downloadedIds, setDownloadedIds] = useState<ReadonlySet<string>>(() => new Set());
  const abort = useRef<AbortController | null>(null);
  const now = (options.now ?? Date.now)();

  // Only what this Whombat offers is listed and ticked (servers where it watches servers, AP-4411).
  const startingTicks = backupStartingTicks(defaults.data, estimate.data);
  const ticked = chosen ? backupShownTicks(chosen, estimate.data) : startingTicks;
  const file = currentBackupFile(list.data, now);
  const step = backupMakeStep(file);

  useEffect(() => () => abort.current?.abort(), []);

  const refreshList = useCallback(() => {
    if (burrow) void qc.invalidateQueries({ queryKey: queryKeys.scope('backups.list', { burrow }) });
  }, [qc, burrow]);

  const putFile = useCallback(
    (view: BackupFileView) => {
      if (!burrow) return;
      qc.setQueryData<BackupListResponse>(
        queryKeys.endpoint(client.backups.list.endpoint, { params: { burrow } }),
        (d) => (d ? { ...d, files: [view, ...d.files.filter((f) => f.id !== view.id)] } : d),
      );
    },
    [qc, client, burrow],
  );

  const make = useCallback(async () => {
    if (!burrow) return;
    const why = backupMakeProblem({ estimate: estimate.data, ticked, password });
    if (why) {
      setError(why);
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const { file: made } = unwrap(
        await client.backups.create({ params: { burrow }, body: { categories: ticked, password } }),
      );
      setPassword('');
      setDownload(IDLE_DOWNLOAD);
      putFile(made);
    } catch (e) {
      setError(backupProblem(e).message);
    } finally {
      setStarting(false);
      refreshList();
    }
  }, [burrow, client, estimate.data, ticked, password, putFile, refreshList]);

  const saveDefaults = useCallback(async () => {
    if (!burrow) return;
    setSaving(true);
    setError(null);
    try {
      const next = unwrap(
        await client.backups.setDefaults({ params: { burrow }, body: { categories: ticked } }),
      );
      qc.setQueryData<BackupDefaults>(
        queryKeys.endpoint(client.backups.defaults.endpoint, { params: { burrow } }),
        next,
      );
      setSaved(true);
    } catch (e) {
      setError(backupProblem(e).message);
    } finally {
      setSaving(false);
    }
  }, [burrow, client, qc, ticked]);

  const remove = useCallback(async () => {
    if (!burrow || !file) return;
    abort.current?.abort();
    setRemoving(true);
    setError(null);
    try {
      unwrap(await client.backups.remove({ params: { burrow, backupFileId: file.id } }));
      if (burrow)
        qc.setQueryData<BackupListResponse>(
          queryKeys.endpoint(client.backups.list.endpoint, { params: { burrow } }),
          (d) => (d ? { ...d, files: d.files.filter((f) => f.id !== file.id) } : d),
        );
      setDownload(IDLE_DOWNLOAD);
    } catch (e) {
      setError(backupProblem(e).message);
    } finally {
      setRemoving(false);
      refreshList();
    }
  }, [burrow, client, file, qc, refreshList]);

  const startDownload = useCallback(
    async (sink: BackupFileSink) => {
      if (!burrow || !file || file.status !== 'ready') return;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      const total = file.size ?? 0;
      setDownload({ status: 'downloading', done: 0, total, pct: 0, error: null });
      const onProgress = (p: BackupTransferProgress) =>
        setDownload({
          status: 'downloading',
          done: p.done,
          total: p.total,
          pct: backupTransferPct(p.done, p.total),
          error: null,
        });
      try {
        await downloadBackupFile(client.session, { burrow, file }, sink, {
          signal: controller.signal,
          onProgress,
        });
        setDownload({ status: 'saved', done: total, total, pct: 100, error: null });
        setDownloadedIds((s) => new Set(s).add(file.id));
      } catch (e) {
        const p = backupProblem(e, 'download');
        setDownload(p.cancelled ? IDLE_DOWNLOAD : { ...IDLE_DOWNLOAD, status: 'failed', error: p.message });
        // A file that isn't there any more leaves the panel.
        if (p.code === 'expired') refreshList();
      } finally {
        if (abort.current === controller) abort.current = null;
      }
    },
    [burrow, client, file, refreshList],
  );

  const differ = !sameBackupCategories(ticked, startingTicks);
  return {
    loading: estimate.isPending && !!burrow,
    loadError: estimate.error,
    rows: backupDownloadRows(estimate.data, ticked),
    ticked,
    toggle: (id, on) => {
      setSaved(false);
      setError(null);
      setChosen((prev) => toggleBackupCategory(prev ?? ticked, id, on));
    },
    password,
    setPassword: (value) => {
      setError(null);
      setPassword(value);
    },
    problem: backupMakeProblem({ estimate: estimate.data, ticked, password }),
    label: backupMakeLabel(estimate.data, ticked),
    bytes: backupChosenBytes(estimate.data, ticked),
    make,
    starting,
    error,
    defaults: { differ: differ && !!defaults.data, saving, saved: saved && !differ, save: saveDefaults },
    file,
    step,
    progress: file?.status === 'making' ? backupFileProgress(file) : null,
    readyLine: file?.status === 'ready' ? backupFileReadyLine(file, now) : null,
    failure: backupFileFailure(file),
    remove,
    removing,
    download,
    startDownload,
    cancelDownload: () => abort.current?.abort(),
    downloaded: !!file && downloadedIds.has(file.id),
    markDownloaded: () => {
      if (file) setDownloadedIds((s) => new Set(s).add(file.id));
    },
  };
}

/** Restores this person put away on this device (their summary isn't shown again). */
export interface DismissedRestores {
  read(): ReadonlySet<string>;
  add(id: string): void;
}

/** Kept in memory: a reload shows a finished restore's summary again (the web keeps them in `localStorage`). */
export function memoryDismissedRestores(): DismissedRestores {
  const ids = new Set<string>();
  return { read: () => ids, add: (id) => ids.add(id) };
}

/** The local upload while it runs. */
export interface BackupUploadingState {
  fileName: string;
  size: number;
  done: number;
  pct: number;
}

export interface BackupRestorer {
  step: BackupRestoreStep;
  /** The staged file (uploaded, or stopped part-way: `stopped`); null before one is chosen. */
  upload: BackupUploadView | null;
  /** An upload that stopped part-way (the page closed): choosing the same file goes on from `received`. */
  stopped: BackupUploadView | null;
  uploading: BackupUploadingState | null;
  /** Picks a file: checks its start, stages (or resumes) it and uploads it. */
  choose(source: ChunkSource): Promise<void>;
  password: string;
  setPassword(password: string): void;
  /** Opens the uploaded file with the password (`backups.inspect`). */
  open(): Promise<void>;
  opening: boolean;
  preview: BackupRestorePreview | null;
  /** “Made 11 Oct 2026 on Lumio BV · Whombat 0.83”. */
  madeLine: string | null;
  rows: BackupRestoreRow[];
  fileNotes: string[];
  ticked: BackupCategoryId[];
  toggle(id: BackupCategoryId, on?: boolean): void;
  /** Whether “When something is different” applies (a ticked category differs). */
  hasDifferent: boolean;
  onDifferent: BackupOnDifferent;
  setOnDifferent(choice: BackupOnDifferent): void;
  /**
   * The address question (BF-15; AP-4414): “Your servers look for your Whombat at … This Whombat is at …”, while the
   * servers are ticked and the file's Whombat was elsewhere; null otherwise.
   */
  serversQuestion: string | null;
  /** The answer: Point them here (true, the default) or Leave them; sent as `servers.pointHere` with the question. */
  pointHere: boolean;
  setPointHere(pointHere: boolean): void;
  /** Starts the restore (`backups.restore`); the password is cleared once it is sent. */
  restore(): Promise<void>;
  starting: boolean;
  /** Cancel: stops an upload and removes the staged file. */
  cancel(): Promise<void>;
  cancelling: boolean;
  /** The restore the panel follows or shows (running, done, failed). */
  restoreView: BackupRestoreView | null;
  progress: BackupProgressView | null;
  outcome: BackupRestoreOutcome | null;
  /** “Done” / “Try again”: puts the finished restore away (the staged file, if still here, asks for its password). */
  dismiss(): void;
  /** The last action's failure (upload, open, restore, cancel), in words; null otherwise. */
  error: string | null;
  /** That failure's code (`wrong_password` keeps the password field in front). */
  errorCode: string | null;
}

/**
 * “Restore from a file” (AP-1192…AP-1198): choose a `.wbk` → it uploads (resuming a stopped upload of the same file) →
 * its password → the preview per category (New / Already here / Different) with every category the file has ticked →
 * Restore, followed until it is done → what came back and what needs the person, until they put it away.
 */
export function useBackupRestorer(
  burrow: string | null,
  options: { dismissed?: DismissedRestores; now?: () => number } = {},
): BackupRestorer {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const list = useBackupFiles(burrow);
  const dismissedStore = useMemo(() => options.dismissed ?? memoryDismissedRestores(), [options.dismissed]);
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(() => new Set(dismissedStore.read()));
  const [uploading, setUploading] = useState<BackupUploadingState | null>(null);
  const [password, setPasswordState] = useState('');
  const [opening, setOpening] = useState(false);
  const [preview, setPreview] = useState<{ uploadId: string; preview: BackupRestorePreview } | null>(null);
  const [chosen, setChosen] = useState<BackupCategoryId[] | null>(null);
  const [onDifferent, setOnDifferent] = useState<BackupOnDifferent>('keep');
  const [pointHere, setPointHere] = useState(true);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<{ message: string; code: string | null } | null>(null);
  const transfer = useRef<{ controller: AbortController; staged: BackupUploadView | null } | null>(null);
  const now = (options.now ?? Date.now)();

  useEffect(() => () => transfer.current?.controller.abort(), []);

  const upload = currentBackupUpload(list.data, now);
  const restoreView = currentBackupRestore(list.data, dismissedIds);
  const shown = preview && upload && preview.uploadId === upload.id ? preview.preview : null;
  const step = backupRestoreStep({
    restore: restoreView,
    uploading: uploading !== null,
    upload,
    preview: shown,
  });
  const ticked = chosen ?? (shown ? backupRestoreStartingTicks(shown) : []);
  const serversQuestion = shown ? backupServersQuestion(shown, ticked) : null;

  const listKey = useMemo(
    () => (burrow ? queryKeys.endpoint(client.backups.list.endpoint, { params: { burrow } }) : null),
    [client, burrow],
  );
  const patchList = useCallback(
    (change: (d: BackupListResponse) => BackupListResponse) => {
      if (listKey) qc.setQueryData<BackupListResponse>(listKey, (d) => (d ? change(d) : d));
    },
    [qc, listKey],
  );
  const refreshList = useCallback(() => invalidateBackups(qc), [qc]);
  const fail = useCallback((e: unknown, during: 'upload' | 'other' = 'other') => {
    const p = backupProblem(e, during);
    setError(p.cancelled ? null : { message: p.message, code: p.code });
  }, []);

  const choose = useCallback(
    async (source: ChunkSource) => {
      if (!burrow) return;
      transfer.current?.controller.abort();
      const controller = new AbortController();
      const current = { controller, staged: null as BackupUploadView | null };
      transfer.current = current;
      setError(null);
      setPreview(null);
      setChosen(null);
      setPasswordState('');
      setUploading({ fileName: source.name, size: source.size, done: 0, pct: 0 });
      try {
        const done = await uploadBackupFile(client, burrow, source, {
          resume: resumableBackupUpload(list.data, source, Date.now()),
          signal: controller.signal,
          onStaged: (staged) => {
            current.staged = staged;
          },
          onProgress: (p) =>
            setUploading({
              fileName: source.name,
              size: source.size,
              done: p.done,
              pct: backupTransferPct(p.done, p.total),
            }),
        });
        patchList((d) => ({ ...d, uploads: [done, ...d.uploads.filter((u) => u.id !== done.id)] }));
      } catch (e) {
        fail(e, 'upload');
      } finally {
        if (transfer.current === current) transfer.current = null;
        setUploading(null);
        refreshList();
      }
    },
    [burrow, client, list.data, patchList, refreshList, fail],
  );

  const open = useCallback(async () => {
    if (!burrow || !upload) return;
    setOpening(true);
    setError(null);
    try {
      const answer = unwrap(
        await client.backups.inspect({ params: { burrow, stagedBackupId: upload.id }, body: { password } }),
      );
      setPreview({ uploadId: upload.id, preview: answer });
      setChosen(null);
      setOnDifferent('keep');
      setPointHere(true);
    } catch (e) {
      fail(e, 'upload');
      refreshList();
    } finally {
      setOpening(false);
    }
  }, [burrow, client, upload, password, refreshList, fail]);

  const restore = useCallback(async () => {
    if (!burrow || !upload || !shown) return;
    if (ticked.length === 0) {
      setError({ message: backupFileErrorText('nothing_chosen'), code: 'nothing_chosen' });
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const { restore: started } = unwrap(
        await client.backups.restore({
          params: { burrow, stagedBackupId: upload.id },
          body: {
            password,
            categories: ticked,
            onDifferent,
            // The address question's answer, only when it was asked (BF-15; absent, the server points them here).
            ...(serversQuestion ? { servers: { pointHere } } : {}),
          },
        }),
      );
      setPasswordState('');
      setPreview(null);
      setChosen(null);
      patchList((d) => ({ ...d, restores: [started, ...d.restores.filter((r) => r.id !== started.id)] }));
    } catch (e) {
      fail(e, 'upload');
    } finally {
      setStarting(false);
      refreshList();
    }
  }, [
    burrow,
    client,
    upload,
    shown,
    ticked,
    password,
    onDifferent,
    serversQuestion,
    pointHere,
    patchList,
    refreshList,
    fail,
  ]);

  const cancel = useCallback(async () => {
    const running = transfer.current;
    running?.controller.abort();
    const staged = running?.staged ?? upload;
    setPreview(null);
    setChosen(null);
    setPasswordState('');
    setError(null);
    if (!burrow || !staged) return;
    setCancelling(true);
    try {
      unwrap(await client.backups.removeUpload({ params: { burrow, stagedBackupId: staged.id } }));
      patchList((d) => ({ ...d, uploads: d.uploads.filter((u) => u.id !== staged.id) }));
    } catch (e) {
      fail(e, 'upload');
    } finally {
      setCancelling(false);
      refreshList();
    }
  }, [burrow, client, upload, patchList, refreshList, fail]);

  const dismiss = useCallback(() => {
    if (!restoreView || restoreView.status === 'restoring') return;
    dismissedStore.add(restoreView.id);
    setDismissedIds((s) => new Set(s).add(restoreView.id));
    setError(null);
  }, [restoreView, dismissedStore]);

  return {
    step,
    upload: upload?.status === 'uploaded' ? upload : null,
    stopped: upload?.status === 'uploading' && !uploading ? upload : null,
    uploading,
    choose,
    password,
    setPassword: (value) => {
      setError(null);
      setPasswordState(value);
    },
    open,
    opening,
    preview: shown,
    madeLine: shown ? backupRestoreMadeLine(shown) : null,
    rows: shown ? backupRestoreRows(shown, ticked) : [],
    fileNotes: shown ? backupRestoreFileNotes(shown) : [],
    ticked,
    toggle: (id, on) => {
      // What can't come back here can't be ticked (AP-4413).
      if (shown && backupRestoreBlocked(shown, id)) return;
      setError(null);
      setChosen((prev) => toggleBackupCategory(prev ?? ticked, id, on));
    },
    hasDifferent: shown ? backupRestoreHasDifferent(shown, ticked) : false,
    onDifferent,
    setOnDifferent,
    serversQuestion,
    pointHere,
    setPointHere,
    restore,
    starting,
    cancel,
    cancelling,
    restoreView: step === 'restoring' || step === 'done' || step === 'failed' ? restoreView : null,
    progress: restoreView?.status === 'restoring' ? backupRestoreProgress(restoreView) : null,
    outcome: (step === 'done' || step === 'failed') && restoreView ? backupRestoreOutcome(restoreView) : null,
    dismiss,
    error: error?.message ?? null,
    errorCode: error?.code ?? null,
  };
}
