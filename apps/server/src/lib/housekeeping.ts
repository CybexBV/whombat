/**
 * One housekeeping tick for the small periodic jobs that used to keep their own timers (docs/decisions/
 * server-efficiency.md): the runtime's lease sweep, the feedback sources' due check, the #general welcomes, the
 * realtime credential re-check, the usage schedule and the outbox prune. Every `HOUSEKEEPING_TICK_MS` the jobs that
 * are due start; each has its own period (a multiple of the tick in practice) and runs on its own, so a slow or stuck
 * one holds up nothing else, and never overlaps itself. A job gets a deadline (`HOUSEKEEPING_DEADLINE_MS` unless it
 * says otherwise): there its signal aborts and the tick stops waiting for it. Failures are logged; each job's last
 * success is kept, and a job without one for long (`staleAfterMs`) is stale, which the admin health check reports.
 */

interface Log {
  warn(obj: object, msg?: string): void;
}

export const HOUSEKEEPING_TICK_MS = 15_000;
/** How long a job may run before it is stopped, unless it gives its own. */
export const HOUSEKEEPING_DEADLINE_MS = 5 * 60_000;
/** On shutdown, how long running jobs get to finish before they are stopped. */
export const HOUSEKEEPING_CLOSE_GRACE_MS = 5_000;
/** A job is stale with no success for three periods, and never sooner than this. */
const STALE_FLOOR_MS = 15 * 60_000;

/** A job's period: stale after three of them without a success, at least 15 minutes. */
export function staleAfterMs(everyMs: number): number {
  return Math.max(3 * everyMs, STALE_FLOOR_MS);
}

interface Job {
  name: string;
  /** Its period; read at every tick (tests change the options it comes from). */
  everyMs: () => number;
  run: (signal: AbortSignal) => Promise<unknown>;
  deadlineMs: number;
  /** When it last started (`performance.now()`); a new job counts from when it was added, or runs at the first tick. */
  last: number;
  /** Wall time of its last success, and of when it was added (what staleness counts from before a first success). */
  lastOkAt: number | null;
  addedAt: number;
  /** The run going on: settles when the job does or its deadline passes. */
  running: { done: Promise<void>; abort: AbortController } | null;
}

export interface HousekeepingJob {
  name: string;
  lastOkAt: Date | null;
  running: boolean;
  /** How long it has gone without a success (since it was added, before the first one). */
  sinceOkMs: number;
  stale: boolean;
}

export class Housekeeping {
  readonly #jobs = new Map<string, Job>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #closed = false;

  constructor(
    private readonly log: () => Log,
    readonly tickMs = HOUSEKEEPING_TICK_MS,
    /** Wall clock for last successes and staleness (`services.clock` in the server). */
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /**
   * Adds (or replaces) a job by name; the tick starts with the first one. `first: 'tick'` runs it at the next tick,
   * otherwise one period after now. `deadlineMs` is how long one run may take. Returns its removal.
   */
  add(
    name: string,
    everyMs: number | (() => number),
    run: (signal: AbortSignal) => Promise<unknown>,
    options: { first?: 'tick' | 'period'; deadlineMs?: number } = {},
  ): () => void {
    const period = typeof everyMs === 'number' ? () => everyMs : everyMs;
    const job: Job = {
      name,
      everyMs: period,
      run,
      deadlineMs: options.deadlineMs ?? HOUSEKEEPING_DEADLINE_MS,
      last: options.first === 'tick' ? Number.NEGATIVE_INFINITY : performance.now(),
      lastOkAt: null,
      addedAt: this.clock(),
      running: null,
    };
    this.#jobs.set(name, job);
    this.#start();
    return () => {
      if (this.#jobs.get(name) === job) this.#jobs.delete(name);
    };
  }

  has(name: string): boolean {
    return this.#jobs.has(name);
  }

  /** Every job with its last success and whether it is stale. */
  jobs(): HousekeepingJob[] {
    const now = this.clock();
    return [...this.#jobs.values()].map((job) => {
      const sinceOkMs = Math.max(0, now - (job.lastOkAt ?? job.addedAt));
      return {
        name: job.name,
        lastOkAt: job.lastOkAt === null ? null : new Date(job.lastOkAt),
        running: job.running !== null,
        sinceOkMs,
        stale: sinceOkMs > staleAfterMs(job.everyMs()),
      };
    });
  }

  /** The jobs that haven't succeeded for too long. */
  stale(): HousekeepingJob[] {
    return this.jobs().filter((j) => j.stale);
  }

  #start(): void {
    if (this.#timer || this.#closed) return;
    this.#timer = setInterval(() => void this.tick(), this.tickMs);
    this.#timer.unref?.();
  }

  /** Starts the jobs that are due now; settles when each of them has finished or reached its deadline. */
  tick(): Promise<void> {
    const started: Promise<void>[] = [];
    for (const job of [...this.#jobs.values()]) {
      if (this.#closed) break;
      // A job still running (or one that ignored its deadline's abort) is never started twice.
      if (job.running) continue;
      // Half a tick of slack: a job of one period runs every period, not every other one.
      const now = performance.now();
      if (now - job.last < job.everyMs() - this.tickMs / 2) continue;
      job.last = now;
      started.push(this.#run(job));
    }
    return Promise.all(started).then(() => {});
  }

  #run(job: Job): Promise<void> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => resolve('deadline'), job.deadlineMs);
      timer.unref?.();
      abort.signal.addEventListener('abort', () => resolve('deadline'), { once: true });
    });
    const work = Promise.resolve()
      .then(() => job.run(abort.signal))
      .then(
        () => {
          job.lastOkAt = this.clock();
        },
        (err) => {
          if (!abort.signal.aborted)
            this.log().warn({ err: String(err) }, `housekeeping: ${job.name} failed`);
        },
      )
      .then(() => 'settled' as const);
    const done = Promise.race([work, deadline]).then((how) => {
      clearTimeout(timer);
      if (how === 'deadline' && !abort.signal.aborted) {
        abort.abort(new Error(`housekeeping: ${job.name} ran past its deadline`));
        this.log().warn(
          { deadlineMs: job.deadlineMs },
          `housekeeping: ${job.name} ran past its deadline and was stopped`,
        );
      }
      // A job that ignores the abort stays “running” until it really ends, so it can't pile up.
      if (how === 'settled') job.running = null;
      else void work.finally(() => (job.running = null));
    });
    job.running = { done, abort };
    return done;
  }

  /** Stops ticking, gives running jobs a short grace to finish, then stops the rest. */
  async close(graceMs = HOUSEKEEPING_CLOSE_GRACE_MS): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    const running = [...this.#jobs.values()].flatMap((j) => (j.running ? [j.running] : []));
    if (!running.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, graceMs);
      timer.unref?.();
    });
    await Promise.race([Promise.all(running.map((r) => r.done)), grace]);
    clearTimeout(timer);
    for (const r of running) r.abort.abort(new Error('housekeeping: closing'));
  }
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

/** The health check's words for stale jobs, or null when maintenance keeps up. */
export function describeStale(jobs: HousekeepingJob[]): string | null {
  const stale = jobs.filter((j) => j.stale);
  if (!stale.length) return null;
  const parts = stale.map((j) =>
    j.lastOkAt
      ? `${j.name} last finished ${duration(j.sinceOkMs)} ago`
      : `${j.name} hasn't finished once in ${duration(j.sinceOkMs)}`,
  );
  return `maintenance is stale: ${parts.join('; ')}${stale.some((j) => j.running) ? ' (still running)' : ''}`;
}
