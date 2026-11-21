import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DISCOVERY_POLL_MS } from '@whombat/client/connections';
import { catalogEntry } from '@whombat/core/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureServices, renderApp } from '../../test/renderApp';

/** Add a connection, where the full section is (connections-redesign.md AP-1162), on the Connections page. */
const ADD = '/connections?connection=add';

/**
 * The fixture scan (catalogFixtures.ts) runs for three polls, then finds Proxmox VE, Home Assistant (the burrow's own
 * connection), Portainer, Grafana, Synology DSM and QNAP.
 */
async function scanned() {
  const found = await screen.findByRole('region', { name: 'ON YOUR NETWORK' });
  await vi.advanceTimersByTimeAsync(DISCOVERY_POLL_MS * 4);
  await within(found).findByText(/^Looked in /);
  return found;
}

function listed(found: HTMLElement): string[] {
  const list = within(found).queryByRole('list', { name: 'Found on your network' });
  return list
    ? within(list)
        .getAllByRole('listitem')
        .map((li) => li.dataset.found ?? '')
    : [];
}

describe('found on your network: connected ones left out, hide one (Whombat CS-52, CS-53; AP-872…AP-874)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists what isn’t connected, hides one for the burrow and shows it again', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp(ADD, fixtureServices({ connectors: 'connected' }));
    const found = await scanned();
    expect(listed(found)).toEqual(['proxmox', 'portainer', 'grafana', 'synology', 'qnap', 'server']);
    expect(within(found).queryByText('Connected')).toBeNull();
    // A computer and Proxmox VE are added as servers, filled in (Whombat connect-in-chat.md); the rest connect.
    expect(
      within(found)
        .getByRole('link', { name: 'Add Debian server at 192.168.1.70 as a server' })
        .getAttribute('href'),
    ).toContain('/connections?add=1&address=192.168.1.70');
    expect(
      within(found).getByRole('link', { name: 'Add Proxmox VE at 192.168.1.10 as a server' }),
    ).toBeTruthy();
    expect(within(found).queryByRole('button', { name: /hidden$/ })).toBeNull();
    // What each one is, the catalog's line (DF-08, AP-3802).
    const nas = within(found)
      .getAllByRole('listitem')
      .find((li) => li.dataset.found === 'synology');
    expect(nas?.textContent).toContain(catalogEntry('synology')?.tagline ?? 'no tagline');

    await user.click(
      within(found).getByRole('button', { name: 'Hide Portainer at https://192.168.1.30:9443' }),
    );
    const toggle = await within(found).findByRole('button', { name: 'Show 1 hidden' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(listed(found)).toEqual(['proxmox', 'grafana', 'synology', 'qnap', 'server']);
    // The button that vanished hands its focus to the toggle.
    expect(document.activeElement).toBe(toggle);

    await user.click(toggle);
    expect(toggle.textContent).toBe('Hide 1 hidden');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(listed(found)).toEqual(['proxmox', 'grafana', 'synology', 'qnap', 'server', 'portainer']);
    const unhide = within(found).getByRole('button', {
      name: 'Unhide Portainer at https://192.168.1.30:9443',
    });
    expect(
      within(found).queryByRole('link', { name: 'Connect Portainer at https://192.168.1.30:9443' }),
    ).toBeNull();

    await user.click(unhide);
    await waitFor(() => expect(within(found).queryByRole('button', { name: /hidden$/ })).toBeNull());
    expect(listed(found)).toEqual(['proxmox', 'portainer', 'grafana', 'synology', 'qnap', 'server']);
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Hide Portainer at https://192.168.1.30:9443',
    );
  });

  it('says so when everything it found is connected or hidden, and keeps the toggle', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp(ADD, fixtureServices({ connectors: 'connected' }));
    const found = await scanned();
    for (const [name, url] of [
      ['Proxmox VE', 'https://192.168.1.10:8006'],
      ['Portainer', 'https://192.168.1.30:9443'],
      ['Grafana', 'http://192.168.1.40:3000'],
      ['Synology DSM', 'https://192.168.1.50:5001'],
      ['QNAP', 'https://192.168.1.60'],
      ['Debian server', 'ssh://192.168.1.70'],
    ])
      await user.click(await within(found).findByRole('button', { name: `Hide ${name} at ${url}` }));
    expect(
      await within(found).findByText('Everything Whombat found on your network is connected or hidden.'),
    ).toBeTruthy();
    expect(listed(found)).toEqual([]);
    await user.click(within(found).getByRole('button', { name: 'Show 6 hidden' }));
    expect(listed(found)).toEqual(['proxmox', 'portainer', 'grafana', 'synology', 'qnap', 'server']);
  });
});

