// Whether the page is getting live data: the hub's event stream is open and
// the browser is online. The shell shows a quiet line when it has not been
// for a while, so nobody trusts numbers that stopped moving.

import { useSyncExternalStore } from 'react';

interface LiveStatus {
  /** The event stream is connected. */
  stream: boolean;
  /** When the stream (or the network) last went down; null while live. */
  downSince: number | null;
}

let state: LiveStatus = { stream: true, downSince: null };
const subs = new Set<() => void>();

function emit(next: LiveStatus): void {
  state = next;
  for (const s of subs) s();
}

/** Called by the event stream: open (true) or failing (false). */
export function setStreamLive(live: boolean): void {
  if (live === state.stream) return;
  emit({ stream: live, downSince: live ? null : Date.now() });
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** How long a gap is tolerated before it is shown (EventSource retries every 5 s). */
export const STALE_AFTER_MS = 15_000;
