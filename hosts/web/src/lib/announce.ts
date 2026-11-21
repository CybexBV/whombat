// Polite live region for status changes (a server going offline, a new alert).
// The 10 s refresh itself is never announced. Rendered once by <LiveRegion/>.

import { useSyncExternalStore } from 'react';

let message = '';
let seq = 0;
const subs = new Set<() => void>();

export function announce(text: string): void {
  // Alternate a trailing zero-width space so repeating the same text re-announces.
  seq++;
  message = text + (seq % 2 ? '​' : '');
  for (const s of subs) s();
}

export function useAnnouncement(): string {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => message,
    () => message,
  );
}
