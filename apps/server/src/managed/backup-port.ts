/**
 * The backup service's local socket as the runtime calls it (appliance BK-11; docs/decisions/backup-options.md):
 * the port, what one call may take (a short status read, a long list), and the silence of a service that doesn't
 * answer. A leaf module: the place flows, the Inbox and the session's ops all use it.
 */
import { requestUnixHttp, UnixHttpError } from '@whombat/node-io/http';

/** What one call may take: a status read is short, the list of backups may be long. */
export interface BackupCallOptions {
  /** Wall-clock limit from the start of the call (beside the socket's idle timeout). */
  deadlineMs?: number;
  /** The largest answer taken (`BACKUP_ANSWER_MAX_BYTES` unless said). */
  maxBytes?: number;
}

/** The backup service's local API as the runtime uses it. */
export interface BackupPort {
  call(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    options?: BackupCallOptions,
  ): Promise<{ status: number; body: unknown }>;
}

/**
 * How long a backup service call may stay silent (the socket's idle timeout): an hour, for a checkpoint of a big
 * database and for a disk destination the service formats and mounts first (up to ~2 minutes, the appliance
 * BK-20); never below 180 s (MD-17).
 */
export const BACKUP_CALL_TIMEOUT_MS = 60 * 60_000;
/** A read of where things are (status, the restore, the options): the service answers these from files at once. */
export const BACKUP_READ_DEADLINE_MS = 10_000;
/** The list of backups reads the repository (`restic snapshots`, a slow NAS) before it answers. */
export const BACKUP_LIST_DEADLINE_MS = 2 * 60_000;
/** Most answers are small. */
export const BACKUP_ANSWER_MAX_BYTES = 256 * 1024;
/**
 * The list and an adopt carry every backup of a repository (up to 5,000 with their coverage, about 1 KB each): a place
 * nobody clears passes 256 KiB after about 730 backups.
 */
export const BACKUP_LIST_MAX_BYTES = 16 * 1024 * 1024;

/** The options of a short read. */
export const READ: BackupCallOptions = { deadlineMs: BACKUP_READ_DEADLINE_MS };
/** The options of the list and an adopt. */
export const LIST: BackupCallOptions = {
  deadlineMs: BACKUP_LIST_DEADLINE_MS,
  maxBytes: BACKUP_LIST_MAX_BYTES,
};

/** The backup service didn't answer: its socket is gone or refused, or it stayed silent past the call's limit. */
export class BackupServiceDown extends Error {
  constructor(readonly why: 'unreachable' | 'timeout') {
    super(why === 'timeout' ? 'backup service timed out' : 'backup service unreachable');
    this.name = 'BackupServiceDown';
  }
}

/** What people read when the backup service doesn't answer (instead of “Something went wrong”). */
export const BACKUP_DOWN_TEXT =
  'Your Whombat’s backup service isn’t answering right now. It usually comes back by itself; try again in a minute.';

const UNREACHABLE = new Set(['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EACCES', 'ENOTSOCK']);

export class BackupSocketClient implements BackupPort {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = BACKUP_CALL_TIMEOUT_MS,
  ) {}

  async call(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    options: BackupCallOptions = {},
  ): Promise<{ status: number; body: unknown }> {
    const payload = body === undefined ? '' : JSON.stringify(body);
    let response: Awaited<ReturnType<typeof requestUnixHttp>>;
    try {
      response = await requestUnixHttp({
        socketPath: this.socketPath,
        path,
        method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        body: payload,
        idleTimeoutMs: this.timeoutMs,
        ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
        maxResponseBytes: options.maxBytes ?? BACKUP_ANSWER_MAX_BYTES,
      });
    } catch (err) {
      if (err instanceof UnixHttpError) {
        if (err.kind === 'timeout') throw new BackupServiceDown('timeout');
        if (err.kind === 'too_large') throw new Error('backup service answer too large');
        if (err.kind === 'incomplete') throw new BackupServiceDown('unreachable');
      }
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code && UNREACHABLE.has(code)) throw new BackupServiceDown('unreachable');
      throw err;
    }
    const text = response.body.toString('utf8');
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status || 500, body: parsed };
  }
}
