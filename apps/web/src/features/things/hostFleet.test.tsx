/**
 * The host and fleet pages of the Proxmox build (Whombat proxmox.md, stream WC) against the fixture world: a container
 * made from the Guests tab shows up, Stop… asks with the names, the fleet's Guests view filters by tag across servers,
 * a switch the server blocks shows the command that allows it, and the agent's Updates row.
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
import { Providers } from '../../app/providers';
import { fixtureServices } from '../../test/renderApp';
import { ThingScreen } from './ThingScreen';

function renderThing(url: string) {
  const services = fixtureServices({ hosts: true });
  const root = createRootRoute({ component: () => <Outlet /> });
  const thing = createRoute({
    getParentRoute: () => root,
    path: 'things/$thing',
    component: function Thing() {
      const { thing: id } = thing.useParams();
      return <ThingScreen burrow={burrow.slug} thing={id} />;
    },
  });
  const history = createMemoryHistory({ initialEntries: [url] });
  const router = createRouter({ routeTree: root.addChildren([thing]), history });
  render(
    <Providers services={services}>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('a server’s Guests tab', () => {
  it('lists machines by name with stopped ones last, no tags or state column, and sorts by a column (CN-08)', async () => {
    const user = userEvent.setup();
    renderThing('/things/server%3Apve-02?tab=guests');
    const guests = (await screen.findByRole('heading', { name: 'Machines' })).closest(
      'section',
    ) as HTMLElement;
    const table = await within(guests).findByRole('table');
    const heads = within(table)
      .getAllByRole('columnheader')
      .map((h) => (h.textContent ?? '').replace(/[↑↓]/g, '').trim())
      .filter(Boolean);
    expect(heads).toEqual(['Name', 'CPU', 'Memory', 'Up', 'Actions']);
    const guestHead = within(table).getByRole('columnheader', { name: /Name/ });
    expect(guestHead.getAttribute('aria-sort')).toBe('ascending');
    const rows = () => within(table).getAllByRole('row').slice(1);
    const nameOf = (r: HTMLElement) => within(r).getAllByRole('button')[0]?.textContent;
    const first = rows().map(nameOf);
    expect(first.slice(-4)).toEqual(['debian-template', 'minecraft', 'old-wp-staging', 'test-ct']);
    const running = first.slice(0, -4) as string[];
    expect(running).toEqual(
      [...running].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    );
    const last = rows().at(-1) as HTMLElement;
    expect(within(last).getByText('CT 145 · Stopped')).toBeTruthy();
    expect(within(last).getByRole('img', { name: 'Stopped' })).toBeTruthy();
    expect(within(last).getByRole('button', { name: 'Start test-ct' })).toBeTruthy();

    await user.click(within(table).getByRole('button', { name: 'CPU' }));
    expect(within(table).getByRole('columnheader', { name: /CPU/ }).getAttribute('aria-sort')).toBe(
      'descending',
    );
    expect(within(table).getByRole('columnheader', { name: /Name/ }).getAttribute('aria-sort')).toBe('none');
    expect(within(guests).getByText('CPU', { selector: 'b' })).toBeTruthy();
    const byCpu = rows().map(nameOf);
    expect(byCpu.slice(-4)).toEqual(['debian-template', 'minecraft', 'old-wp-staging', 'test-ct']);
    expect(byCpu[0]).not.toBe(first[0]);
  });

  it('makes a container from the full form', async () => {
    const user = userEvent.setup();
    renderThing('/things/server%3Apve-02?tab=guests');
    await user.click(await screen.findByRole('button', { name: 'Create a guest on pve-02' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Container…' }));
    const dialog = await screen.findByRole('dialog', { name: 'New container' });
    expect(within(dialog).getByLabelText('Made from')).toHaveProperty(
      'value',
      'local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst',
    );
    expect(within(dialog).getByLabelText('Cores')).toHaveProperty('value', '1');
    expect(within(dialog).getByLabelText('Swap (MiB)')).toHaveProperty('value', '512');
    await user.type(within(dialog).getByLabelText('Name'), 'dns-2');
    await user.click(within(dialog).getByRole('button', { name: 'Create container' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New container' })).toBeNull());
    expect(await screen.findByRole('button', { name: 'dns-2' })).toBeTruthy();
  });

  it('asks before stopping the selected guests, with their names', async () => {
    const user = userEvent.setup();
    renderThing('/things/server%3Apve-02?tab=guests');
    await user.click(await screen.findByRole('checkbox', { name: 'Select cli-proxy-api' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select AgentDVR' }));
    const bar = screen.getByRole('group', { name: 'Selected guests' });
    expect(within(bar).getByText('2 selected')).toBeTruthy();
    await user.click(within(bar).getByRole('button', { name: 'Stop…' }));
    const ask = await screen.findByRole('dialog', { name: 'Stop 2 guests?' });
    expect(within(ask).getByText('cli-proxy-api')).toBeTruthy();
    expect(within(ask).getByText('AgentDVR')).toBeTruthy();
  });
});

describe('the fleet’s guests', () => {
  it('filters by tag across servers', async () => {
    renderThing('/things/servers?view=guests&tag=lab');
    expect(await screen.findByText('lab-vm-1')).toBeTruthy();
    expect(screen.getByText('old-wp-staging')).toBeTruthy();
    expect(screen.queryByText('cli-proxy-api')).toBeNull();
    expect(screen.getByText(/^1–4 of 4 guests on 2 servers/)).toBeTruthy();
  });
});

describe('a server the agent blocks', () => {
  it('shows the command that allows the switch', async () => {
    renderThing('/things/server%3Apve-01?tab=system');
    expect(await screen.findByText('sudo whombat-agent allow host_shell')).toBeTruthy();
    expect(screen.getAllByText('Run this on pve-01, then come back.')).toHaveLength(2);
    // Its agent needs one more install: the Updates row says so, “Update the agent first” isn't repeated (AP-2984).
    expect(await screen.findByText(/one more install/)).toBeTruthy();
    expect(screen.queryByText(/is older than the commands below/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Show the install command' })).toBeTruthy();
  });
});

describe('the agent’s Updates row (agent-updates-app.md AP-2981)', () => {
  it('does the last install where Whombat may', async () => {
    const user = userEvent.setup();
    renderThing('/things/server%3Ablackbox?tab=system');
    await user.click(await screen.findByRole('button', { name: 'Update it' }));
    expect(await screen.findByText(/^Updating to the new version/)).toBeTruthy();
    expect(screen.getByText(/Installing Whombat’s helper on blackbox/)).toBeTruthy();
  });

  it('offers Try again after a failed update', async () => {
    renderThing('/things/server%3Athe-falcon?tab=system');
    expect(await screen.findByText(/^Couldn’t update/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
