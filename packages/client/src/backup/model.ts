/**
 * Backup files (contracts 0.79.0, CT-335; Whombat backup-file.md BF-01…; app docs/decisions/backup-file.md AP-1181…):
 * what Settings → This Whombat → BACKUP FILE shows on the web and what Android's screen shows, from `api.backups` — the
 * download panel's ticks with their meta lines and sizes, the password, the file being made and the file that is ready;
 * the restore panel's upload, preview, ticks, “When something is different”, progress and what a finished restore
 * brought back and needs. Every word is the contracts' (`@whombat/core/backup`) except the few in `BACKUP_FILE_TEXT`.
 * Pure: no clock (callers pass `now`), no I/O.
 */
import {
  BACKUP_CATEGORY_IDS,
  BACKUP_CATEGORY_LABELS,
  BACKUP_COPY,
  BACKUP_DEFAULT_CATEGORIES,
  BACKUP_FILE_MAX_BYTES,
  BACKUP_SERVERS_STATE_LABELS,
  type BackupCategoryEstimate,
  type BackupCategoryId,
  type BackupFileErrorCode,
  type BackupRestoreChip,
  type BackupRestorePreview,
  type BackupServersPreview,
  type BackupServerToPoint,
  backupCategoryMeta,
  backupDownloadLabel,
  backupFileErrorOf,
  backupFileErrorText,
  backupMadeText,
  backupMakingText,
  backupNoteText,
  backupOfferedDefaults,
  backupPasswordOk,
  backupProgressPct,
  backupRestoreChips,
  backupRestoreHint,
  backupRestoreSummaryLines,
  backupRestoringText,
  backupServersAddressText,
  backupServersStateText,
  formatBackupSize,
  isBackupFileError,
  sortBackupCategories,
} from '@whombat/core/backup';
import type {
  BackupDefaults,
  BackupEstimate,
  BackupFileView,
  BackupListResponse,
  BackupRestoreView,
  BackupUploadView,
} from '@whombat/core/contracts';
import { DOT, formatDate } from '@whombat/core/text';
import { ApiError, NetworkError } from '../http/errors';
import { OutcomeRedactedError, OutcomeUnknownError, StreamError } from '../session/types';

/**
 * Words the contracts leave to the app (AP-1186): the section's label, transfer progress, the ready file's expiry, a
 * stopped upload, the summary's links and the generic failures. Plain English, curly quotes, the middle dot.
 */
export const BACKUP_FILE_TEXT = {
  /** The section in Settings → This Whombat (SectionLabel shows it as it is): the backup file is for moving. */
  section: 'MOVE TO ANOTHER WHOMBAT',
  /** When to use it, under the section's name: the backups keep this Whombat safe already. */
  when: 'Make a file of what you choose and open it on another Whombat. Your backups already keep this one safe.',
  downloading: (pct: number) => `Downloading ${DOT} ${pct} %`,
  uploading: (pct: number) => `Uploading ${DOT} ${pct} %`,
  uploaded: (size: number) => `Uploaded ${DOT} ${formatBackupSize(size)}`,
  /** “Expires in 23 hours”, after the file's name and size. */
  expires: (left: string) => `expires in ${left}`,
  expired: 'expired',
  saved: 'Saved to your device.',
  /** An upload that stopped (the page closed, the network went): choosing the same file goes on from there. */
  stopped: (pct: number) => `Uploading stopped at ${pct} %. Choose the same file to go on.`,
  restoreAnother: 'Restore another file',
  done: 'Done',
  tryAgain: 'Try again',
  openConnections: 'Open Connections',
  openAutomations: 'Open Automations',
  connection: 'Couldn’t reach your Whombat. Check your connection and try again.',
  noAnswer: 'Your Whombat didn’t answer in time. Look again in a moment: it may still be working on it.',
  failed: 'Something went wrong. Try again.',
} as const;

/* Download a backup ------------------------------------------------------------------------------------------------ */

/**
 * Categories the download panel lists only once the estimate says this Whombat offers them (AP-4411): servers, which
 * only a Whombat that watches servers can put in a file (BF-13). Before the estimate is in they stay out, and an older
 * Whombat's estimate doesn't list them at all.
 */
export const BACKUP_OFFERED_ONLY: readonly BackupCategoryId[] = Object.freeze(['servers']);

