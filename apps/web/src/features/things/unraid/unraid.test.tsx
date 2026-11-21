/**
 * An Unraid server in the web app (stream WU, AP-1587…; dashboards-web.md AP-2050…): BlackBox's own tabs, its updates
 * and Unraid's notifications on System (the Summary is every server's dashboard), archiving one of them, stopping the
 * array only after the question, and a container's autostart — against the fixture world.
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
import { Providers } from '../../../app/providers';
import { fixtureServices } from '../../../test/renderApp';
import { ThingScreen } from '../ThingScreen';

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

describe('an Unraid server', () => {
  it('has its own tabs, and its updates and Unraid’s notifications on System', async () => {
    const user = userEvent.setup();
    renderThing('/things/server%3Ablackbox?tab=system');
    expect(await screen.findByRole('heading', { level: 1, name: 'blackbox' })).toBeTruthy();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\s*\d+$/, ''));
    expect(tabs).toEqual(['Summary', 'Array', 'Shares', 'Apps', 'Plugins', 'Sensors', 'System']);
    expect(screen.getByRole('tab', { name: 'System', selected: true })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Update in Unraid/ }).getAttribute('href')).toBe(
      'http://10.100.1.30/Tools/Update',
    );
    const notes = (await screen.findByRole('heading', { name: 'From Unraid' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(notes).getByText('Parity disk in error state (disk dsbl)')).toBeTruthy();
    await user.click(within(notes).getByRole('button', { name: 'Archive “Docker update”' }));
    expect(await screen.findByText('Archived the notification.')).toBeTruthy();
    await waitFor(() => expect(within(notes).queryByText('Docker update')).toBeNull());
  });

  it('asks before stopping the array', async () => {
    const user = userEvent.setup();
    renderThing('/things/server%3Ablackbox?tab=array');
    await user.click(await screen.findByRole('button', { name: 'Stop the array…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop the array on blackbox?' });
    expect(
      within(dialog).getByText(/12 running containers, 1 running VM and the shares stop too/),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Stop the array' }));
    expect(await screen.findByText('Stopping the array on blackbox.')).toBeTruthy();
  });

  it('switches a container’s autostart from the Guests tab', async () => {
    const user = userEvent.setup();
    renderThing('/things/server%3Ablackbox?tab=guests');
    const sw = await screen.findByRole('switch', { name: 'Start immich_redis with blackbox' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    await user.click(sw);
    expect(await screen.findByText('immich_redis starts with blackbox now.')).toBeTruthy();
  });
});
