/**
 * The Find My connection's Timeline tab against the fixture world: everyone's day with who isn't kept, one person's
 * day as a list in plain words, unticking someone asks first, the assistant switch sets the `findmy_timeline` tool's
 * tier, and stopping goes back to the card before it's on, which keeps a timeline again for whoever is ticked.
 */
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { burrow } from '@whombat/fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../../app/fixtureFetch';
import { Providers } from '../../../app/providers';
import { mockedServices } from '../../../test/renderApp';
import { ThingScreen } from '../ThingScreen';

/** Whose days a change asked to keep. */
const peopleOf = (c: { body: unknown } | undefined) => (c?.body as { people?: string[] } | null)?.people;

/** 15:20 on Monday 23 November 2026 in the zone the test runs in, which the tab cuts its days in too. */
const NOW = new Date(2026, 10, 23, 15, 20).getTime();

/** The fixture world with studio and its Find My connection on its Timeline tab, recording what it changes. */
function open() {
  localStorage.setItem('whombat.fixtures.mac', '1');
  const inner = createWebFixtureFetch({ hosts: true, connectors: 'connected' });
  const changes: { method: string; path: string; body: unknown }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    const req = input instanceof Request ? input : new Request(url, init);
    if (req.method !== 'GET' && /\/connections\/con_findmy\//.test(url.pathname)) {
      const text = await req.clone().text();
      changes.push({
        method: req.method,
        path: url.pathname.replace(/^.*\/con_findmy/, ''),
        body: text ? JSON.parse(text) : null,
      });
    }
    return inner(req);
  });
  const root = createRootRoute({ component: () => <Outlet /> });
  const thing = createRoute({
    getParentRoute: () => root,
    path: 'things/$thing',
    component: function Thing() {
      const { thing: id } = thing.useParams();
      return <ThingScreen burrow={burrow.slug} thing={id} />;
    },
  });
  const history = createMemoryHistory({ initialEntries: ['/things/connection%3Acon_findmy?tab=timeline'] });
  const router = createRouter({ routeTree: root.addChildren([thing]), history });
  render(
    <Providers services={mockedServices(fetch)}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { changes };
}

describe('the Find My connection’s Timeline tab', () => {
  beforeEach(() => {
    // Only the clock is fake: the fixture's days are cut at now.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    localStorage.removeItem('whombat.fixtures.mac');
    vi.useRealTimers();
  });

  it('shows everyone’s day and one person’s stops in plain words', async () => {
    open();
    const user = userEvent.setup();
    const everyone = (await screen.findByRole('heading', { name: 'Everyone' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(everyone).getByText(/^Reads every 15 minutes · last read/)).toBeTruthy();
    expect(within(everyone).getByRole('button', { name: 'Keep Ilse’s too' })).toBeTruthy();
    expect(within(everyone).getByRole('img', { name: 'Ruben’s today' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Day after' })).toHaveProperty('disabled', true);

    await user.click(within(everyone).getByRole('button', { name: /Ruben/, pressed: false }));
    const card = (await screen.findByRole('heading', { name: 'Ruben Visser' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(card).getByText(/^Now in Wilgendam · seen 5 min ago$/)).toBeTruthy();
    expect(within(card).getByText('Lines join the spots Whombat read, not the way Ruben went.')).toBeTruthy();
    expect(within(card).getByText('Studio was in use, so Whombat left it alone.')).toBeTruthy();
    expect(within(card).getAllByText('On the way').length).toBeGreaterThan(0);
    expect(within(card).getAllByText('1 h 35 min so far').length).toBeGreaterThan(0);
    expect(within(card).getByText('Now')).toBeTruthy();
  });

  it('asks before unticking someone, and the assistant switch sets the tool’s tier', async () => {
    const { changes } = open();
    const user = userEvent.setup();
    const settings = (await screen.findByRole('heading', { name: 'Timeline settings' })).closest(
      'section',
    ) as HTMLElement;
    await user.click(within(settings).getByRole('checkbox', { name: 'Keep Noor’s timeline' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Stop keeping Noor’s timeline?' })).toBeTruthy();
    expect(changes).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Delete Noor’s days' }));
    await waitFor(() => expect(changes.map((c) => c.method)).toEqual(['PUT']));
    expect(changes[0]?.path).toBe('/find-my/timeline');
    expect(peopleOf(changes[0])).toHaveLength(1);

    const toggle = within(settings).getByRole('switch', { name: /can read the timeline$/ });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await user.click(toggle);
    await waitFor(() =>
      expect(changes.at(-1)).toMatchObject({ method: 'PATCH', path: '/tools/findmy_timeline' }),
    );
    expect(changes.at(-1)?.body).toEqual({ tier: 'off' });
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  });

  it('stops, then keeps a timeline again for whoever is ticked', async () => {
    const { changes } = open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Stop…' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Stop and delete' }),
    );
    expect(await screen.findByRole('heading', { name: 'Keep a timeline?' })).toBeTruthy();
    expect(changes.at(-1)?.body).toEqual({ people: [] });
    const keep = screen.getByRole('button', { name: 'Keep a timeline' });
    expect(keep).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('checkbox', { name: 'Keep Ilse’s timeline' }));
    await user.click(keep);
    await waitFor(() => expect(peopleOf(changes.at(-1))).toHaveLength(1));
    expect(await screen.findByRole('heading', { name: 'Everyone' })).toBeTruthy();
  });
});
