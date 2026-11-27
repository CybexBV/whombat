/**
 * A connection's or device's own page (Whombat connection-pages.md CP-01…CP-18, dashboards.md DS-01…DS-17;
 * connection-pages-web.md AP-1900…, dashboards-web.md AP-2050…) against the fixture world (`thingPageFixtures.ts`):
 * Home Assistant as the dashboards mock ha.png draws it, its notices folding after five and their ways out, the range
 * picker, its tabs, Restart asked first, what it runs on, the generic page, a device being learned, the parts of a
 * server.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../../test/renderApp';

const HA = '/things/connection%3Acon_home-assistant';
const world = () => fixtureServices({ hosts: true, connectors: 'connected' });
const text = (el: Element | null) => (el?.textContent ?? '').replaceAll(' ', ' ');
const card = async (title: string) =>
  (await screen.findByRole('heading', { name: title, level: 2 })).closest('section') as HTMLElement;

/** The page's own tabs, not the sidebar's Servers and Connections. */
const pageTabs = () => screen.getAllByRole('tab').filter((t) => !t.closest('aside'));

describe('Home Assistant’s page (ha.png)', () => {
  it('shows how it runs: head, fact line, tabs, figures that open their charts, what is worth a look and its backups', async () => {
    const user = userEvent.setup();
    renderApp(HA, world());
    // The first page of the file loads the things screens: a while on a busy run.
    expect(
      await screen.findByRole('heading', { name: 'Home Assistant', level: 1 }, { timeout: 12_000 }),
    ).toBeTruthy();
    // The head is drawn from what Home already knows; the page's own parts come with its answer.
    expect((await screen.findAllByRole('button', { name: 'Ask Neo' }))[0]).toBeTruthy();
    expect(screen.getByText('Needs a look')).toBeTruthy();
    // Ask, Open Home Assistant, then ⋯ with Restart: the head every page has.
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'More for Home Assistant' }));
    expect(screen.getByRole('menuitem', { name: 'Restart' })).toBeTruthy();
    await user.keyboard('{Escape}');
    const open = screen.getByRole('link', { name: 'Open Home Assistant' });
    expect([open.getAttribute('href'), open.getAttribute('target')]).toEqual([
      'http://10.100.0.5:8123/',
      '_blank',
    ]);
    // The address is in ⋯, not in the head.
    expect(screen.queryByText('10.100.0.5:8123')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'More for Home Assistant' }));
    expect(screen.getByRole('menuitem', { name: /^Copy address 10\.100\.0\.5:8123/ })).toBeTruthy();
    await user.keyboard('{Escape}');
    // “Runs in homeassistant on pve-02”: the guest's page and the server's.
    expect(screen.getByRole('link', { name: 'homeassistant' }).getAttribute('href')).toContain(
      '/things/server%3Apve-02?guest=pve%3A131',
    );
    expect(screen.getByRole('link', { name: 'pve-02' }).getAttribute('href')).toMatch(
      /\/things\/server%3Apve-02$/,
    );
    expect(screen.getAllByText('2026.10.2').length).toBeGreaterThan(0);
    expect(
      pageTabs().map((t) => [t.textContent?.replace(/\s+/g, ' ').trim(), t.getAttribute('aria-selected')]),
    ).toEqual([
      ['Summary', 'true'],
      ['Integrations 102', 'false'],
      ['Log', 'false'],
      ['Backups', 'false'],
      ['Activity', 'false'],
      ['Connection', 'false'],
    ]);
    // In slots (Whombat service-slots.md): no row of figures, what it has with what changed, the week, who's home
    // and the machine as cards, no range picker.
    expect(screen.queryByRole('region', { name: 'At a glance' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Range' })).toBeNull();
    const has = await card('In Home Assistant');
    expect(text(has)).toContain('Integrations');
    expect(text(has)).toContain('2 not loading');
    expect(text(has)).toContain('+3 this week');
    expect(text(await card('This week'))).toContain('automation runs');
    expect(text(await card('Who’s home'))).toContain('2 of 4 home');
    const machine = await card('The machine');
    expect(text(machine)).toContain('Home Assistant');
    expect(text(machine)).toContain('MariaDB 10.11');
    // Worth a look is the strip on top: what is wrong now first, the worst first, with its buttons; the heads-ups folded
    // behind their own row and not counted (overview-server-connection-final.md).
    const worth = screen.getByRole('region', { name: 'Worth a look' });
    const lines = [...worth.querySelectorAll('[data-notice]')].map((l) => l.getAttribute('data-notice'));
    expect(lines).toEqual(['integrations', 'log', 'repairs']);
    expect(text(worth)).not.toContain('The database grows 110 MB a day');
    await user.click(within(worth).getByRole('button', { name: /^Show \d+ heads-ups?$/ }));
    expect(text(worth)).toContain('The database grows 110 MB a day');
    expect(within(worth).getByRole('button', { name: 'Hide heads-ups' })).toBeTruthy();
    const loading = await card('Integrations not loading');
    expect(within(loading).getAllByRole('img', { name: 'Needs a look' })).toHaveLength(2);
    const backups = await card('Backups');
    expect(text(backups)).toContain('Proxmox backs up CT 131 every daybackup-homeassistant-daytime');
    expect(text(backups)).toContain('next in 21 h');
    // The changes here, whose a person's own is (HR-05, AP-2213), the place's own widget and the chips (CP-14).
    const changes = await card('Changes here');
    expect(within(changes).getByText('Updated the Shelly integration')).toBeTruthy();
    const mine = within(changes).getByText('Changed the name and notes of Home Assistant').closest('li');
    expect(within(mine as HTMLElement).getByText('You')).toBeTruthy();
    expect(await card('Database size')).toBeTruthy();
    expect(
      within(await card('Show more here')).getByRole('button', { name: 'Errors per hour' }),
    ).toBeTruthy();
  });

  it('opens the Ask pane with a notice’s question ready to send, and its tab from “Show”', async () => {
    const user = userEvent.setup();
    const app = renderApp(HA, world());
    const worth = await screen.findByRole('region', { name: 'Worth a look' }, { timeout: 12_000 });
    const integrations = worth.querySelector<HTMLElement>('[data-notice="integrations"]') as HTMLElement;
    await user.click(within(integrations).getByRole('button', { name: 'Ask Neo' }));
    const pane = await screen.findByRole('complementary', { name: 'Ask about Home Assistant' });
    const box = within(pane).getByRole('textbox', {
      name: 'Ask about Home Assistant',
    }) as HTMLTextAreaElement;
    expect(box.value).toBe('Why are two integrations not loading in Home Assistant?');
    expect(within(pane).getByText('Neo sees what this connection reads and what it may change')).toBeTruthy();
    await user.click(within(pane).getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Ask about Home Assistant' })).toBeNull(),
    );

    await user.click(within(worth).getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(app.location()).toContain('tab=logs'));
    expect(await card('Errors since the restart')).toBeTruthy();
    expect(screen.getByText('Modbus: no answer from the EV charger')).toBeTruthy();
    // The range picker is the Summary's only.
    expect(screen.queryByRole('group', { name: 'Range' })).toBeNull();
  });

  it('asks before Restart, says so after, and shows the restart in Activity', async () => {
    const user = userEvent.setup();
    renderApp(HA, world());
    await user.click(await screen.findByRole('button', { name: 'More for Home Assistant' }));
    await user.click(screen.getByRole('menuitem', { name: 'Restart' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Restart Home Assistant?')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Restart' }));
    expect(await screen.findByText('Restarting Home Assistant. It’s back in about a minute.')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    const activity = await card('Changes here');
    const restarted = (await within(activity).findByText('Restarted Home Assistant')).closest('li');
    expect(within(restarted as HTMLElement).getByText('You')).toBeTruthy();
    expect(within(activity).getByText('Turned off the hallway lights')).toBeTruthy();
  });

  it('lets a manager choose what it runs on, or say it isn’t on a server Whombat watches', async () => {
    const user = userEvent.setup();
    renderApp(HA, world());
    const changeRunsOn = async () => {
      await user.click(await screen.findByRole('button', { name: 'More for Home Assistant' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Change what it runs on' }));
    };
    await changeRunsOn();
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog)
        .getByRole('button', { name: /Let Whombat find it/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    await user.type(within(dialog).getByRole('searchbox', { name: 'Find a server or guest' }), 'unifi');
    const guest = await within(dialog).findByRole('button', { name: /^unifi/ });
    await user.click(guest);
    expect(await screen.findByText('Home Assistant runs on unifi (pve-02).')).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'CT 136' })).toBeTruthy();

    await changeRunsOn();
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Not on a server Whombat watches',
      }),
    );
    expect(await screen.findByText('Home Assistant isn’t on a server Whombat watches.')).toBeTruthy();
    const main = screen.getByRole('main', { name: 'Home Assistant' });
    await waitFor(() => expect(within(main).queryByRole('link', { name: /pve-02|CT 13/ })).toBeNull());
    await user.click(screen.getByRole('button', { name: 'More for Home Assistant' }));
    expect(screen.getByRole('menuitem', { name: 'What does it run on?' })).toBeTruthy();
  });

  it('has its Settings page as its Settings tab, without the head but with Rename', async () => {
    renderApp(`${HA}?tab=settings`, world());
    const name = await screen.findByRole('region', { name: 'NAME' });
    expect(within(name).getByRole('button', { name: 'Rename' })).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'CONNECTION' })).toBeTruthy();
    expect(await screen.findByRole('list', { name: 'Tools' })).toBeTruthy();
  });
});

