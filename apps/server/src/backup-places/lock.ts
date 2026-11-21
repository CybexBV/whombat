/**
 * One place flow at a time per box (docs/decisions/backup-places.md BPL-S10): setting a place up, removing one, the
 * keep-the-place-right job and setting a destination each read where backups go before they change it, so they wait
 * for each other. In memory: a restart ends every flow anyway.
 */
import type { Services } from '../services';
import { forgetServers } from './servers-cache';

const locks = new WeakMap<Services, Promise<unknown>>();

/** Runs `fn` once the box's other place flows are done. */
export function oneAtATime<T>(services: Services, fn: () => Promise<T>): Promise<T> {
  const before = locks.get(services) ?? Promise.resolve();
  // Whatever the flow changed on a place shows on the next read.
  const run = before
    .catch(() => undefined)
    .then(fn)
    .finally(() => forgetServers(services));
  locks.set(
    services,
    run.catch(() => undefined),
  );
  return run;
}
