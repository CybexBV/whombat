/**
 * Something this process depends on that is down for a while, as the log tells it (docs/decisions/box-health.md BH-09,
 * BH-10): the dev control plane restarting, the manager restarting with an update. The first failure is an info line
 * while the outage is young (inside `graceMs` of its start, or of a fixed moment such as the process's start), a
 * warning otherwise; an outage that outlasts the grace gets one warning, once, not one per retry; retries in between
 * are debug; and when it answers again one info line says how long it was down.
 * The caller decides which failures are an outage — everything else stays at its own level.
 */

interface OutageLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  debug(obj: object, msg: string): void;
}

export interface OutageOptions {
  /** What is down, as the start of the line: `relay: the control plane`. */
  what: string;
  log: () => OutageLog;
  /** How long failures are expected (info); after that one warning. */
  graceMs: number;
  /** The grace counts from here instead of from the outage's first failure (e.g. the process's start). */
  since?: number;
  now?: () => number;
}

/** `40 s`, `3 min 12 s`, `2 h 5 min`. */
export function outageDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

export class Outage {
  #since: number | null = null;
  #warned = false;
  readonly #now: () => number;

  constructor(private readonly options: OutageOptions) {
    this.#now = options.now ?? Date.now;
  }

  /** Whether the last word was a failure. */
  get down(): boolean {
    return this.#since !== null;
  }

  /** A failure that means it can't be reached now (the caller retries). */
  failed(err: unknown, extra: Record<string, unknown> = {}): void {
    const now = this.#now();
    const { what, graceMs } = this.options;
    const log = this.options.log();
    const fields = { err: errText(err), ...extra };
    if (this.#since === null) {
      this.#since = now;
      this.#warned = now >= (this.options.since ?? now) + graceMs;
      if (this.#warned) log.warn(fields, `${what} isn’t reachable; retrying`);
      else log.info(fields, `${what} isn’t reachable; retrying`);
      return;
    }
    const downForMs = now - this.#since;
    if (!this.#warned && now >= (this.options.since ?? this.#since) + graceMs) {
      this.#warned = true;
      log.warn(
        { ...fields, downForMs },
        `${what} still isn’t reachable after ${outageDuration(downForMs)}; retrying`,
      );
      return;
    }
    log.debug({ ...fields, downForMs }, `${what} still isn’t reachable; retrying`);
  }

  /** It answered: after an outage, one info line with how long it lasted. */
  ok(): void {
    if (this.#since === null) return;
    const downForMs = this.#now() - this.#since;
    this.#since = null;
    this.#warned = false;
    this.options
      .log()
      .info({ downForMs }, `${this.options.what} is reachable again after ${outageDuration(downForMs)}`);
  }
}
