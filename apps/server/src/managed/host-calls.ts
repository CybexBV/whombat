/**
 * What the box's hardware and network reads share (hardware-support-server.md HD-S03, HD-S04): a cap on the whole
 * manager call (not only the socket's idle time, as the measurements', BS-D04) and warnings at most once a minute, since
 * the app polls the network every 2 s while a change runs.
 */
import type { Services } from '../services';
import { ManagerCallError } from './ports';

/** A manager that doesn't answer is logged at most this often. */
const WARN_EVERY_MS = 60_000;

/** `promise`, or a `ManagerCallError` `unreachable` after `ms`. */
export async function withinMs<T>(promise: Promise<T>, ms: number, path: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ManagerCallError(path, 0, 'unreachable', `manager ${path}: timed out`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One warning a minute about a manager that doesn't answer `what`. Only the status, the code and the first words of the
 * error go to the log: never a request body (a Wi-Fi passphrase is one).
 */
export class ManagerWarnings {
  #warnedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly services: Services,
    private readonly what: string,
  ) {}

  warn(err: unknown): void {
    const now = this.services.clock().getTime();
    if (now - this.#warnedAt < WARN_EVERY_MS) return;
    this.#warnedAt = now;
    const status = err instanceof ManagerCallError ? err.status : null;
    const code = err instanceof ManagerCallError ? err.code : null;
    this.services.log.warn(
      { status, code, err: err instanceof ManagerCallError ? null : String(err).slice(0, 200) },
      status === 404
        ? `${this.what}: this manager doesn’t know it yet`
        : `${this.what}: the manager didn’t answer`,
    );
  }
}

/** The manager refused a change, or nobody listens on its socket: nothing happened (command-safety.md CS-01). */
export function managerRefusedChange(err: unknown): boolean {
  if (!(err instanceof ManagerCallError)) return false;
  if (err.status >= 400 && err.status < 500) return true;
  return err.status === 0 && /ENOENT|ECONNREFUSED/.test(err.message);
}
