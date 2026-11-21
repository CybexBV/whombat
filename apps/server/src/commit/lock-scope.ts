/**
 * Whether the running code holds the burrow's write lock: it is inside a commit-pipeline transaction. Every write of
 * the box waits while it is held, so a call to an outside service (Google, a provider's API) belongs after the commit
 * (`TxSession.complete`), not inside it; `assertOutsideLock` says so where such calls start.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const held = new AsyncLocalStorage<true>();

/** Runs `fn` as holding the burrow lock (the pipeline's transaction body). */
export function underBurrowLock<R>(fn: () => Promise<R>): Promise<R> {
  return held.run(true, fn);
}

/** Whether the burrow lock is held here. */
export function holdsBurrowLock(): boolean {
  return held.getStore() === true;
}

/**
 * Refuses an outside call made while the burrow lock is held: it throws in development and tests, and only logs in
 * production, where failing a person's action over it would be worse than the wait.
 */
export function assertOutsideLock(
  what: string,
  env: { production: boolean; warn: (msg: string) => void },
): void {
  if (!holdsBurrowLock()) return;
  const msg = `${what} was called while the burrow's write lock is held; call it after the commit`;
  if (env.production) env.warn(msg);
  else throw new Error(msg);
}