/**
 * The categories the download panel lists, in order (AP-4411): those the estimate offers (`offered`, CT-901; absent
 * means offered, as an older Whombat's rows); before the estimate is in, all but `BACKUP_OFFERED_ONLY`.
 */
export function backupShownCategories(
  estimate: Pick<BackupEstimate, 'categories'> | null | undefined,
): BackupCategoryId[] {
  if (!estimate) return BACKUP_CATEGORY_IDS.filter((id) => !BACKUP_OFFERED_ONLY.includes(id));
  const offered = new Set(estimate.categories.filter((c) => c.offered !== false).map((c) => c.id));
  return BACKUP_CATEGORY_IDS.filter((id) => offered.has(id));
}

/**
 * The ticks the download panel starts from (BF-09, BF-21): the burrow's defaults, the contracts' nine until they load,
 * without what the panel doesn't list (`backupShownCategories`, AP-4411).
 */
export function backupStartingTicks(
  defaults: Pick<BackupDefaults, 'categories'> | null | undefined,
  estimate?: Pick<BackupEstimate, 'categories'> | null,
): BackupCategoryId[] {
  return backupOfferedDefaults(
    defaults?.categories ?? BACKUP_DEFAULT_CATEGORIES,
    backupShownCategories(estimate),
  );
}

/** Ticks without the categories the panel doesn't list (a choice made before the estimate came in, AP-4411). */
export function backupShownTicks(
  ticked: readonly BackupCategoryId[],
  estimate: Pick<BackupEstimate, 'categories'> | null | undefined,
): BackupCategoryId[] {
  return backupOfferedDefaults(ticked, backupShownCategories(estimate));
}

/** Ticks with one category switched, in category order. */
export function toggleBackupCategory(
  ticked: readonly BackupCategoryId[],
  id: BackupCategoryId,
  on: boolean = !ticked.includes(id),
): BackupCategoryId[] {
  const set = new Set(ticked);
  if (on) set.add(id);
  else set.delete(id);
  return sortBackupCategories(set);
}

/** The same categories, whatever their order. */
export function sameBackupCategories(
  a: readonly BackupCategoryId[],
  b: readonly BackupCategoryId[],
): boolean {
  const sa = sortBackupCategories(a);
  const sb = sortBackupCategories(b);
  return sa.length === sb.length && sa.every((id, i) => id === sb[i]);
}

/** One category in the download panel: its label, the plain line under it and its size (from `backups.estimate`). */
export interface BackupDownloadRow {
  id: BackupCategoryId;
  label: string;
  /** “5 agents with their roles, models and keys”; null until the estimate is in. */
  meta: string | null;
  /** “12 KB”; null until the estimate is in. */
  size: string | null;
  bytes: number | null;
  ticked: boolean;
}

/**
 * Every category the panel lists (`backupShownCategories`: what this Whombat offers, AP-4411) in order, ticked or not,
 * with what the estimate says about it.
 */
export function backupDownloadRows(
  estimate: Pick<BackupEstimate, 'categories'> | null | undefined,
  ticked: readonly BackupCategoryId[],
): BackupDownloadRow[] {
  const byId = new Map<BackupCategoryId, BackupCategoryEstimate>(
    (estimate?.categories ?? []).map((c) => [c.id, c]),
  );
  return backupShownCategories(estimate).map((id) => {
    const e = byId.get(id);
    return {
      id,
      label: BACKUP_CATEGORY_LABELS[id],
      meta: e ? backupCategoryMeta(e) : null,
      // Nothing to put in: its line says so, no “0 KB”.
      size: e && (e.count > 0 || e.bytes > 0) ? formatBackupSize(e.bytes) : null,
      bytes: e ? e.bytes : null,
      ticked: ticked.includes(id),
    };
  });
}

/** The estimated size of a file with these categories; null until the estimate is in. */
export function backupChosenBytes(
  estimate: Pick<BackupEstimate, 'categories'> | null | undefined,
  ticked: readonly BackupCategoryId[],
): number | null {
  if (!estimate) return null;
  return estimate.categories.filter((c) => ticked.includes(c.id)).reduce((sum, c) => sum + c.bytes, 0);
}

