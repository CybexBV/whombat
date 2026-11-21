/**
 * Search pages (Whombat search-pagination.md SRP-05, SRP-08): short and empty pages with a `next` go on, a walk only
 * chains pages whose cursor is still the page before's `next`, and every result shows once.
 */
import { QueryClient } from '@tanstack/query-core';
import { api, type SearchResponse, type SearchResult } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { message, t } from '../test/fixtures';
import { applyRealtimeEvent, createCacheSyncState, removeMessageEverywhere } from './apply';
import { endpointKey } from './keys';
import { SEARCH_AUTOLOAD_PAGES, searchKeepsLoading, searchWalk, searchWalkResults } from './searchPages';

function result(id: string): SearchResult {
  return {
    id,
    type: 'MESSAGE',
    where: 'Chat · today 10:02',
    authorId: 'prn_mara',
    snippet: id,
    citedAs: null,
    link: { type: 'dm', room: 'chat' },
    createdAt: '2026-09-30T10:02:00.000Z',
    status: null,
  };
}

const page = (ids: string[], next: string | null): Pick<SearchResponse, 'results' | 'next'> => ({
  results: ids.map(result),
  next,
});

describe('searchWalk', () => {
  it('chains the cursors that are still the next of the page before', () => {
    expect(searchWalk(page(['a'], 'c1'), ['c1', 'c2'], [page(['b'], 'c2'), page(['c'], null)])).toEqual([
      'c1',
      'c2',
    ]);
  });

  it('drops the pages after a page that now ends elsewhere', () => {
    // The first page was refetched and ends at another row now: the old second page doesn't follow it.
    expect(searchWalk(page(['a'], 'c1*'), ['c1', 'c2'], [page(['b'], 'c2'), page(['c'], null)])).toEqual([]);
    expect(searchWalk(page(['a'], 'c1'), ['c1', 'c2'], [page(['b'], 'c2*'), page(['c'], null)])).toEqual([
      'c1',
    ]);
  });

  it('keeps pages after one that is still loading', () => {
    expect(searchWalk(page(['a'], 'c1'), ['c1', 'c2'], [undefined, undefined])).toEqual(['c1', 'c2']);
    expect(searchWalk(undefined, ['c1'], [undefined])).toEqual(['c1']);
  });
});

describe('searchWalkResults', () => {
  it('lists every page’s results in order, each once, with empty and missing pages in between', () => {
    const ids = searchWalkResults([
      page(['a', 'b'], 'c1'),
      page([], 'c2'),
      undefined,
      page(['b', 'c'], null),
    ]).map((r) => r.id);
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});

describe('searchKeepsLoading', () => {
  const base = { shown: 0, next: 'c1', loading: false, failed: false, pages: 0 };

  it('goes on by itself while an empty page still has a next', () => {
    expect(searchKeepsLoading(base)).toBe(true);
    expect(searchKeepsLoading({ ...base, pages: SEARCH_AUTOLOAD_PAGES - 1 })).toBe(true);
  });

  it('stops when something shows, the search ended, a page is on its way or failed, or after enough pages', () => {
    expect(searchKeepsLoading({ ...base, shown: 1 })).toBe(false);
    expect(searchKeepsLoading({ ...base, next: null })).toBe(false);
    expect(searchKeepsLoading({ ...base, loading: true })).toBe(false);
    expect(searchKeepsLoading({ ...base, failed: true })).toBe(false);
    expect(searchKeepsLoading({ ...base, pages: SEARCH_AUTOLOAD_PAGES })).toBe(false);
  });
});

describe('a result that leaves the pages of a search', () => {
  const CONV = 'cnv_chat';
  const B = { burrow: 'burrow-hq' };
  const key = (query: Record<string, string>) =>
    endpointKey(api.search.query, { params: B, query: { q: 'pdf', ...query } });
  const counted = (ids: string[], next: string | null, total: number): SearchResponse => ({
    ...(page(ids, next) as SearchResponse),
    query: 'pdf',
    answer: null,
    counts: {
      all: total,
      threads: total,
      patches: 0,
      runs: 0,
      canvases: 0,
      plans: 0,
      decisions: 0,
      automations: 0,
    },
  });

  function seeded() {
    const qc = new QueryClient();
    // One search walked to its second page (the chips show the first page's counts), and another search.
    qc.setQueryData(key({}), counted(['msg_1', 'msg_2'], 'c1', 4));
    qc.setQueryData(key({ cursor: 'c1' }), counted(['msg_3', 'msg_4'], null, 4));
    qc.setQueryData(key({ q: 'invoice' }), counted(['msg_1'], null, 1));
    return qc;
  }
  const at = (qc: QueryClient, query: Record<string, string>) => qc.getQueryData<SearchResponse>(key(query));

  it('lowers the counts once, on every page of the search, whichever page held it', () => {
    const qc = seeded();
    removeMessageEverywhere(qc, CONV, 'msg_4');
    expect(at(qc, {})?.counts).toMatchObject({ all: 3, threads: 3 });
    expect(at(qc, {})?.results.map((r) => r.id)).toEqual(['msg_1', 'msg_2']);
    expect(at(qc, { cursor: 'c1' })?.counts).toMatchObject({ all: 3, threads: 3 });
    expect(at(qc, { cursor: 'c1' })?.results.map((r) => r.id)).toEqual(['msg_3']);
    // A search that didn't show it keeps its counts; the same removal again changes nothing.
    expect(at(qc, { q: 'invoice' })?.counts.all).toBe(1);
    removeMessageEverywhere(qc, CONV, 'msg_4');
    expect(at(qc, {})?.counts.all).toBe(3);
  });

  it('does the same for a tombstone, and for a result on the first page', () => {
    const qc = seeded();
    const state = createCacheSyncState(() => Date.parse(t(30)));
    const tombstone = message('msg_3', { conversationId: CONV, text: '', replyCount: 1, deletedAt: t(12) });
    applyRealtimeEvent(qc, { type: 'message.updated', message: tombstone }, { at: t(12) }, state);
    expect(at(qc, {})?.counts.all).toBe(3);
    expect(at(qc, { cursor: 'c1' })?.results.map((r) => r.id)).toEqual(['msg_4']);
    removeMessageEverywhere(qc, CONV, 'msg_1');
    expect(at(qc, {})?.counts.all).toBe(2);
    expect(at(qc, { cursor: 'c1' })?.counts.all).toBe(2);
    expect(at(qc, { q: 'invoice' })?.counts.all).toBe(0);
  });
});
