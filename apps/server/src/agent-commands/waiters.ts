/**
 * Runners waiting on a `run_command` approval (`runner.authorizeWait`, a long poll): a decision wakes them at once
 * (`approvalChanged`, after the decision commits); otherwise they look again every second until their wait is over. One
 * server process (BP-10): the map lives with the services.
 */
import type { Services } from '../services';

const waiting = new WeakMap<Services, Map<string, Set<() => void>>>();

function waitersOf(services: Services): Map<string, Set<() => void>> {
  let map = waiting.get(services);
  if (!map) {
    map = new Map();
    waiting.set(services, map);
  }
  return map;
}

/** Resolves when the approval changes, after `ms`, or when `signal` aborts — whichever comes first. */
export function approvalChangeOrTimeout(
  services: Services,
  approvalId: string,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const map = waitersOf(services);
    let set = map.get(approvalId);
    if (!set) {
      set = new Set();
      map.set(approvalId, set);
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      const current = map.get(approvalId);
      current?.delete(done);
      if (current && current.size === 0) map.delete(approvalId);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    set.add(done);
    if (signal?.aborted) done();
    else signal?.addEventListener('abort', done, { once: true });
  });
}

/** Wakes every runner waiting on the approval (a person decided). */
export function approvalChanged(services: Services, approvalId: string): void {
  const set = waitersOf(services).get(approvalId);
  if (!set) return;
  for (const done of [...set]) done();
}

/** Whether a runner is waiting on the approval in this process right now. */
export function runnerWaiting(services: Services, approvalId: string): boolean {
  return (waitersOf(services).get(approvalId)?.size ?? 0) > 0;
}
