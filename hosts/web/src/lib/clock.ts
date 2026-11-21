// A shared 1 s clock for relative times ("Updated 8 s ago"). One interval for
// the whole app; components subscribe through useSyncExternalStore.

import { useSyncExternalStore } from 'react';

let now = Date.now();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  if (!timer) {
    timer = setInterval(() => {
      now = Date.now();
      for (const s of subs) s();
    }, 1000);
  }
  return () => {
    subs.delete(fn);
    if (!subs.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/**
 * Current time in ms, updated once per second. With `step` (ms) the value
 * is rounded down to it, so a component that shows minutes or days
 * re-renders once per step instead of every second.
 */
export function useNow(step = 1000): number {
  const snap = () => (step > 1000 ? Math.floor(now / step) * step : now);
  return useSyncExternalStore(subscribe, snap, snap);
}

/** Non-reactive read (event handlers, effects). */
export function currentTime(): number {
  return Date.now();
}
