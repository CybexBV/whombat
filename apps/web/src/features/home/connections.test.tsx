/**
 * Overview's Servers (docs/decisions/overview-one-page.md; connections-page.md CN-09, AP-2523): the fleet as one list,
 * the jump links, the servers list's address and Add a server opening here, every guest still at its own address.
 * Against the fixture world with the hosts layer (`VITE_FIXTURE_HOSTS`'s).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HostServer } from '@whombat/core/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../test/renderApp';

const withServers = () => fixtureServices({ hosts: true });
/** The page's own section (the sidebar has a SERVERS list too). */
const group = async (name: string) => {
  const page = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-screen="home"]');
    if (!el) throw new Error('Overview isn’t there yet');
    return el;
  });
  return within(page).findByRole('region', { name });
};
/** The server rows once the fleet is read, in their order. */
const serverRows = (servers: HTMLElement) =>
  waitFor(() => {
    const found = [...servers.querySelectorAll<HTMLElement>('[data-server]')];
    if (!found.length) throw new Error('no rows yet');
    return found;
  });

// The page's screens are loaded before the first test's waits start: imported cold on a busy machine, their modules can
// take most of `findBy`'s five seconds before anything renders.
beforeAll(() => Promise.all([import('./HomeScreen'), import('../settings/ConnectionsPages')]), 30_000);

