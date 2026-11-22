/**
 * Servers in the web app (one-whombat-things.md AP-1300…): a server's page as mock 2 (header, figures, busiest guests,
 * the Ask pane's chat), a guest's edit through the review and power asking first (the servers list and Add a server
 * are Connections', `features/home/connections.test.tsx`) — against the fixture world (`VITE_FIXTURE_HOSTS`'s layer). The things route is stream WS's, so the screen is mounted
 * under a router of its own here.
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
import { describe, expect, it } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { Providers } from '../../app/providers';
import type { AppServices } from '../../app/services';
import { fixtureServices, mockedServices } from '../../test/renderApp';
import { ThingScreen } from './ThingScreen';

const text = (el: Element | null) => (el?.textContent ?? '').replaceAll(' ', ' ');

function renderThing(url: string, services: AppServices = fixtureServices({ hosts: true })) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const thing = createRoute({
    getParentRoute: () => root,
    path: 'things/$thing',
    component: function Thing() {
      const { thing: id } = thing.useParams();
      return <ThingScreen burrow={burrow.slug} thing={id} />;
    },
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: 'settings',
    component: () => <p>Settings</p>,
  });
  const history = createMemoryHistory({ initialEntries: [url] });
  const router = createRouter({ routeTree: root.addChildren([thing, settings]), history });
  const view = render(
    <Providers services={services}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { ...view, history, location: () => `${history.location.pathname}${history.location.search}` };
}

describe('a server’s page (mock 2)', () => {
  it('shows the header with its verdict, the figures in words, the busiest machines and the chat about it', async () => {
    const user = userEvent.setup();
    const { location } = renderThing('/things/server%3Apve-02');
    expect(await screen.findByRole('heading', { level: 1, name: 'pve-02' })).toBeTruthy();
    // One badge (dashboards.md DS-01); its one hint, the warm CPU, is a heads-up and doesn't count
    // (quiet-notices.md AP-4812): the hub's own words. The verdict says it in a sentence.
    expect(screen.getByText('Running hot')).toBeTruthy();
    expect(screen.getByText(/^pve-02 is running hot\./)).toBeTruthy();
    // Versions and what Whombat may do are Technical details now, not chips.
    expect(screen.queryByRole('list', { name: 'About it' })).toBeNull();
    // Ask first; a shell and the power are behind ⋯.
    expect(screen.queryByRole('button', { name: /^Shell/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'More for pve-02' }));
    expect(
      within(screen.getByRole('menu', { name: 'More for pve-02' }))
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual(['Rename', 'Open a shell', 'Restart pve-02', 'Shut pve-02 down']);
    await user.keyboard('{Escape}');
    const glance = await screen.findByRole('region', { name: 'At a glance' });
    expect(text(glance)).toContain('Memory');
    expect(text(glance)).toContain('free');
    expect(text(glance)).not.toContain('Guests');
    expect(screen.getByRole('tab', { name: 'Summary', selected: true })).toBeTruthy();
    const busiest = (await screen.findByRole('heading', { name: 'Busiest machines' })).closest(
      'section',
    ) as HTMLElement;
    const rowEls = within(busiest).getAllByRole('row').slice(1);
    const rows = rowEls.map((r) => text(r));
    // The machine's page from its name; no type code under it and no console button in the row (DS-08, DS-09).
    expect(rows[0]).toContain('cli-proxy-api');
    expect(rows[0]).not.toContain('CT 140');
    const first = rowEls[0] as HTMLElement;
    expect(within(first).getByRole('link', { name: 'cli-proxy-api' }).getAttribute('href')).toBe(
      '/things/server%3Apve-02?guest=pve%3A140',
    );
    expect(within(first).queryByRole('link', { name: 'Console' })).toBeNull();
    expect(rows[1]).toContain('restart to apply 1 change');
    // The facts are behind one fold at the foot of the Summary.
    await user.click(screen.getByRole('button', { name: 'Technical details' }));
    const details = screen.getByRole('region', { name: 'Technical details' });
    expect(text(details)).toContain('Address');
    expect(text(details)).toContain('Whombat’s helper');
    expect(text(details)).toContain('Full control');
    // The Ask pane is closed until asked for: the page has the whole width.
    expect(screen.queryByRole('complementary', { name: 'Ask about pve-02' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Ask Neo' }));
    await waitFor(() => expect(location()).toContain('ask='));
    const pane = await screen.findByRole('complementary', { name: 'Ask about pve-02' });
    expect(within(pane).getByText('Neo sees this server’s sensors, guests and history')).toBeTruthy();
    expect(await within(pane).findByText('Why is pve-02 using so much memory?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ask Neo' })).toBeNull();
    await user.click(within(pane).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Ask about pve-02' })).toBeNull());
    expect(location()).not.toContain('ask=');
  });

  it('opens a tab and a guest from the address', async () => {
    const user = userEvent.setup();
    const { location } = renderThing('/things/server%3Apve-02');
    await user.click(await screen.findByRole('button', { name: 'See all' }));
    await waitFor(() => expect(location()).toContain('tab=guests'));
    await user.click(await screen.findByRole('button', { name: 'homeassistant' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'homeassistant' })).toBeTruthy();
    expect(location()).toContain('guest=pve%3A131');
  });
});

describe('a server’s Summary is the dashboard (dashboards.md DS-02, DS-03, DS-16; connections-page.md AP-2510)', () => {
  it('opens a figure’s charts with the range beside them and keeps both in the address', async () => {
    const user = userEvent.setup();
    const { location } = renderThing('/things/server%3Apve-02?range=7d');
    const glance = await screen.findByRole('region', { name: 'At a glance' });
    // “Live, every 10 s” is a Technical detail, not words in the tab row.
    expect(screen.queryByText('Live · every 10 s')).toBeNull();
    // Every chart sits behind a figure: no chart cards and no picker in the tab row.
    expect(screen.queryByRole('group', { name: 'Range' })).toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: 'CPU' })).toBeNull();
    // The figures carry their Overview card's block bars; their history is behind them and behind See reading history.
    expect(await within(glance).findByRole('button', { name: /^See reading history/ })).toBeTruthy();
    await user.click(within(glance).getByRole('button', { name: /^Processor / }));
    await waitFor(() => expect(location()).toContain('chart=cpu'));
    // The processor opens its own chart, the network's and the disks' traffic.
    const open = await within(glance).findByRole('region', { name: /^CPU Network Disk I\/O/ });
    const range = within(open).getByRole('group', { name: 'Range' });
    expect(
      within(range)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent),
    ).toEqual(['1h', '6h', '24h', '7d', '30d', '90d']);
    expect((within(range).getByRole('radio', { name: '7d' }) as HTMLInputElement).checked).toBe(true);
    await user.click(within(range).getByRole('radio', { name: '30d' }));
    await waitFor(() => expect(location()).toContain('range=30d'));
    // The crumb goes back to Overview (CN-09).
    expect(
      within(screen.getByRole('main', { name: 'pve-02' }))
        .getByRole('link', { name: 'Overview' })
        .getAttribute('href'),
    ).toBe('/connections');
    await user.click(screen.getByRole('tab', { name: /^Machines/ }));
    await waitFor(() => expect(location()).toContain('tab=guests'));
    expect(screen.queryByRole('group', { name: 'Range' })).toBeNull();
  });
});

describe('less is more on a server’s page (less-is-more.md AP-1755…AP-1767)', () => {
  it('shows guests’ kinds as icons with their words and finds guests by kind', async () => {
    const user = userEvent.setup();
    renderThing('/things/server%3Athetitan?tab=guests');
    const guests = (await screen.findByRole('heading', { name: 'Machines' })).closest(
      'section',
    ) as HTMLElement;
    const row = (await within(guests).findByRole('button', { name: 'postgres' })).closest(
      'tr',
    ) as HTMLElement;
    expect(within(row).getByRole('img', { name: 'Docker container' }).getAttribute('title')).toBe(
      'Docker container',
    );
    // The kind's short word under the name (CN-08), the icon's words in its tooltip.
    expect(text(row)).toContain('postgresDocker');
    await user.type(within(guests).getByRole('searchbox', { name: 'Find machines by name' }), 'docker');
    await waitFor(() =>
      expect(
        within(guests)
          .getAllByRole('img', { name: /container|VM/ })
          .every((i) => i.getAttribute('aria-label') === 'Docker container'),
      ).toBe(true),
    );
  });

  it('folds the agent’s switches behind one line and lists the network on its own tab', async () => {
    const user = userEvent.setup();
    renderThing('/things/server%3Athetitan?tab=system');
    const fold = (await screen.findByText('What Whombat may do here')).closest(
      'details',
    ) as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(text(fold.querySelector('summary'))).toContain('All 6 allowed');
    await user.click(within(fold).getByText('Details'));
    await waitFor(() => expect(fold.open).toBe(true));
    expect(within(fold).getByRole('switch', { name: 'Shell on the server' })).toBeTruthy();
    expect(within(fold).getByRole('button', { name: 'Remove thetitan' })).toBeTruthy();
    // Incus's raw warning is folded in Technical details, not a notice above it too; the interfaces are on the Network
    // tab.
    expect(screen.queryByText(/Skipping AppArmor for dnsmasq/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Technical details' }));
    expect(screen.getAllByText(/Skipping AppArmor for dnsmasq/)).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Network' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Network' }));
    expect(await screen.findByRole('heading', { name: 'Server network' })).toBeTruthy();
  });

  it('opens the switches by themselves when the server blocks one', async () => {
    const user = userEvent.setup();
    renderThing('/things/server%3Apve-01?tab=system');
    const fold = (await screen.findByText('What Whombat may do here')).closest(
      'details',
    ) as HTMLDetailsElement;
    await waitFor(() => expect(fold.open).toBe(true));
    expect(text(fold.querySelector('summary'))).toContain('switched off on pve-01 itself');
    // Its network (no Network tab here) is with the other internals, in Technical details.
    await user.click(screen.getByRole('button', { name: 'Technical details' }));
    expect(screen.getByRole('heading', { name: 'Network' })).toBeTruthy();
  });
});

describe('a guest', () => {
  it('changes memory through the review and shows it waits for a restart', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    renderThing('/things/server%3Apve-02?guest=pve%3A131&gtab=hardware');
    await user.click(await screen.findByRole('button', { name: 'Change memory' }, { timeout: 5000 }));
    const field = await screen.findByLabelText('Memory (MiB)');
    await user.clear(field);
    await user.type(field, '6144');
    await user.click(screen.getByRole('button', { name: 'Review' }));
    const review = await screen.findByRole('list', { name: 'Changes' });
    expect(text(review)).toBe('memory4096 → 6144');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('A change applies at the next restart')).toBeTruthy();
    expect(await screen.findByText('Saved. homeassistant takes it at its next restart.')).toBeTruthy();
  });

  it('asks before shutting it down', async () => {
    const user = userEvent.setup();
    renderThing('/things/server%3Apve-02?guest=pve%3A131');
    await user.click(await screen.findByRole('button', { name: 'Power for homeassistant' }));
    await user.click(screen.getByRole('menuitem', { name: 'Shut down' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Shut homeassistant down? It closes its programs first.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Shut down' }));
    expect(await screen.findByText('Shutting down homeassistant.')).toBeTruthy();
  });
});

describe('server Storage tab on older boxes', () => {
  it('shows “Check what fills it” on minor 3 and hides it on an older box (minor 2)', async () => {
    const first = renderThing('/things/server%3Apve-02?tab=storage');
    expect(await screen.findByRole('button', { name: 'Check what fills it' })).toBeTruthy();
    first.unmount();

    const base = createWebFixtureFetch({ hosts: true });
    const olderFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
      return base(new Request(url, init), init);
    }) as typeof globalThis.fetch;
    const older = mockedServices(olderFetch, { protocolMinor: 2 });
    renderThing('/things/server%3Apve-02?tab=storage', older);
    expect(await screen.findByRole('heading', { name: 'Disks' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check what fills it' })).toBeNull();
  });
});
