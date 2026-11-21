import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SEARCH_WORDS } from '@whombat/client';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_NAME, DEFAULT_CHAT_ID } from '../../app/oneFixtures';
import { type RecordedCall, recordingWorld } from '../../test/recordingWorld';
import { fixtureServices, mockedServices, renderApp } from '../../test/renderApp';
import { filterShown } from './SearchScreen';

const MOCK_QUERY = 'have we seen this invoice rounding error before?';

async function search() {
  return screen.findByRole('textbox', { name: 'Search everything' });
}

/** The answer card's meta line uniquely identifies it (sidebar entries repeat "Dusty" elsewhere). */
async function answerCard() {
  const meta = await screen.findByText('answered from 3 receipts · 1.8s');
  const card = meta.closest('div')?.parentElement;
  if (!card) throw new Error('answer card container not found');
  return card as HTMLElement;
}

describe('the grouped Search (final-shell-web.md)', () => {
  it('says what to look for under an empty query', async () => {
    const user = userEvent.setup();
    const app = renderApp('/search');
    expect(await screen.findByRole('heading', { name: SEARCH_WORDS.emptyTitle })).toBeTruthy();
    // A suggestion searches for it.
    await user.click(
      within(screen.getByRole('group', { name: SEARCH_WORDS.suggestions })).getByRole('button', {
        name: 'Files',
      }),
    );
    await waitFor(() => expect(app.location()).toBe('/search?q=Files'));
    const places = await screen.findByRole('region', { name: SEARCH_WORDS.groups.places });
    expect(
      within(places)
        .getByRole('link', { name: /^Files/ })
        .getAttribute('href'),
    ).toBe('/files');
  });

  it('groups things and places; Back from a result brings the query and the focus on it again', async () => {
    const user = userEvent.setup();
    const app = renderApp('/search?q=pve-02');
    const things = await screen.findByRole('region', { name: SEARCH_WORDS.groups.things });
    const pve = within(things).getByRole('link', { name: /^pve-02/ });
    await waitFor(() =>
      expect(screen.getAllByRole('status').some((e) => /\d+ results?$/.test(e.textContent ?? ''))).toBe(true),
    );
    await user.click(pve);
    await waitFor(() => expect(app.location()).toMatch(/^\/things\//));
    app.history.back();
    await waitFor(() => expect(app.location()).toBe('/search?q=pve-02'));
    const again = within(await screen.findByRole('region', { name: SEARCH_WORDS.groups.things })).getByRole(
      'link',
      { name: /^pve-02/ },
    );
    await waitFor(() => expect(document.activeElement).toBe(again));
    expect((screen.getByRole('textbox', { name: SEARCH_WORDS.field }) as HTMLInputElement).value).toBe(
      'pve-02',
    );
  });

  it('clears the query with its button', async () => {
    const user = userEvent.setup();
    const app = renderApp('/search?q=vault');
    await user.click(await screen.findByRole('button', { name: SEARCH_WORDS.clear }));
    await waitFor(() => expect(app.location()).toBe('/search'));
    expect(await screen.findByRole('heading', { name: SEARCH_WORDS.emptyTitle })).toBeTruthy();
  });
});

describe('SearchScreen (fixture bootstrap)', () => {
  it('focuses the query field on mount via data-search-input (so ⌘K works)', async () => {
    renderApp('/search');
    const input = await search();
    expect(input.hasAttribute('data-search-input')).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('Escape goes back to where search was opened from (WE-12)', async () => {
    const user = userEvent.setup();
    const app = renderApp('/chat');
    await screen.findByRole('complementary', { name: 'Sidebar' });
    await user.keyboard('{Control>}k{/Control}');
    const input = await search();
    await waitFor(() => expect(app.location()).toBe('/search'));
    await waitFor(() => expect(document.activeElement).toBe(input));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(app.location()).toBe('/chat'));
  });
});

describe('asking the researcher (WE-10)', () => {
  const asks = (calls: RecordedCall[]) => calls.filter((c) => c.path.endsWith('/search/answers'));

  it('never asks on a pause in typing; Enter asks once', async () => {
    const { fetch, calls } = recordingWorld();
    const user = userEvent.setup();
    const app = renderApp('/search', mockedServices(fetch));
    const input = await search();
    await user.type(input, 'rounding');
    await waitFor(() => expect(app.location()).toBe('/search?q=rounding'));
    // The ask slot offers it, but nothing was asked.
    expect(await screen.findByRole('button', { name: `Ask ${ASSISTANT_NAME}` })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 400));
    expect(asks(calls)).toEqual([]);

    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(asks(calls)).toEqual([
        { method: 'POST', path: '/burrows/burrow-hq/search/answers', body: { q: 'rounding' } },
      ]),
    );
    await user.keyboard('{Enter}');
    expect(asks(calls)).toHaveLength(1);
  });

  it('“Ask {name}” asks, and Enter on a new query asks before its results arrive', async () => {
    const { fetch, calls } = recordingWorld();
    const user = userEvent.setup();
    const app = renderApp('/search?q=rounding', mockedServices(fetch));
    await user.click(await screen.findByRole('button', { name: `Ask ${ASSISTANT_NAME}` }));
    await waitFor(() => expect(asks(calls).map((c) => c.body)).toEqual([{ q: 'rounding' }]));

    const input = await search();
    await user.clear(input);
    await user.type(input, `${MOCK_QUERY}{Enter}`);
    await waitFor(() =>
      expect(asks(calls).map((c) => c.body)).toEqual([{ q: 'rounding' }, { q: MOCK_QUERY }]),
    );
    expect(app.location()).toBe(`/search?q=${encodeURIComponent(MOCK_QUERY).replace(/%20/g, '+')}`);
    await answerCard();
  });
});

describe('SearchScreen quiet states (TODO 16.4)', () => {
  it('shows skeleton rows while the results are loading', async () => {
    renderApp(`/search?q=${encodeURIComponent(MOCK_QUERY)}`, fixtureServices({ latencyMs: 60 }));
    // Watch from the first render: waitFor re-checks on every DOM change, so it sees the skeleton however
    // briefly it shows (waiting for the search field first could let the 60 ms window close unseen).
    await waitFor(() =>
      expect(document.querySelector('[data-screen="search"] [data-state="loading"]')).not.toBeNull(),
    );
    await search();
    await answerCard();
  });

  it('shows a one-line error with Retry when the search fails', async () => {
    const user = userEvent.setup();
    renderApp(`/search?q=${encodeURIComponent(MOCK_QUERY)}`, fixtureServices({ failing: ['search.query'] }));
    await search();
    // Nothing else matches the question: the whole page says it couldn't search, with Try again.
    expect(await screen.findByRole('heading', { name: SEARCH_WORDS.failedTitle })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: SEARCH_WORDS.tryAgain }));
    expect(await screen.findByRole('heading', { name: SEARCH_WORDS.failedTitle })).toBeTruthy();
  });
});