describe('Servers on Overview (overview-one-page.md OVP-02…OVP-08)', () => {
  it('draws a row per server, worst first, its name the link and each figure a link to its chart', async () => {
    renderApp('/connections', withServers());
    const servers = await group('Servers');
    const rows = await serverRows(servers);
    expect(rows.map((a) => a.dataset.server)).toEqual([
      'blackbox',
      'pve-02',
      'pve-01',
      'the-falcon',
      'thetitan',
    ]);
    const pve = rows[1] as HTMLElement;
    const open = within(pve).getByRole('link', { name: /^pve-02, / });
    expect(open.getAttribute('href')).toBe('/things/server%3Apve-02');
    expect(open.getAttribute('aria-label')).toMatch(/Processor .*Memory .*Storage .*machines running/);
    expect(
      within(pve)
        .getByRole('link', { name: /^Processor \d/ })
        .getAttribute('href'),
    ).toMatch(/\?chart=cpu$/);
    expect(
      within(pve)
        .getByRole('link', { name: /^Storage / })
        .getAttribute('href'),
    ).toMatch(/\?tab=storage$/);
    expect(
      within(pve)
        .getByRole('link', { name: /^\d+ of \d+ machines running/ })
        .getAttribute('href'),
    ).toMatch(/\?tab=guests$/);
    // The five figures in the columns' order; the processor's 24 hours as a line.
    expect([...pve.querySelectorAll<HTMLElement>('[data-cell]')].map((t) => t.dataset.cell)).toEqual([
      'cpu',
      'memory',
      'storage',
      'temp',
      'running',
    ]);
    expect(pve.querySelector('[data-cell="cpu"] svg path')).toBeTruthy();
    // What isn't fine has its pill; a server that runs fine has none, its name says so.
    expect(pve.querySelector('[data-level="needsLook"]')).toBeTruthy();
    const fine = rows[2] as HTMLElement;
    expect(fine.querySelector('[data-level]')).toBeNull();
    expect(within(fine).getByRole('link', { name: /^pve-01, running fine/ })).toBeTruthy();
    // The row that isn't working is set apart; this Whombat's server has its tag.
    expect(rows[0]?.querySelector('[data-level="notWorking"]')).toBeTruthy();
    expect(within(rows[4] as HTMLElement).getByText('This Whombat')).toBeTruthy();
    expect(within(servers).getByRole('link', { name: 'Everything running' }).getAttribute('href')).toBe(
      '/things/servers?view=guests',
    );
  });

  it('sets a server that runs on another under it, and says what it can’t read', async () => {
    const app = renderApp('/connections', withServers());
    const servers = await group('Servers');
    await serverRows(servers);
    const qc = app.services.queryClient;
    for (const q of qc.getQueryCache().findAll({ queryKey: ['whombat', 'hosts.fleet'] })) {
      const data = q.state.data as { servers: HostServer[] } | undefined;
      if (!data) continue;
      qc.setQueryData(q.queryKey, {
        ...data,
        servers: data.servers.map((s) =>
          s.id === 'pve-01'
            ? { ...s, name: 'docker-01', parent: 'pve-02', temperature: null }
            : s.id === 'thetitan'
              ? { ...s, status: 'offline', lastSeen: '2026-01-01T00:00:00Z' }
              : s,
        ),
      });
    }
    await waitFor(() => expect(within(servers).getByRole('link', { name: /^docker-01, / })).toBeTruthy());
    const rows = await serverRows(servers);
    const order = rows.map((r) => r.dataset.server);
    expect(order.indexOf('pve-01')).toBe(order.indexOf('pve-02') + 1);
    const child = rows[order.indexOf('pve-01')] as HTMLElement;
    expect(within(child).getByText(/on pve-02/)).toBeTruthy();
    expect(within(child).getByRole('link', { name: /^Temperature, no sensor/ })).toBeTruthy();
    const off = rows[order.indexOf('thetitan')] as HTMLElement;
    expect(within(off).getByText('Offline')).toBeTruthy();
    expect(within(off).getByText(/^Last seen/)).toBeTruthy();
  });

  it('reviews a server waiting to be added from its row', async () => {
    const user = userEvent.setup();
    const app = renderApp('/connections', withServers());
    const servers = await group('Servers');
    await user.click(await within(servers).findByRole('button', { name: 'Review' }));
    await waitFor(() => expect(app.location()).toMatch(/^\/connections\?add=/));
    const dialog = await screen.findByRole('dialog', { name: 'Add a server' });
    const waiting = await within(dialog).findByRole('region', { name: 'Waiting for you' });
    await user.click(await within(waiting).findByRole('button', { name: 'Add it' }));
    expect(await screen.findByText('Added backup-pi. Its first report comes in a moment.')).toBeTruthy();
  });

  it('opens Add a server from the Servers heading', async () => {
    const user = userEvent.setup();
    const app = renderApp('/connections', withServers());
    const servers = await group('Servers');
    await user.click(within(servers).getByRole('button', { name: 'Add a server' }));
    await waitFor(() => expect(app.location()).toMatch(/^\/connections\?add=/));
    expect(await screen.findByRole('dialog', { name: 'Add a server' })).toBeTruthy();
  });

  it('jumps to a section from the links at the top, and an old tab address scrolls there', async () => {
    const user = userEvent.setup();
    renderApp('/connections?tab=services', withServers());
    const servers = await group('Servers');
    await serverRows(servers);
    const nav = screen.getByRole('navigation', { name: 'On this page' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '#overview-servers',
      '#overview-connections',
      '#overview-pinned',
    ]);
    // Servers counts its rows and carries the dot of the one that isn't working.
    expect(links[0]?.textContent).toMatch(/^Servers5/);
    expect(
      within(links[0] as HTMLElement).getByRole('img', { name: 'something isn’t working' }),
    ).toBeTruthy();
    // The old `?tab=services` landed on Connections.
    await waitFor(() => expect(document.activeElement?.id).toBe('overview-connections'));
    await user.click(links[2] as HTMLElement);
    expect(document.activeElement?.id).toBe('overview-pinned');
  });
});

describe('the servers list’s address (CN-09, AP-2523)', () => {
  it('opens Add a server on Connections, filled in from the assistant’s card', async () => {
    const app = renderApp('/connections', withServers());
    // A link in a chat, once the page is there (the assistant's card, SI-10).
    await serverRows(await group('Servers'));
    app.history.push('/things/servers?add=1&address=10.100.0.14&user=admin&control=operate');
    await waitFor(() =>
      expect(app.location()).toBe('/connections?add=1&address=10.100.0.14&user=admin&control=operate'),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Add a server' });
    const address = await within(dialog).findByLabelText('Address', {}, { timeout: 8_000 });
    expect((address as HTMLInputElement).value).toBe('10.100.0.14');
    expect((within(dialog).getByLabelText('User name') as HTMLInputElement).value).toBe('admin');
    await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => expect(app.location()).toBe('/connections'));
  }, 15_000);

  it('keeps every guest of every server where it was, with the crumb to Connections', async () => {
    const app = renderApp('/things/servers?view=guests', withServers());
    expect(
      await screen.findByRole('heading', { name: 'Everything running on your servers', level: 1 }),
    ).toBeTruthy();
    expect(app.location()).toBe('/things/servers?view=guests');
    const main = screen.getByRole('main', { name: 'Everything running on your servers' });
    expect(within(main).getByRole('link', { name: 'Connections' }).getAttribute('href')).toBe('/connections');
  });
});

