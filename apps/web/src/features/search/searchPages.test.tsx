/**
 * Short and empty search pages (Whombat search-pagination.md SRP-05): a page may hold fewer results than asked for —
 * even none — and still have a `next`. The screen then loads on by itself while it has nothing to show (a skeleton,
 * never “No results”), offers “Load more” under a short page, stops loading by itself after `SEARCH_AUTOLOAD_PAGES`
 * empty pages, and starts the walk again when the Whombat refuses an out-of-date cursor.
 */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SEARCH_WORDS } from '@whombat/client';
import { removeMessageEverywhere, SEARCH_AUTOLOAD_PAGES } from '@whombat/client/query';
import { countSearchResults, type SearchResponse, type SearchResult } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch, FIXTURE_BASE_URL } from '../../app/fixtureFetch';
import { mockedServices, renderApp } from '../../test/renderApp';

const Q = 'quokka';

function result(n: number): SearchResult {
  return {
    id: `msg_page-${n}`,
    type: 'MESSAGE',
    where: 'Chat · today 10:02',
    authorId: 'prn_mara',
    snippet: `Burrow ledger line ${n}`,
    citedAs: null,
    link: { type: 'dm', room: 'chat' },
    createdAt: '2026-09-23T08:02:00.000Z',
    status: null,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * The fixture world, with search answered by `pageFor(cursor)` (a response, or a promise of one to hold a page back)
 * and the researcher's answer switched off (an answer card would hide the empty note).
 */
function world(pageFor: (cursor: string | null, call: number) => Response | Promise<Response>) {
  const fixtures = createWebFixtureFetch();
  const calls: (string | null)[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), FIXTURE_BASE_URL);
    if (url.pathname.endsWith('/search')) {
      const cursor = url.searchParams.get('cursor');
      calls.push(cursor);
      return pageFor(cursor, calls.length);
    }
    if (url.pathname.endsWith('/search/answers'))
      return json(
        {
          answer: {
            id: 'ans_none',
            burrowId: 'bur_burrow-hq',
            query: Q,
            agentId: 'prn_dusty',
            status: 'none',
            text: '',
            citations: [],
            durationMs: null,
            actions: [],
            createdAt: '2026-09-23T09:22:00.000Z',
          },
        },
        202,
      );
    return fixtures(url.toString(), init);
  });
  return { calls, services: mockedServices(fetch as typeof globalThis.fetch) };
}

const page = (results: SearchResult[], next: string | null, counts = results): SearchResponse => ({
  query: Q,
  results,
  counts: countSearchResults(counts),
  answer: null,
  next,
});

const noResults = () => screen.queryByText(SEARCH_WORDS.noResultsTitle(Q));
const loading = () => document.querySelector('[data-screen="search"] [data-state="loading"]');

describe('short and empty search pages', () => {
  it('loads on past empty pages that have a next, with a skeleton and never “No results”', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const w = world(async (cursor) => {
      if (!cursor) return json(page([], 'c1', [result(1), result(2)]));
      if (cursor === 'c1') return json(page([], 'c2', [result(1), result(2)]));
      await held;
      return json(page([result(1), result(2)], null));
    });
    renderApp(`/search?q=${Q}`, w.services);
    // Two empty pages in, the third held back: still searching.
    await waitFor(() => expect(w.calls).toEqual([null, 'c1', 'c2']));
    expect(loading()).not.toBeNull();
    expect(noResults()).toBeNull();
    release();
    expect(await screen.findByText('Burrow ledger line 1')).toBeTruthy();
    expect(screen.getByText('Burrow ledger line 2')).toBeTruthy();
    expect(noResults()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('says “No results” only when the last page has no next', async () => {
    const w = world((cursor) => json(cursor ? page([], null) : page([], 'c1')));
    renderApp(`/search?q=${Q}`, w.services);
    expect(await screen.findByText(SEARCH_WORDS.noResultsTitle(Q))).toBeTruthy();
    expect(w.calls).toEqual([null, 'c1']);
  });

  it('offers “Load more” under a short page instead of loading on by itself', async () => {
    const user = userEvent.setup();
    const w = world((cursor) => json(cursor ? page([result(2)], null) : page([result(1)], 'c1')));
    renderApp(`/search?q=${Q}`, w.services);
    expect(await screen.findByText('Burrow ledger line 1')).toBeTruthy();
    const more = await screen.findByRole('button', { name: 'Load more' });
    expect(w.calls).toEqual([null]);
    await user.click(more);
    expect(await screen.findByText('Burrow ledger line 2')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull());
  });

  it('stops loading by itself after enough empty pages and offers “Load more”, not “No results”', async () => {
    const user = userEvent.setup();
    const w = world((cursor, call) =>
      json(cursor === `c${SEARCH_AUTOLOAD_PAGES + 1}` ? page([result(9)], null) : page([], `c${call}`)),
    );
    renderApp(`/search?q=${Q}`, w.services);
    const more = await screen.findByRole('button', { name: 'Load more' });
    expect(w.calls).toHaveLength(SEARCH_AUTOLOAD_PAGES + 1);
    expect(noResults()).toBeNull();
    await user.click(more);
    expect(await screen.findByText('Burrow ledger line 9')).toBeTruthy();
  });

  it('starts the walk again when the Whombat refuses an out-of-date cursor', async () => {
    const user = userEvent.setup();
    const w = world((cursor, call) => {
      if (cursor === 'stale')
        return json(
          {
            error: {
              code: 'validation_failed',
              message: 'The request query is not valid.',
              fields: {
                cursor: [
                  'This cursor belongs to another search, or is out of date. Search again without it.',
                ],
              },
            },
          },
          400,
        );
      if (cursor === 'fresh') return json(page([result(2)], null));
      return json(page([result(1)], call === 1 ? 'stale' : 'fresh'));
    });
    renderApp(`/search?q=${Q}`, w.services);
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Couldn’t load more results. Try again in a moment.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    // The first page again (a fresh cursor), then on from there.
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Burrow ledger line 2')).toBeTruthy();
    expect(w.calls).toEqual([null, 'stale', null, 'fresh']);
    expect(screen.queryByText('Couldn’t load more results. Try again in a moment.')).toBeNull();
  });

  it('lowers the chips once when a result on a later page is deleted', async () => {
    const user = userEvent.setup();
    const both = [result(1), result(2)];
    const w = world((cursor) => json(cursor ? page([result(2)], null, both) : page([result(1)], 'c1', both)));
    renderApp(`/search?q=${Q}`, w.services);
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Burrow ledger line 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All 2' })).toBeTruthy();
    act(() => removeMessageEverywhere(w.services.queryClient, 'cnv_general', 'msg_page-2'));
    await waitFor(() => expect(screen.queryByText('Burrow ledger line 2')).toBeNull());
    expect(screen.getByRole('button', { name: 'All 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Threads 1' })).toBeTruthy();
  });
});