describe('found on your network on the overview and Add a connection (AP-1161, AP-1162)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('names what is new in a strip of chips; a chip opens its connect page, See all opens Add a connection', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // The overview: Settings → Connections.
    const app = renderApp('/settings?tab=connections', fixtureServices({ connectors: 'connected' }));
    await screen.findByRole('region', { name: 'APPS AND SERVICES' });
    // Nothing while it looks the first time.
    expect(screen.queryByRole('region', { name: 'On your network' })).toBeNull();
    await vi.advanceTimersByTimeAsync(DISCOVERY_POLL_MS * 4);
    const strip = await screen.findByRole('region', { name: 'On your network' });
    // Four chips, then how many more (AP-1161).
    expect(
      within(strip)
        .getAllByRole('listitem')
        .map((li) => li.dataset.found ?? li.textContent),
    ).toEqual(['proxmox', 'portainer', 'grafana', 'synology', '+2 more']);
    // No Hide, no scanning controls: those are on Add a connection.
    expect(within(strip).queryByRole('button')).toBeNull();

    await user.click(
      within(strip).getByRole('link', { name: 'Connect Portainer at https://192.168.1.30:9443' }),
    );
    await waitFor(() =>
      expect(app.location()).toBe('/connections?connection=portainer&url=https%3A%2F%2F192.168.1.30%3A9443'),
    );
    // A new connection's page goes back to Add a connection (AP-1165).
    await user.click(await screen.findByRole('link', { name: '← Add a connection' }));
    await waitFor(() => expect(app.location()).toBe(ADD));
    const found = await scanned();
    expect(listed(found)).toEqual(['proxmox', 'portainer', 'grafana', 'synology', 'qnap', 'server']);
    expect(screen.getByRole('button', { name: 'On your network 6' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('opens Add a connection at On your network from the assistant’s link (DF-05, AP-3801)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // The assistant's link is the old address: it lands on the Connections page.
    const app = renderApp('/settings?tab=connections&found=1', fixtureServices({ connectors: 'connected' }));
    const found = await scanned();
    expect(app.location()).toBe('/connections?connection=add&found=1');
    expect(listed(found)).toEqual(['proxmox', 'portainer', 'grafana', 'synology', 'qnap', 'server']);
    const chip = screen.getByRole('button', { name: 'On your network 6' });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    // Only the section: the catalog's tiles wait behind All, and the search box doesn't take the focus.
    expect(screen.queryByRole('link', { name: 'Connect Notion' })).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByRole('searchbox', { name: 'Search connections' }));
    expect(screen.getByRole('link', { name: '← Overview' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByRole('link', { name: 'Connect Notion' })).toBeTruthy();
  });

  it('narrows the section with the search box, and steps aside when nothing found matches', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp(ADD, fixtureServices({ connectors: 'connected' }));
    const found = await scanned();
    const search = screen.getByRole('searchbox', { name: 'Search connections' });
    await user.type(search, 'graf');
    expect(listed(found)).toEqual(['grafana']);
    await user.clear(search);
    await user.type(search, 'notion');
    expect(screen.queryByRole('region', { name: 'ON YOUR NETWORK' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Connect Notion' })).toBeTruthy();
  });
});
