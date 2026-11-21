/**
 * Paging search results (Whombat docs/decisions/search-pagination.md SRP-05, SRP-08): a page may hold fewer results than
 * asked for — even none — and still have a `next`; only `next: null` says the search ended. A walk goes on from each
 * page's `next`; pages of an older walk (a first page refetched since) don't mix in.
 */
import type { SearchResponse, SearchResult } from '@whombat/core';

/** Further pages a screen loads by itself while it has nothing to show yet, before it offers “Load more”. */
export const SEARCH_AUTOLOAD_PAGES = 10;

/**
 * The cursors of the walk from the current first page: a further page counts only while its cursor is still the `next`
 * of the page before it (a refetched page that ends elsewhere now drops the pages after it, so nothing is skipped). A
 * page still loading can't be checked yet and keeps the ones after it.
 */
export function searchWalk(
  first: Pick<SearchResponse, 'next'> | undefined,
  cursors: readonly string[],
  pages: readonly (Pick<SearchResponse, 'next'> | undefined)[],
): string[] {
  const walk: string[] = [];
  let before: Pick<SearchResponse, 'next'> | undefined = first;
  for (const [i, cursor] of cursors.entries()) {
    if (before && before.next !== cursor) break;
    walk.push(cursor);
    before = pages[i];
  }
  return walk;
}

/** The results of the pages in order, each once (one that moved to a later page stays where it was first shown). */
export function searchWalkResults(
  pages: readonly (Pick<SearchResponse, 'results'> | undefined)[],
): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const page of pages) {
    for (const r of page?.results ?? []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

/**
 * Whether to load the next page without being asked: nothing to show yet while the search goes on (a short page is not
 * “No results”), nothing loading or failed, and fewer than `SEARCH_AUTOLOAD_PAGES` further pages so far.
 */
export function searchKeepsLoading(state: {
  shown: number;
  next: string | null | undefined;
  loading: boolean;
  failed: boolean;
  pages: number;
}): boolean {
  return (
    state.shown === 0 &&
    !!state.next &&
    !state.loading &&
    !state.failed &&
    state.pages < SEARCH_AUTOLOAD_PAGES
  );
}
