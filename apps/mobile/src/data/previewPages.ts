/**
 * What the chat's live pages keep between their rows being drawn. Pure (no React Native imports) so it is unit-tested
 * in Node.
 *
 * A diagram's page embeds the whole Mermaid runtime (megabytes of text): building it again whenever its row comes back
 * into the list's window, or the theme changes back, cost more than drawing the row. A page's height is what it said
 * last, so a row drawn again, or a page let go while out of view, keeps its size instead of jumping.
 */

/** Pages kept: a few, each megabytes. */
export const KEPT_PAGES = 4;
/** Heights kept: numbers, many. */
export const KEPT_HEIGHTS = 200;

/** A small map that forgets the entry asked for least recently. */
function lru<V>(max: number) {
  const map = new Map<string, V>();
  return {
    get(key: string): V | undefined {
      const value = map.get(key);
      if (value !== undefined) {
        map.delete(key);
        map.set(key, value);
      }
      return value;
    },
    set(key: string, value: V): void {
      map.delete(key);
      map.set(key, value);
      while (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    get size() {
      return map.size;
    },
  };
}

const pages = lru<string>(KEPT_PAGES);
const heights = lru<number>(KEPT_HEIGHTS);

/** The page kept for `key` (a diagram's source and theme), or the one `make` builds, kept from then on. */
export function keptPage(key: string, make: () => string): string {
  let page = pages.get(key);
  if (page === undefined) {
    page = make();
    pages.set(key, page);
  }
  return page;
}

export function keptPageHeight(key: string): number | undefined {
  return heights.get(key);
}

export function keepPageHeight(key: string, height: number): void {
  heights.set(key, height);
}