describe('every connection and device has a page (CP-06, CP-10, CP-13)', () => {
  it('gives a connection without its own figures the generic page, in slots', async () => {
    const user = userEvent.setup();
    renderApp('/things/connection%3Acon_fixture_tracker', world());
    expect(await screen.findByRole('heading', { name: 'Acme Desk dev', level: 1 })).toBeTruthy();
    expect(text(await card('With Whombat'))).toContain('182 ms');
    expect(await card('Answer time')).toBeTruthy();
    // No row of figures, and no Worth a look while nothing needs one.
    expect(screen.queryByRole('region', { name: 'At a glance' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Worth a look' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'More for Acme Desk dev' }));
    expect(screen.getByRole('menuitem', { name: 'What does it run on?' })).toBeTruthy();
  });

  it('shows a device being learned with the way to its chat, and no Settings tab', async () => {
    renderApp('/things/device%3Acon_heat-pump', world());
    expect(await screen.findByRole('heading', { name: 'Heat pump', level: 1 })).toBeTruthy();
    expect(screen.getByText('Learning')).toBeTruthy();
    expect((await screen.findByRole('link', { name: 'Choose' })).getAttribute('href')).toContain(
      '/chats/cnv_chat-heat-pump',
    );
    expect(pageTabs().map((t) => t.textContent)).toEqual(['Summary', 'Activity']);
  });

  it('shows a switched-on device’s readings and its actions’ tiers in Settings', async () => {
    const user = userEvent.setup();
    renderApp('/things/device%3Acon_pool', world());
    expect(await screen.findByRole('heading', { name: 'Pool', level: 1 })).toBeTruthy();
    expect(await card('All readings')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Connection' }));
    const tools = await screen.findByRole('list', { name: 'Tools' });
    expect(within(tools).getByText('pool_dose_acid')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'CONNECTION' })).toBeNull();
  });

  it('leaves the parts of a server out of the sidebar and lists them on the server’s page', async () => {
    const user = userEvent.setup();
    renderApp('/things/server%3Apve-02', world());
    // They are with the server's Technical details, at the foot of its Summary.
    await user.click(await screen.findByRole('button', { name: 'Technical details' }));
    const also = await screen.findByRole('link', { name: 'Proxmox VE API' });
    expect(also.getAttribute('href')).toContain('/things/connection%3Acon_pve-02-api');
    // The sidebar lists no things, only the places.
    const side = screen.getByRole('complementary', { name: 'Sidebar' });
    expect(within(side).queryByText('Proxmox VE API')).toBeNull();
    expect(within(side).queryByRole('link', { name: /^Home Assistant/ })).toBeNull();
  });

  it('opens a connection’s Settings address on its page’s Settings tab', async () => {
    const app = renderApp('/settings?tab=connections&connection=homeassistant&id=con_fixture_ha', world());
    await waitFor(() => expect(app.location()).toBe('/things/connection%3Acon_fixture_ha?tab=settings'));
    expect(await screen.findByRole('region', { name: 'CONNECTION' })).toBeTruthy();
  });
});

describe('the range (DS-03, DS-17)', () => {
  it('offers the range when a chart on the page follows it, and keeps it in the address', async () => {
    const user = userEvent.setup();
    // UniFi's Internet below the slots follows the range.
    const app = renderApp('/things/connection%3Acon_unifi', world());
    const range = await screen.findByRole('group', { name: 'Range' }, { timeout: 12_000 });
    expect((within(range).getByRole('radio', { name: '24h' }) as HTMLInputElement).checked).toBe(true);
    await user.click(within(range).getByRole('radio', { name: '7d' }));
    await waitFor(() => expect(app.location()).toContain('range=7d'));
  });
});

describe('a connection’s page in slots (docs/decisions/service-slots.md)', () => {
  it('shows UniFi’s network now and what is on it, the internet below them, and no row of figures', async () => {
    renderApp('/things/connection%3Acon_unifi', world());
    expect(
      await screen.findByRole('heading', { level: 2, name: 'The network now' }, { timeout: 12_000 }),
    ).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'At a glance' })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'On the network' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Internet' })).toBeTruthy();
    // Narrow: the crumb goes back to the Connections list.
    expect(
      within(screen.getByRole('main', { name: 'UniFi' }))
        .getByRole('link', { name: 'Connections' })
        .getAttribute('href'),
    ).toBe('/connected');
  });
});
