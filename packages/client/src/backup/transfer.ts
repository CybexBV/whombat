/**
 * Moving a backup file's bytes (contracts 0.79.0, CT-335; Whombat backup-file.md BF-10; app backup-file.md AP-1190,
 * AP-1193): downloading a made file into the platform's sink, and checking, staging and uploading a chosen file to
 * restore. Both go through the client's session, so the same code runs on HTTP (raw REST transfers with `Range` and
 * `Content-Range`) and on a managed Whombat (`download` and `upload` streams), and both pick up where they stopped.
 * The file is never held whole: one chunk at a time goes from the session to the sink, or from the source to the
 * session. Shared by web and Android (each brings its sink and its source).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  BACKUP_FILE_MAX_BYTES,
  BACKUP_HEADER_BYTES,
  BackupFileError,
  parseBackupHeader,
} from '@whombat/core/backup';
import type { BackupFileView, BackupUploadView } from '@whombat/core/contracts';
import { unwrap, type WhombatClient } from '../http/client';
import { type ApplianceSession, type ChunkSource, StreamError } from '../session/types';

/** Where a downloaded file's bytes go, in order: a file on disk, a save picker's stream, memory as a last resort. */
export interface BackupFileSink {
  write(chunk: Uint8Array): Promise<void> | void;
  /** Every byte is there and checked. */
  close(): Promise<void> | void;
  /** The download failed or was cancelled: throw away what was written. */
  abort?(): Promise<void> | void;
}

/** Bytes moved so far of all of them. */
export interface BackupTransferProgress {
  done: number;
  total: number;
}

export interface DownloadBackupFileOptions {
  onProgress?: (p: BackupTransferProgress) => void;
  signal?: AbortSignal;
  /** Times the transfer starts again from where it stopped after the connection dropped (default 6). */
  attempts?: number;
  /** Wait before going on, doubled each time (ms, default 500). */
  retryMs?: number;
}

