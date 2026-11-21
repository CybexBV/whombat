/**
 * “Asks you first” (Whombat server-asks.md SA-01…SA-08; app server-asks-web.md AP-1717…AP-1720) against the fixture
 * world: the row on a server's System tab confirms before Never (“Stop asking”), back to Before risky actions saves at
 * once; on the server this Whombat runs on it says it still asks before restarting it; an older Whombat shows nothing
 * new. A Servers approval card offers “Don’t ask again on pve-02” between Approve and
 * Details, sends `scope: 'agent'` and the server then reads Never.
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
import { HOST_ASKS_FIRST_WORDS as W } from '@whombat/core/domain';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { RESTART_APPROVAL } from '../../app/oneFixtures';
import { Providers } from '../../app/providers';
import type { AppServices } from '../../app/services';
import { renderApprovalCard } from '../../test/chatCards';
import { mockedServices, renderApp } from '../../test/renderApp';
import { ThingScreen } from './ThingScreen';

const B = `/burrows/${burrow.slug}`;
const STOP = /^Don’t ask again for pve-02/;
const LET = /^Let \S+ do it$/;

/** The fixture world with servers, recording every write. */
function world() {
  const inner = createWebFixtureFetch({ hosts: true });
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    const req = input instanceof Request ? input : new Request(url, init);
    const path = url.pathname.replace('/api/v1', '');
    if (req.method !== 'GET') {
      const text = await req.clone().text();
      calls.push({ method: req.method, path, body: text ? JSON.parse(text) : undefined });
    }
    return inner(req);
  });
  const read = async (path: string) =>
    (await inner(new Request(`http://whombat.test/api/v1${B}${path}`))).json();
  /** A server set to Before risky actions (servers act without asking by default). */
  const risky = (server: string) =>
    inner(
      new Request(`http://whombat.test/api/v1${B}/hosts/servers/${server}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ asksFirst: 'risky' }),
      }),
    );
  return { fetch, calls, read, risky };
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
}

const asksRow = () => screen.findByRole('radiogroup', { name: W.label });

describe('Asks you first on a server’s System tab (SA-08; AP-1717, AP-1718)', () => {
  it('asks before Never, saves it, and goes back without asking', async () => {
    const { fetch, calls, risky } = world();
    await risky('pve-02');
    const user = userEvent.setup();
    renderThing('/things/server%3Apve-02?tab=system', mockedServices(fetch));
    const group = await asksRow();
    expect(within(group).getByRole('radio', { name: W.choices.risky })).toHaveProperty('checked', true);
    expect(screen.getByText(W.hint.risky)).toBeTruthy();

    await user.click(within(group).getByText(W.choices.never));
    const dialog = await screen.findByRole('dialog', { name: W.confirmTitle('pve-02') });
    expect(within(dialog).getByText(W.confirmBody('pve-02'))).toBeTruthy();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: W.confirm }));

    expect(await screen.findByText(W.changed('pve-02', 'never'))).toBeTruthy();
    expect(calls.find((c) => c.method === 'PATCH')).toEqual({
      method: 'PATCH',
      path: `${B}/hosts/servers/pve-02`,
      body: { asksFirst: 'never' },
    });
    expect(await screen.findByText(W.hint.never)).toBeTruthy();
    await waitFor(() =>
      expect(within(group).getByRole('radio', { name: W.choices.never })).toHaveProperty('checked', true),
    );

    await user.click(within(group).getByText(W.choices.risky));
    expect(await screen.findByText(W.changed('pve-02', 'risky'))).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
      { asksFirst: 'never' },
      { asksFirst: 'risky' },
    ]);
  });

  it('keeps asking when Cancel is pressed', async () => {
    const { fetch, calls, risky } = world();
    await risky('pve-02');
    const user = userEvent.setup();
    renderThing('/things/server%3Apve-02?tab=system', mockedServices(fetch));
    await user.click(within(await asksRow()).getByText(W.choices.never));
    const dialog = await screen.findByRole('dialog', { name: W.confirmTitle('pve-02') });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(within(await asksRow()).getByRole('radio', { name: W.choices.risky })).toHaveProperty(
      'checked',
      true,
    );
  });

  it('says it still asks before restarting the server this Whombat runs on', async () => {
    const { fetch } = world();
    renderThing('/things/server%3Athetitan?tab=system', mockedServices(fetch));
    await asksRow();
    expect(screen.getByText(`${W.hint.never} ${W.selfNote('thetitan')}`)).toBeTruthy();
  });
});

describe('“Don’t ask again on {server}” on a Servers approval card (SA-07; AP-1720)', () => {
  // The restart on pve-02 in the default chat: its title is written from the call (“Use guest_power on servers”).
  const card = () => screen.findByRole('region', { name: 'Approval: Use guest_power on servers' });
  const assistant = (fetch: typeof globalThis.fetch) => mockedServices(fetch, {});

  it('sits apart under the answers, asks first, then approves with scope `agent` and says so', async () => {
    const { fetch, calls, read } = world();
    const user = userEvent.setup();
    renderApprovalCard(assistant(fetch), RESTART_APPROVAL);
    const c = await card();
    await waitFor(() => expect(within(c).getByRole('button', { name: STOP })).toBeTruthy());
    const answers = within(within(c).getByRole('group', { name: 'Approval answers' }))
      .getAllByRole('button')
      .map((b) => b.textContent ?? '');
    // The answers in their one order (no later time outside a chat with the assistant); the lasting yes in Details.
    expect(answers).toEqual(['Yes, do it', 'No']);
    expect(
      within(c.querySelector('details') as HTMLElement).getByRole('button', { name: STOP }),
    ).toBeTruthy();

    // Keep asking changes nothing.
    await user.click(within(c).getByRole('button', { name: STOP }));
    const ask = await screen.findByRole('dialog', { name: /pve-02 without asking\?$/ });
    await user.click(within(ask).getByRole('button', { name: 'Keep asking' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((x) => x.path.endsWith('/decide'))).toBe(false);

    await user.click(within(c).getByRole('button', { name: STOP }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: LET }));
    await waitFor(() => expect(calls.some((x) => x.path.endsWith('/decide'))).toBe(true));
    expect(calls.find((x) => x.path.endsWith('/decide'))?.body).toEqual({
      decision: 'approve',
      scope: 'agent',
    });
    expect(await screen.findByText('Approved. Whombat won’t ask again on pve-02.')).toBeTruthy();
    expect(((await read('/hosts/servers/pve-02/settings')) as { asksFirst: string }).asksFirst).toBe('never');
  });

  it('shows the same lasting yes in the approval’s details, and sends it from there once confirmed', async () => {
    const { fetch, calls } = world();
    const user = userEvent.setup();
    renderApp(`/chat?approval=${RESTART_APPROVAL}`, assistant(fetch));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: STOP }));
    await user.click(
      within(await screen.findByRole('dialog', { name: /without asking\?$/ })).getByRole('button', {
        name: LET,
      }),
    );
    await waitFor(() => expect(calls.some((x) => x.path.endsWith('/decide'))).toBe(true));
    expect(calls.find((x) => x.path.endsWith('/decide'))?.body).toEqual({
      decision: 'approve',
      scope: 'agent',
    });
    expect(await screen.findByText('Approved. Whombat won’t ask again on pve-02.')).toBeTruthy();
  });
});
