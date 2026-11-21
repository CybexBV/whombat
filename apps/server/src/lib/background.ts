/**
 * Work after a commit that must not hold its response up (docs/decisions/server-efficiency.md SV-02): unread badges,
 * a message's notification fan-out and push delivery. Tracked so shutdown and tests can wait for it (`settle`);
 * failures are logged, never thrown.
 */

interface Log {
  warn(obj: object, msg?: string): void;
}

export class BackgroundWork {
  readonly #pending = new Set<Promise<unknown>>();
  /** Per key: the last work queued, so the next one starts after it. */
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(private readonly log: () => Log) {}

  /** Starts `work` now, in the background. */
  run(what: string, work: () => Promise<unknown>): void {
    this.#track(Promise.resolve().then(work), what);
  }

  /**
   * Runs `work` once every earlier work of `key` has finished (in the order they came): a room's unread badges are
   * computed one after another, so the last one published is the newest count.
   */
  serial(key: string, what: string, work: () => Promise<unknown>): void {
    const before = this.#chains.get(key) ?? Promise.resolve();
    const p = before.then(work);
    // The chain itself never rejects, so a failure doesn't stop the next work of the key; the last one clears it.
    const link: Promise<unknown> = p
      .catch(() => {})
      .finally(() => {
        if (this.#chains.get(key) === link) this.#chains.delete(key);
      });
    this.#chains.set(key, link);
    this.#track(p, what);
  }

  #track(work: Promise<unknown>, what: string): void {
    const p = work
      .catch((err) => this.log().warn({ err: String(err) }, `background: ${what} failed`))
      .finally(() => this.#pending.delete(p));
    this.#pending.add(p);
  }

  /** How much is running or queued now. */
  get size(): number {
    return this.#pending.size;
  }

  /** Resolves once nothing runs, including work started meanwhile (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }
}