/** Failures that end a download or upload for now but may go through again: the connection, not the file. */
function retryable(error: unknown): boolean {
  return error instanceof StreamError && error.code === 'lost';
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new StreamError('cancelled', 'Cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new StreamError('cancelled', 'Cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Downloads a ready file into `sink` (AP-1190): opens `{kind: 'backup-file'}` through the session; when the connection
 * drops, opens it again from the bytes already written (`range`), up to `attempts` times. Every byte is hashed as it
 * goes; at the end the size and the sha256 must be the file's (`BackupFileView.size`, `sha256`), or the sink is aborted
 * and `damaged` thrown. Resolves to the size and sha256 written.
 */
export async function downloadBackupFile(
  session: ApplianceSession,
  target: { burrow: string; file: Pick<BackupFileView, 'id' | 'size' | 'sha256'> },
  sink: BackupFileSink,
  options: DownloadBackupFileOptions = {},
): Promise<{ size: number; sha256: string }> {
  const { signal } = options;
  const attempts = options.attempts ?? 6;
  const retryMs = options.retryMs ?? 500;
  // The session's own hash: the phone's system one when it has it (every byte of a backup goes through it).
  const hasher = session.sha256?.() ?? sha256.create();
  let written = 0;
  let total = target.file.size ?? 0;
  let failures = 0;
  const ref = { kind: 'backup-file' as const, burrow: target.burrow, backupFileId: target.file.id };
  try {
    for (;;) {
      if (signal?.aborted) throw new StreamError('cancelled', 'Cancelled.');
      try {
        const stream = await session.openResource(ref, {
          ...(written > 0 && { range: { start: written } }),
          ...(signal && { signal }),
        });
        if (target.file.size === null && stream.meta.size !== null) total = written + stream.meta.size;
        options.onProgress?.({ done: written, total });
        for await (const chunk of stream.chunks) {
          if (written + chunk.byteLength > total && target.file.size !== null) {
            stream.cancel();
            throw new BackupFileError('damaged', 'more bytes than the file has');
          }
          await sink.write(chunk);
          hasher.update(chunk);
          written += chunk.byteLength;
          options.onProgress?.({ done: written, total });
        }
        break;
      } catch (error) {
        if (!retryable(error) || failures + 1 >= attempts) throw error;
        failures += 1;
        await wait(retryMs * 2 ** (failures - 1), signal);
      }
    }
    const digest = bytesToHex(hasher.digest());
    if (
      (target.file.size !== null && written !== target.file.size) ||
      (target.file.sha256 !== null && digest !== target.file.sha256)
    )
      throw new BackupFileError('damaged', 'size or sha256 differs');
    await sink.close();
    return { size: written, sha256: digest };
  } catch (error) {
    try {
      await sink.abort?.();
    } catch {
      // The sink's own clean-up failing changes nothing for the person.
    }
    throw error;
  }
}

/**
 * Reads the start of a chosen file and checks it is a backup file this app can read (AP-1194): throws `BackupFileError`
 * `not_backup_file`, `newer_format`, `damaged` or `too_large` before a byte is uploaded. Runs no key derivation.
 */
export async function checkBackupFile(source: Pick<ChunkSource, 'size' | 'read'>): Promise<void> {
  if (source.size > BACKUP_FILE_MAX_BYTES)
    throw new BackupFileError('too_large', 'larger than a file may be');
  if (source.size < BACKUP_HEADER_BYTES) {
    // Too short for a header: whatever the magic says, it isn't a whole backup file.
    parseBackupHeader(await source.read(0, source.size));
    throw new BackupFileError('damaged', 'shorter than a header');
  }
  parseBackupHeader(await source.read(0, BACKUP_HEADER_BYTES));
}

export interface UploadBackupFileOptions {
  /** An unfinished upload of the same file (`resumableBackupUpload`): it goes on from its `received`. */
  resume?: BackupUploadView | null;
  /** The upload was staged (before any byte is sent): its view, so a cancel can remove it. */
  onStaged?: (upload: BackupUploadView) => void;
  onProgress?: (p: BackupTransferProgress) => void;
  signal?: AbortSignal;
}

/**
 * Uploads a chosen file to restore (AP-1193): checks its start (`checkBackupFile`), stages it (`backups.stage`, or goes
 * on with `resume`), sends the bytes through the session — one PUT per chunk from `received` on HTTP, the resumable
 * `backup-file` upload stream on a managed Whombat — and resolves to the uploaded file's view (`backups.getUpload`).
 */
export async function uploadBackupFile(
  client: WhombatClient,
  burrow: string,
  source: ChunkSource,
  options: UploadBackupFileOptions = {},
): Promise<BackupUploadView> {
  const { signal } = options;
  await checkBackupFile(source);
  if (signal?.aborted) throw new StreamError('cancelled', 'Cancelled.');
  const resume =
    options.resume && options.resume.fileName === source.name && options.resume.size === source.size
      ? options.resume
      : null;
  const staged: BackupUploadView =
    resume ??
    unwrap(
      await client.backups.stage({
        params: { burrow },
        body: { fileName: source.name, size: source.size },
        ...(signal && { signal }),
      }),
    ).upload;
  options.onStaged?.(staged);
  if (staged.status !== 'uploaded')
    await client.session.upload({ type: 'backup-file', burrow, stagedBackupId: staged.id }, source, {
      ...(signal && { signal }),
      onProgress: (p) => options.onProgress?.({ done: p.sent, total: p.total }),
    });
  const { upload } = await client.backups.getUpload({
    params: { burrow, stagedBackupId: staged.id },
    ...(signal && { signal }),
  });
  options.onProgress?.({ done: upload.received, total: upload.size });
  if (upload.status !== 'uploaded') throw new BackupFileError('upload_incomplete', 'not every byte arrived');
  return upload;
}