/** The button: “Download · 1.8 MB”, or “Download” while the estimate isn't in. */
export function backupMakeLabel(
  estimate: Pick<BackupEstimate, 'categories'> | null | undefined,
  ticked: readonly BackupCategoryId[],
): string {
  const bytes = backupChosenBytes(estimate, ticked);
  return bytes === null ? 'Download' : backupDownloadLabel(bytes);
}

/** “Use at least 10 characters.” for a password that is too short (or too long); null when it will do. */
export function backupPasswordProblem(password: string): string | null {
  return backupPasswordOk(password) ? null : BACKUP_COPY.download.passwordShort;
}

/**
 * Why a file can't be made with these choices, in the contracts' words; null when it can: nothing ticked, a password too
 * short, larger than a file may be or than the room left (the server checks again).
 */
export function backupMakeProblem(input: {
  estimate: Pick<BackupEstimate, 'categories' | 'freeBytes' | 'maxBytes'> | null | undefined;
  ticked: readonly BackupCategoryId[];
  password: string;
}): string | null {
  if (input.ticked.length === 0) return backupFileErrorText('nothing_chosen');
  const password = backupPasswordProblem(input.password);
  if (password) return password;
  const bytes = backupChosenBytes(input.estimate, input.ticked);
  if (bytes !== null && input.estimate) {
    if (bytes > Math.min(input.estimate.maxBytes, BACKUP_FILE_MAX_BYTES))
      return backupFileErrorText('too_large');
    if (input.estimate.freeBytes !== null && bytes > input.estimate.freeBytes)
      return backupFileErrorText('no_room');
  }
  return null;
}

const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);

/** Whether a ready file is past its expiry at `now` (the server removes it then). */
export function backupFileExpired(file: Pick<BackupFileView, 'status' | 'expiresAt'>, now: number): boolean {
  const end = at(file.expiresAt);
  return file.status === 'ready' && Number.isFinite(end) && end <= now;
}

/**
 * The file the download panel shows (AP-1189): the newest of the person's files (`backups.list` is newest first) that
 * hasn't expired — one being made, a ready one, or one that failed; null when there is none.
 */
export function currentBackupFile(
  list: Pick<BackupListResponse, 'files'> | null | undefined,
  now: number,
): BackupFileView | null {
  return list?.files.find((f) => !backupFileExpired(f, now)) ?? null;
}

/** What the download panel shows: the choices (also after a failure), the file being made, or the file that is ready. */
export type BackupMakeStep = 'choose' | 'making' | 'ready';

export function backupMakeStep(file: Pick<BackupFileView, 'status'> | null | undefined): BackupMakeStep {
  if (file?.status === 'making') return 'making';
  if (file?.status === 'ready') return 'ready';
  return 'choose';
}

/** A job's progress bar and line. */
export interface BackupProgressView {
  /** 0–100, whole. */
  pct: number;
  text: string;
}

/** “Making the file · Messages · 42 %”. */
export function backupFileProgress(file: Pick<BackupFileView, 'progress' | 'status'>): BackupProgressView {
  const p = file.progress ?? { done: 0, total: 0, step: null };
  return { pct: backupProgressPct(p, file.status === 'ready'), text: backupMakingText(p) };
}

