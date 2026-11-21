/**
 * The last-seen burrow read back from the phone (AP-717) while the session comes up: the first screen waits for it at
 * most `waitMs`. Whenever it lands — in time or after the first screen — the account it was saved under is told
 * (`restored`), so a copy of another account or permissions is dropped once the session says who it is. One that came
 * late is in the cache all the same, and was kept before only because nobody was told.
 */
export function readBackCopy(
  restore: Promise<string | null>,
  waitMs: number,
  on: {
    /** The copy is in the cache, saved under `account`; `late`: after the first screen. */
    restored(account: string, late: boolean): void;
    /** The first screen may show (once). */
    ready(): void;
  },
  wait: (ms: number) => Promise<void> = (ms) => new Promise((ok) => setTimeout(ok, ms)),
): () => void {
  let alive = true;
  const timeout = wait(waitMs).then(() => 'late' as const);
  void Promise.race([restore, timeout]).then((first) => {
    if (!alive) return;
    if (first !== 'late') {
      if (first) on.restored(first, false);
      on.ready();
      return;
    }
    on.ready();
    void restore.then((account) => {
      if (alive && account) on.restored(account, true);
    });
  });
  return () => {
    alive = false;
  };
}