describe('add a server by signing in once (server-signin-web.md; on Connections, AP-2523)', () => {
  /** Connections with Add a server opened from a link, once the page is there. */
  async function openAdd(query: string) {
    const app = renderApp('/connections', withServers());
    await serverRows(await group('Servers'));
    app.history.push(`/connections?${query}`);
    const dialog = await screen.findByRole('dialog', { name: 'Add a server' });
    await within(dialog).findByRole('tab', { name: 'Sign in once' }, { timeout: 8_000 });
    return dialog;
  }

  it('says what went wrong and tries again without the password', async () => {
    const user = userEvent.setup();
    const dialog = await openAdd('add=1&address=10.100.0.14&user=admin&control=operate');
    expect(within(dialog).getByRole('tab', { name: 'Sign in once', selected: true })).toBeTruthy();
    expect(
      (within(dialog).getByRole('radio', { name: 'Restart and consoles' }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (within(dialog).getByRole('checkbox', { name: /Leave a Vault key on it/ }) as HTMLInputElement).checked,
    ).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Add server' }));
    expect(within(dialog).getByText('Type its password.')).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Password', { exact: true }), 'wrong');
    await user.click(within(dialog).getByRole('button', { name: 'Add server' }));
    expect(await within(dialog).findByRole('heading', { name: 'Adding 10.100.0.14' })).toBeTruthy();
    // One plain card (connect-in-chat.md): what happened, and Try again.
    expect(
      await within(dialog).findByText(
        'The user name or password for 10.100.0.14 isn’t right.',
        {},
        { timeout: 8_000 },
      ),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect((within(dialog).getByLabelText('Address') as HTMLInputElement).value).toBe('10.100.0.14');
    expect((within(dialog).getByLabelText('Password', { exact: true }) as HTMLInputElement).value).toBe('');
  }, 20_000);

  it('offers the one line to run when the server can’t reach the Whombat (connect-in-chat.md)', async () => {
    const user = userEvent.setup();
    const dialog = await openAdd('add=1&address=10.20.0.5');
    await user.type(within(dialog).getByLabelText('Password', { exact: true }), 'hunter22');
    await user.click(within(dialog).getByRole('button', { name: 'Add server' }));
    const run = await within(dialog).findByRole(
      'button',
      { name: 'Run this one line on it instead' },
      { timeout: 10_000 },
    );
    await user.click(run);
    expect(await within(dialog).findByRole('tab', { name: 'Run a command', selected: true })).toBeTruthy();
  }, 20_000);

  it('asks to trust a key that changed (connect-in-chat.md)', async () => {
    const user = userEvent.setup();
    const dialog = await openAdd('add=1&address=10.20.0.6');
    await user.type(within(dialog).getByLabelText('Password', { exact: true }), 'hunter22');
    await user.click(within(dialog).getByRole('button', { name: 'Add server' }));
    expect(
      await within(dialog).findByText(
        'Its key changed since last time. Trust the new one?',
        {},
        { timeout: 10_000 },
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Trust the new one' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'No' })).toBeTruthy();
  }, 20_000);

  it('makes the pre-approved command for the level chosen', async () => {
    const user = userEvent.setup();
    const dialog = await openAdd('add=1');
    await user.click(within(dialog).getByRole('tab', { name: 'Run a command' }));
    expect(await within(dialog).findByText(/--control full$/)).toBeTruthy();
    await user.click(within(dialog).getByRole('radio', { name: 'Watch only' }));
    expect(await within(dialog).findByText(/--control watch$/)).toBeTruthy();
  }, 15_000);
});
