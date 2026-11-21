/**
 * A Mac's Screen tab (Whombat macos-servers.md; MAC-31…MAC-33) against the fixture world's studio: the screen opens from
 * the tab, the Mac's password is sent once to the Mac and the form doesn't keep it, a password the Mac refuses is said in
 * the form, and “Open the setting on the Mac” asks the Mac to open Accessibility.
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
import type { AppServices } from '../../../app/services';
import { mockedServices } from '../../../test/renderApp';
import { ThingScreen } from '../ThingScreen';

/** The fixture world with servers and studio before its password was set, recording every write. */
function world() {
  const inner = createWebFixtureFetch({ hosts: true });
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    const req = input instanceof Request ? input : new Request(url, init);
    if (req.method !== 'GET') {
      const text = await req.clone().text();
      calls.push({ method: req.method, path: url.pathname, body: text ? JSON.parse(text) : {} });
    }
    return inner(req);
  });
  return { fetch, calls };
}

function renderThing(url: string, services: AppServices) {
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
  return router;
}

const screenSteps = (calls: ReturnType<typeof world>['calls']) =>
  calls.filter((c) => c.path.endsWith('/hosts/servers/studio/screen')).map((c) => c.body);

describe('a Mac’s Screen tab', () => {
  beforeEach(() => localStorage.setItem('whombat.fixtures.mac', 'setup'));
  afterEach(() => localStorage.removeItem('whombat.fixtures.mac'));

  it('sets the Mac’s password once, says a refusal in the form, and opens the screen', async () => {
    const { fetch, calls } = world();
    const user = userEvent.setup();
    const router = renderThing('/things/server%3Astudio?tab=screen', mockedServices(fetch));
    const open = await screen.findByRole('button', { name: 'Open the screen' });
    expect(open).toHaveProperty('disabled', true);
    expect(screen.getByText('Set the Mac’s password first.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Set the Mac’s password' }));
    const dialog = await screen.findByRole('dialog');
    const password = within(dialog).getByLabelText('Password');
    await user.type(password, 'wrong');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('mara'),
    );
    // Sent once, and not kept in the form.
    expect((password as HTMLInputElement).value).toBe('');

    await user.type(password, 'the-right-one');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const sets = screenSteps(calls).filter((b) => b.op === 'account.set');
    expect(sets.map((b) => (b.account as { user: string }).user)).toEqual(['mara', 'mara']);

    const ready = await screen.findByRole('button', { name: 'Open the screen' });
    await waitFor(() => expect(ready).toHaveProperty('disabled', false));
    await user.click(ready);
    await waitFor(() => expect(router.state.location.search).toMatchObject({ console: 'screen' }));
  });

  it('asks the Mac to open Accessibility for Whombat Helper', async () => {
    const { fetch, calls } = world();
    const user = userEvent.setup();
    renderThing('/things/server%3Astudio?tab=screen', mockedServices(fetch));
    await user.click(await screen.findByRole('button', { name: 'Open the setting on the Mac' }));
    await waitFor(() =>
      expect(screenSteps(calls)).toContainEqual({ op: 'ui.open', target: 'accessibility' }),
    );
  });
});