/** “23 hours”, “1 hour”, “40 minutes”, “1 minute”: how long until `until` (rounded down; at least a minute). */
export function backupTimeLeft(until: string, now: number): string {
  const ms = Date.parse(until) - now;
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/** “1.8 MB · expires in 23 hours”: the ready file's line under its name. */
export function backupFileReadyLine(
  file: Pick<BackupFileView, 'size' | 'expiresAt' | 'status'>,
  now: number,
): string {
  const parts: string[] = [];
  if (file.size !== null) parts.push(formatBackupSize(file.size));
  if (file.expiresAt)
    parts.push(
      backupFileExpired(file, now)
        ? BACKUP_FILE_TEXT.expired
        : BACKUP_FILE_TEXT.expires(backupTimeLeft(file.expiresAt, now)),
    );
  return parts.join(` ${DOT} `);
}

/** Why the newest file failed: “The file couldn’t be made.” and the reason, or null. */
export function backupFileFailure(
  file: Pick<BackupFileView, 'status' | 'error'> | null | undefined,
): string | null {
  if (file?.status !== 'failed') return null;
  const reason = file.error?.message;
  return reason ? `${BACKUP_COPY.download.failed} ${reason}` : BACKUP_COPY.download.failed;
}

/** A transfer's percentage, whole, 100 only when every byte is there. */
export function backupTransferPct(done: number, total: number): number {
  if (total <= 0) return 0;
  if (done >= total) return 100;
  return Math.min(99, Math.floor((done / total) * 100));
}

/* Restore from a file ---------------------------------------------------------------------------------------------- */

/** The upload the restore panel shows: the person's newest staged upload; null when there is none. */
export function currentBackupUpload(
  list: Pick<BackupListResponse, 'uploads'> | null | undefined,
  now: number,
): BackupUploadView | null {
  return list?.uploads.find((u) => !(Date.parse(u.expiresAt) <= now)) ?? null;
}

/**
 * An unfinished upload of the same file (name and size), so choosing it again goes on where it stopped (AP-1193); null
 * when there is none.
 */
export function resumableBackupUpload(
  list: Pick<BackupListResponse, 'uploads'> | null | undefined,
  file: { name: string; size: number },
  now: number,
): BackupUploadView | null {
  return (
    list?.uploads.find(
      (u) =>
        u.status === 'uploading' &&
        u.fileName === file.name &&
        u.size === file.size &&
        !(Date.parse(u.expiresAt) <= now),
    ) ?? null
  );
}

/**
 * The restore the panel shows (AP-1196): one that is running, else the newest finished one this person hasn't put away
 * (`dismissed`, kept on the device); null otherwise.
 */
export function currentBackupRestore(
  list: Pick<BackupListResponse, 'restores'> | null | undefined,
  dismissed: ReadonlySet<string>,
): BackupRestoreView | null {
  const restores = list?.restores ?? [];
  return (
    restores.find((r) => r.status === 'restoring') ??
    (restores[0] && !dismissed.has(restores[0].id) ? restores[0] : null)
  );
}

/**
 * What the restore panel shows (AP-1192): `choose` a file, `uploading` it, its `password`, the `preview`, the restore
 * `restoring`, then `done` or `failed`.
 */
export type BackupRestoreStep =
  | 'choose'
  | 'uploading'
  | 'password'
  | 'preview'
  | 'restoring'
  | 'done'
  | 'failed';

export function backupRestoreStep(input: {
  restore: Pick<BackupRestoreView, 'status' | 'startedAt'> | null;
  uploading: boolean;
  upload: Pick<BackupUploadView, 'status' | 'createdAt'> | null;
  preview: unknown | null;
}): BackupRestoreStep {
  const { restore, upload } = input;
  if (restore?.status === 'restoring') return 'restoring';
  if (input.uploading) return 'uploading';
  // A finished restore stays until it is put away, unless a file was uploaded after it started.
  const finished = restore && (!upload || Date.parse(upload.createdAt) <= Date.parse(restore.startedAt));
  if (finished) return restore.status === 'done' ? 'done' : 'failed';
  if (upload?.status === 'uploaded') return input.preview ? 'preview' : 'password';
  return 'choose';
}

/** Whether something runs on the server that the panels follow (a file being made, a restore): read again soon. */
export function backupsBusy(
  list: Pick<BackupListResponse, 'files' | 'restores'> | null | undefined,
): boolean {
  return (
    !!list &&
    (list.files.some((f) => f.status === 'making') || list.restores.some((r) => r.status === 'restoring'))
  );
}

/** What the restore panel reads of a preview: its categories and, since 0.117, its servers (BF-14, BF-15). */
type PreviewParts = Pick<BackupRestorePreview, 'categories'> & {
  servers?: BackupServersPreview | null;
};

/**
 * Whether a category of the file can't come back here (AP-4413): the servers, when this Whombat already watches others
 * (`blocked`) or has no hosts service (`unavailable`, BF-14). Its row is unticked and can't be ticked.
 */
export function backupRestoreBlocked(preview: PreviewParts, id: BackupCategoryId): boolean {
  if (id !== 'servers') return false;
  const state = preview.servers?.state;
  return state === 'blocked' || state === 'unavailable';
}

/** The ticks the restore panel starts with (BF-09): every category the file has that can come back here (AP-4413). */
export function backupRestoreStartingTicks(preview: PreviewParts): BackupCategoryId[] {
  return sortBackupCategories(
    preview.categories.map((c) => c.id).filter((id) => !backupRestoreBlocked(preview, id)),
  );
}

/** One category in the restore preview: its tick, chips (New / Already here / Different), fixed line and notes. */
export interface BackupRestoreRow {
  id: BackupCategoryId;
  label: string;
  ticked: boolean;
  /** It can't come back here (AP-4413): unticked, and its tick is off. */
  disabled: boolean;
  chips: BackupRestoreChip[];
  /**
   * “They start switched off, so they don’t run twice.” for automations; for the servers BF-14's sentence (“This
   * Whombat already watches 3 servers, so …”, “They already report to this Whombat.”); null for most.
   */
  hint: string | null;
  /** This category's notes, one sentence each. */
  notes: string[];
}

/**
 * The servers' row (AP-4412): new or already here, its counts as the other rows' chips (“5 new”, “2 different”) and
 * BF-14's line; when they can't come back, the contracts' “Can’t come back” in the warning colour and the reason.
 */
function serversRowParts(
  c: BackupRestorePreview['categories'][number],
  servers: BackupServersPreview,
): Pick<BackupRestoreRow, 'chips' | 'hint'> {
  const hint = backupServersStateText(servers);
  if (servers.state === 'blocked' || servers.state === 'unavailable')
    return { chips: [{ label: BACKUP_SERVERS_STATE_LABELS[servers.state], tone: 'warn' }], hint };
  return { chips: backupRestoreChips(c), hint };
}

export function backupRestoreRows(
  preview: PreviewParts,
  ticked: readonly BackupCategoryId[],
): BackupRestoreRow[] {
  const servers = preview.servers ?? null;
  return [...preview.categories]
    .sort((a, b) => BACKUP_CATEGORY_IDS.indexOf(a.id) - BACKUP_CATEGORY_IDS.indexOf(b.id))
    .map((c) => {
      const disabled = backupRestoreBlocked(preview, c.id);
      return {
        id: c.id,
        label: BACKUP_CATEGORY_LABELS[c.id],
        ticked: !disabled && ticked.includes(c.id),
        disabled,
        ...(c.id === 'servers' && servers
          ? serversRowParts(c, servers)
          : { chips: backupRestoreChips(c), hint: backupRestoreHint(c.id) }),
        notes: (c.notes ?? []).map((n) => backupNoteText(n)),
      };
    });
}

/**
 * The address question (BF-15; AP-4414): “Your servers look for your Whombat at 10.100.1.160. This Whombat is at
 * 10.100.1.158.”, while the servers are ticked and the file's Whombat was at another address; null otherwise (then the
 * restore sends no answer).
 */
export function backupServersQuestion(
  preview: PreviewParts,
  ticked: readonly BackupCategoryId[],
): string | null {
  const address = preview.servers?.address;
  if (!address || !ticked.includes('servers') || backupRestoreBlocked(preview, 'servers')) return null;
  return backupServersAddressText(address);
}

/** The file card's second line: “Made 11 Oct 2026 on Lumio BV · Whombat 0.83”. */
export function backupRestoreMadeLine(preview: Pick<BackupRestorePreview, 'manifest'>): string {
  return backupMadeText(preview.manifest);
}

/** Notes about the whole file, one sentence each. */
export function backupRestoreFileNotes(preview: Pick<BackupRestorePreview, 'notes'>): string[] {
  return (preview.notes ?? []).map((n) => backupNoteText(n));
}

/** Whether “When something is different” matters: a ticked category has something here that differs. */
export function backupRestoreHasDifferent(
  preview: Pick<BackupRestorePreview, 'categories'>,
  ticked: readonly BackupCategoryId[],
): boolean {
  return preview.categories.some((c) => ticked.includes(c.id) && c.different > 0);
}

/**
 * “Made 11 Oct 2026 on Lumio BV”: the line under a restore's file once it runs (the view keeps when the file was made and
 * where, not its time zone, so the day is in `timeZone`, the viewer's).
 */
export function backupRestoreFileLine(
  restore: Pick<BackupRestoreView, 'madeAt' | 'sourceName'>,
  timeZone: string,
): string {
  return `Made ${formatDate(restore.madeAt, timeZone, { year: 'always' })} on ${restore.sourceName}`;
}

/** “Restoring · Automations · 42 %”. */
export function backupRestoreProgress(
  restore: Pick<BackupRestoreView, 'progress' | 'status'>,
): BackupProgressView {
  const p = restore.progress ?? { done: 0, total: 0, step: null };
  return { pct: backupProgressPct(p, restore.status === 'done'), text: backupRestoringText(p) };
}

/** Where a finished restore points the person: Connections → Needs you, Automations. */
export type BackupRestoreLink = 'connections' | 'automations';

/** A finished (or stopped) restore as the panel says it. */
export interface BackupRestoreOutcome {
  /** “Restored”, or the reason it stopped. */
  title: string;
  /**
   * What came back, then what needs the person (connections to sign in to again, automations off, servers pointed
   * here and those still looking for the old address).
   */
  lines: string[];
  links: BackupRestoreLink[];
  /**
   * Servers to point here by hand (BF-15; AP-4416): each one's “Point it here” opens Add a server filled in with its
   * address (`addServerHref`, Android's AddServer).
   */
  toPoint: BackupServerToPoint[];
  failed: boolean;
}

export function backupRestoreOutcome(
  restore: Pick<BackupRestoreView, 'status' | 'summary' | 'error'>,
): BackupRestoreOutcome {
  const summary = restore.summary;
  const lines = summary ? backupRestoreSummaryLines(summary) : [];
  const links: BackupRestoreLink[] = [];
  if ((summary?.connectionsToSignIn?.length ?? 0) > 0) links.push('connections');
  if ((summary?.automationsOff ?? 0) > 0) links.push('automations');
  const failed = restore.status === 'failed';
  return {
    title: failed
      ? (restore.error?.message ?? backupFileErrorText('restore_failed'))
      : BACKUP_COPY.restore.done,
    lines,
    links,
    toPoint: [...(summary?.servers?.toPoint ?? [])],
    failed,
  };
}

/* Errors ----------------------------------------------------------------------------------------------------------- */

/** A failed backup action in words: the contracts' code and sentence when there is one. */
export interface BackupProblem {
  code: BackupFileErrorCode | null;
  message: string;
  /** The person cancelled it: nothing to say. */
  cancelled: boolean;
}

const problem = (code: BackupFileErrorCode | null, message: string, cancelled = false): BackupProblem => ({
  code,
  message,
  cancelled,
});
const known = (code: BackupFileErrorCode) => problem(code, backupFileErrorText(code));

/**
 * What went wrong, for people (AP-1199): a backup-file code (from the server's `details.code`, a stream's refusal, or
 * the header check before an upload) says its sentence; a refused download of a file that isn't there any more is
 * `expired`; the network says to check the connection; an answer that never came says to look again.
 */
export function backupProblem(
  error: unknown,
  during: 'download' | 'upload' | 'other' = 'other',
): BackupProblem {
  if (isBackupFileError(error)) return known(error.code);
  if (error instanceof ApiError) {
    const code = backupFileErrorOf(error.details);
    if (code) return known(code);
    if (error.status === 403) return known('people_only');
    if (error.status === 410) return known(during === 'upload' ? 'upload_expired' : 'expired');
    return problem(null, error.status < 500 && error.message ? error.message : BACKUP_FILE_TEXT.failed);
  }
  if (error instanceof StreamError) {
    if (error.code === 'cancelled') return problem(null, '', true);
    const code = backupFileErrorOf({ code: error.code });
    if (code) return known(code);
    if (error.code === 'not_found' || error.code === 'notFound')
      return known(during === 'upload' ? 'upload_expired' : 'expired');
    if (error.code === 'integrity') return known(during === 'upload' ? 'upload_mismatch' : 'damaged');
    if (error.code === 'tooLarge' || error.code === 'too_large') return known('too_large');
    if (error.code === 'lost') return problem(null, BACKUP_FILE_TEXT.connection);
    return problem(null, BACKUP_FILE_TEXT.failed);
  }
  if (error instanceof Error && error.name === 'AbortError') return problem(null, '', true);
  if (error instanceof NetworkError) return problem(null, BACKUP_FILE_TEXT.connection);
  if (error instanceof OutcomeUnknownError || error instanceof OutcomeRedactedError)
    return problem(null, BACKUP_FILE_TEXT.noAnswer);
  return problem(null, BACKUP_FILE_TEXT.failed);
}