describe('search filters for plans, decisions and automations (WS-21)', () => {
  const counts = {
    all: 3,
    threads: 3,
    patches: 0,
    runs: 0,
    canvases: 0,
    plans: 2,
    decisions: 0,
    automations: 0,
  };
  it('shows the mock’s chips always and the new ones when they have results or are chosen', () => {
    expect(filterShown('patches', 'all', counts)).toBe(true);
    // A developer's kinds only where GitHub or website feedback is connected, unless one is picked.
    expect(filterShown('patches', 'all', counts, false)).toBe(false);
    expect(filterShown('runs', 'all', counts, false)).toBe(false);
    expect(filterShown('runs', 'runs', counts, false)).toBe(true);
    expect(filterShown('threads', 'all', counts, false)).toBe(true);
    expect(filterShown('plans', 'all', counts)).toBe(true);
    expect(filterShown('decisions', 'all', counts)).toBe(false);
    expect(filterShown('decisions', 'decisions', counts)).toBe(true);
  });
});

describe('search filters and paging (essentials-messages.md AP-448)', () => {
  it('filters by person, conversation and dates, kept in the address', async () => {
    const user = userEvent.setup();
    const app = renderApp('/search?q=invoice', fixtureServices({ essentials: true }));
    const from = await screen.findByRole('combobox', { name: 'From' });
    expect(await screen.findByText(/3 invoices differ from the ledger/)).toBeTruthy();
    await user.selectOptions(from, 'mara');
    await waitFor(() => expect(app.location()).toBe('/search?q=invoice&from=mara'));
    expect(await screen.findByText(/Invoice PDFs are the focus this week/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/3 invoices differ from the ledger/)).toBeNull());

    await user.selectOptions(screen.getByRole('combobox', { name: 'In' }), DEFAULT_CHAT_ID);
    await waitFor(() => expect(app.location()).toBe(`/search?q=invoice&from=mara&in=${DEFAULT_CHAT_ID}`));
    await waitFor(() => expect(screen.queryByText(/the template review moved to Thursday/)).toBeNull());
    expect(screen.getByText(/Invoice PDFs are the focus this week/)).toBeTruthy();

    await user.selectOptions(screen.getByRole('combobox', { name: 'When' }), 'custom');
    const start = await screen.findByLabelText('Start date');
    expect(screen.getByLabelText('End date')).toBeTruthy();
    expect((start as HTMLInputElement).value).not.toBe('');
    expect(app.location()).toMatch(/&after=\d{4}-\d{2}-\d{2}&before=\d{4}-\d{2}-\d{2}$/);

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(app.location()).toBe('/search?q=invoice'));
    expect((screen.getByRole('combobox', { name: 'When' }) as HTMLSelectElement).value).toBe('any');
  });

  it('opens a filtered link as it was, and says when nothing matches', async () => {
    renderApp(`/search?from=neo&in=${DEFAULT_CHAT_ID}`, fixtureServices({ essentials: true }));
    expect(await screen.findByText(SEARCH_WORDS.noChats(''))).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'From' }) as HTMLSelectElement).value).toBe('neo');
  });

  it('loads further pages with “Load more”', async () => {
    const user = userEvent.setup();
    renderApp('/search?q=invoice', fixtureServices({ essentials: true }));
    const more = await screen.findByRole('button', { name: 'Load more' });
    expect(screen.queryByText(/Invoice PDFs are the focus this week/)).toBeNull();
    await user.click(more);
    expect(await screen.findByText(/Invoice PDFs are the focus this week/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull());
  });
});
