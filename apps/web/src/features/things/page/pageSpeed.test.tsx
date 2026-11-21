/**
 * A connection's page opens fast (page-speed.md AP-2650…AP-2664) in the fixture world: while `things.page` is read its
 * head is the sidebar's row, the rest skeletons; and resting the pointer on the row reads the page, so opening it asks
 * nothing more.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AnyEndpoint } from '@whombat/core/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { AppServices } from '../../../app/services';
import { fixtureServices, renderApp } from '../../../test/renderApp';

const HA = 'connection:con_home-assistant';
const world = () => fixtureServices({ hosts: true, connectors: 'connected' });
const sidebarRow = async (name: RegExp) =>
  within(await screen.findByRole('complementary', { name: 'Sidebar' }, { timeout: 12_000 })).findByRole(
    'link',
    { name },
    { timeout: 12_000 },
  );

/** The `things.page` reads the app makes, held while `hold()` until `release()`. */
function pageReads(services: AppServices) {
  const request = services.client.request.bind(services.client);
  const things: string[] = [];
  let gate: Promise<void> = Promise.resolve();
  let open = () => {};
  vi.spyOn(services.client, 'request').mockImplementation(async (ep: AnyEndpoint, input?: unknown) => {
    if (ep.id === 'things.page') {
      things.push((input as { params: { thing: string } }).params.thing);
      await gate;
    }
    return request(ep, input as never);
  });
  return {
    things,
    hold: () => {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release: () => open(),
  };
}

describe('a connection’s page while it is read (AP-2650)', () => {
  it('draws the crumb, icon, name and badge from the sidebar’s row, the rest as skeletons', async () => {
    const app = renderApp('/connections', world());
    const reads = pageReads(app.services);
    const row = await sidebarRow(/^Home Assistant/);
    reads.hold();
    await userEvent.setup().click(row);
    const main = await screen.findByRole('main', { name: 'Home Assistant' }, { timeout: 12_000 });
    expect(within(main).getByRole('heading', { name: 'Home Assistant', level: 1 })).toBeTruthy();
    expect(within(main).getByText('Needs a look')).toBeTruthy();
    expect(within(main).getByRole('link', { name: 'Overview' }).getAttribute('href')).toBe('/connections');
    expect(within(main).queryByRole('button', { name: 'Ask Neo' })).toBeNull();
    expect(within(main).getByRole('status', { name: 'Loading' })).toBeTruthy();
    expect(within(main).queryAllByRole('tab')).toHaveLength(0);
    reads.release();
    expect((await within(main).findAllByRole('tab')).length).toBeGreaterThan(1);
    expect(within(main).queryByRole('status', { name: 'Loading' })).toBeNull();
    expect(within(main).getAllByRole('heading', { name: 'Home Assistant', level: 1 })).toHaveLength(1);
    // The head's Ask first; Worth a look's lines have their own.
    expect(within(main).getAllByRole('button', { name: 'Ask Neo' })[0]).toBeTruthy();
  });
});

describe('a connection’s page read on hover (AP-2660, AP-2663)', () => {
  it('reads the page while the pointer rests on its row; opening it reads nothing more', async () => {
    const app = renderApp('/connections', world());
    const reads = pageReads(app.services);
    const row = await sidebarRow(/^Home Assistant/);
    const user = userEvent.setup();
    await user.hover(row);
    await waitFor(() => expect(reads.things).toEqual([HA]));
    const cached = () =>
      app.services.queryClient.getQueriesData({ queryKey: ['whombat', 'things.page'] }).filter(([, d]) => d);
    await waitFor(() => expect(cached()).toHaveLength(1));
    await user.click(row);
    expect((await screen.findAllByRole('tab', {}, { timeout: 12_000 })).length).toBeGreaterThan(1);
    expect(reads.things).toEqual([HA]);
  });
});
