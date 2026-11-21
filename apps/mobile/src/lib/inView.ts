/**
 * Which rows of a list are in view or next to it (AP-909), for what is costly to keep live off screen: a chat row's HTML
 * page runs a WebView. Pure (no React Native imports) so it is unit-tested in Node.
 */

/** How many rows either side of the ones on screen count as in view, so a page is loaded before it scrolls in. */
export const IN_VIEW_MARGIN = 2;

/** A store for `useSyncExternalStore`: a reader asks about its own row and hears only when that changes. */
export interface InViewStore {
  has(id: string): boolean;
  set(ids: ReadonlySet<string>): void;
  subscribe(listener: () => void): () => void;
}

export function createInViewStore(): InViewStore {
  let shown: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  return {
    has: (id) => shown.has(id),
    set(ids) {
      if (ids.size === shown.size && [...ids].every((id) => shown.has(id))) return;
      shown = ids;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The ids of the rows on screen (their indices, as a list reports them) and `margin` rows either side. */
export function rowsNearView(
  ids: readonly string[],
  visible: readonly (number | null | undefined)[],
  margin: number = IN_VIEW_MARGIN,
): Set<string> {
  const at = visible.filter((i): i is number => typeof i === 'number');
  if (!at.length) return new Set();
  const first = Math.max(0, Math.min(...at) - margin);
  const last = Math.min(ids.length - 1, Math.max(...at) + margin);
  return new Set(ids.slice(first, last + 1));
}
