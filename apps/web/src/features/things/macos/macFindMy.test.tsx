/**
 * A Mac's Find My tab against the fixture world's studio: the screen's own reason stops a read, the tab reads when it
 * opens, the people come in Find My's words, and Show exactly opens the picture's dialog while it is taken.
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
import { FIND_MY_FIXTURE_READ_MS } from '@whombat/client/hosts/fixtures';
import { HOST_FIND_MY_POLL_MS } from '@whombat/core/domain';
import { burrow } from '@whombat/fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../../app/fixtureFetch';
import { Providers } from '../../../app/providers';
import { mockedServices } from '../../../test/renderApp';
import { ThingScreen } from '../ThingScreen';

/** The fixture world with servers and studio in `scenario`, recording Find My's requests that change something. */
function open(scenario: string) {
  localStorage.setItem('whombat.fixtures.mac', scenario);
  const inner = createWebFixtureFetch({ hosts: true });
  const posts: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    const req = input instanceof Request ? input : new Request(url, init);
    if (req.method !== 'GET' && url.pathname.includes('/find-my'))
      posts.push(url.pathname.replace(/^.*\/find-my/, ''));
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
  const history = createMemoryHistory({ initialEntries: ['/things/server%3Astudio?tab=findmy'] });
  const router = createRouter({ routeTree: root.addChildren([thing]), history });
  render(
    <Providers services={mockedServices(fetch)}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { posts };
}

describe('a Mac’s Find My tab', () => {
  afterEach(() => {
    localStorage.removeItem('whombat.fixtures.mac');
    vi.useRealTimers();
  });

  it('says the screen’s own reason and doesn’t read', async () => {
    const { posts } = open('sharing-off');
    expect(await screen.findByText('Screen Sharing is off on the Mac.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Read again' })).toHaveProperty('disabled', true);
    expect(posts).toEqual([]);
  });

  it('reads when it opens, lists the people, and takes the exact picture of one', async () => {
    // Only the clock is fake: the fixture Mac's read finishes by it.
    vi.useFakeTimers({ toFake: ['Date'] });
    const { posts } = open('1');
    const user = userEvent.setup();
    expect(await screen.findByText('Reading Find My on studio…')).toBeTruthy();
    await waitFor(() => expect(posts).toEqual(['/refresh']));

    // While it reads the tab asks again every couple of seconds; the next answer has the people.
    vi.setSystemTime(Date.now() + FIND_MY_FIXTURE_READ_MS);
    expect(await screen.findByText('Ruben Visser', {}, { timeout: HOST_FIND_MY_POLL_MS * 2 })).toBeTruthy();
    expect(posts).toEqual(['/refresh']);
    expect(screen.getByText('Home · Now')).toBeTruthy();
    expect(screen.getByText('No location found')).toBeTruthy();
    // Three people have a place, so three can be shown exactly.
    const show = screen.getAllByRole('button', { name: 'Show exactly' });
    expect(show).toHaveLength(3);

    await user.click(show[2] as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Exactly where Ilse de Wit is' })).toBeTruthy();
    expect(within(dialog).getByText('Taking the picture on studio…')).toBeTruthy();
    expect(posts.at(-1)).toBe('/exact');
  });
});
