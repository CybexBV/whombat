/**
 * Settings → the assistant → What it may do (settings-groups.md) against the fixture world with servers:
 * each server with Ask me first · Go ahead, asking before Go ahead and saving Ask me first at once; the keys
 * row by row with its folds; what it did, a link to Done. Facts (names, addresses, the request), not sentences.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { keptSitesText, PERMISSION_WORDS, permissionsText } from '@whombat/client';
import { HOST_ASKS_FIRST_WORDS as W } from '@whombat/core/domain';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../../app/fixtureFetch';
import { FIXTURE_KEPT_SITE } from '../../../app/keptSiteFixtures';
import { ASSISTANT_NAME } from '../../../app/oneFixtures';
import { mockedServices, renderApp } from '../../../test/renderApp';

const B = `/burrows/${burrow.slug}`;
const MAY = '/settings?tab=agent&part=may';
const T = permissionsText(ASSISTANT_NAME);
const K = keptSitesText(ASSISTANT_NAME);

/** The fixture world with servers, recording every write; `risky` sets a server to Ask me first. */
function world() {
  const inner = createWebFixtureFetch({ hosts: true });
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    const req = input instanceof Request ? input : new Request(url, init);
    if (req.method !== 'GET') {
      const text = await req.clone().text();
      calls.push({
        method: req.method,
        path: url.pathname.replace('/api/v1', ''),
        body: text ? JSON.parse(text) : undefined,
      });
    }
    return inner(req);
  });
  const risky = (server: string) =>
    inner(
      new Request(`http://whombat.test/api/v1${B}/hosts/servers/${server}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ asksFirst: 'risky' }),
      }),
    );
  return { fetch, calls, risky };
}

describe('Settings → the assistant → What it may do', () => {
  it('lists the servers with Ask me first · Go ahead, and asks before Go ahead', async () => {
    const { fetch, calls, risky } = world();
    await risky('pve-02');
    const user = userEvent.setup();
    renderApp(MAY, mockedServices(fetch));
    const servers = await screen.findByRole('region', { name: T.servers });
    const group = await within(servers).findByRole('radiogroup', { name: T.serverLabel('pve-02') });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent),
    ).toEqual([PERMISSION_WORDS.ask, PERMISSION_WORDS.go]);
    expect(within(group).getByRole('radio', { name: PERMISSION_WORDS.ask })).toHaveProperty('checked', true);
    // Every server that isn't only watched has the same choice.
    expect(within(servers).getAllByRole('radiogroup').length).toBeGreaterThan(1);

    await user.click(within(group).getByText(PERMISSION_WORDS.go));
    const dialog = await screen.findByRole('dialog', { name: W.confirmTitle('pve-02') });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: W.confirm }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')).toEqual({
        method: 'PATCH',
        path: `${B}/hosts/servers/pve-02`,
        body: { asksFirst: 'never' },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(within(group).getByRole('radio', { name: PERMISSION_WORDS.go })).toHaveProperty('checked', true),
    );

    // Back to Ask me first saves at once.
    await user.click(within(group).getByText(PERMISSION_WORDS.ask));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
        { asksFirst: 'never' },
        { asksFirst: 'risky' },
      ]),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps Ask me first when Go ahead is called off', async () => {
    const { fetch, calls, risky } = world();
    await risky('pve-02');
    const user = userEvent.setup();
    renderApp(MAY, mockedServices(fetch));
    const group = await screen.findByRole('radiogroup', { name: T.serverLabel('pve-02') });
    await user.click(within(group).getByText(PERMISSION_WORDS.go));
    const dialog = await screen.findByRole('dialog', { name: W.confirmTitle('pve-02') });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(within(group).getByRole('radio', { name: PERMISSION_WORDS.ask })).toHaveProperty('checked', true);
  });

  it('shows the keys row by row, with All keys and the commands always allowed folded until opened', async () => {
    const user = userEvent.setup();
    renderApp(MAY, mockedServices(world().fetch));
    const keys = await screen.findByRole('region', { name: T.keys });
    const merge = await within(keys).findByRole('radiogroup', { name: 'Merge into main' });
    expect(
      within(merge)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent),
    ).toEqual(Object.values(PERMISSION_WORDS));
    const all = within(keys).getByRole('button', { name: /^All keys/ });
    expect(all.getAttribute('aria-expanded')).toBe('false');
    const commands = within(keys).getByRole('button', { name: new RegExp(`^${T.commandsFold}`) });
    expect(commands.getAttribute('aria-expanded')).toBe('false');
    expect(within(keys).queryByRole('group', { name: 'All keys' })).toBeNull();
    await user.click(commands);
    expect(commands.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(commands.getAttribute('aria-controls') ?? '')).toBeTruthy();
    await user.click(all);
    expect(within(keys).getByRole('group', { name: 'All keys' })).toBeTruthy();
  });

  it('opens All keys at a key a link names (`&key=`)', async () => {
    renderApp(`${MAY}&key=settings.change`, mockedServices(world().fetch));
    const keys = await screen.findByRole('region', { name: T.keys });
    expect(await within(keys).findByRole('group', { name: 'All keys' })).toBeTruthy();
    expect(
      within(keys)
        .getByRole('button', { name: /^All keys/ })
        .getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('opens Everything it did on Done', async () => {
    const user = userEvent.setup();
    const app = renderApp(MAY, mockedServices(world().fetch));
    const did = await screen.findByRole('region', { name: T.did });
    const see = within(did).getByRole('link', { name: T.didButton });
    expect(see.getAttribute('href')).toBe('/done');
    await user.click(see);
    await waitFor(() => expect(app.location()).toBe('/done'));
  });

  it('is a part of the assistant’s group, by its name', async () => {
    renderApp(MAY, mockedServices(world().fetch));
    const parts = await screen.findByRole('group', { name: `Parts of ${ASSISTANT_NAME}` });
    expect(within(parts).getByRole('radio', { name: `What ${ASSISTANT_NAME} may do` })).toHaveProperty(
      'checked',
      true,
    );
    await waitFor(() => expect(document.querySelector('[data-agent-part="may"]')).toBeTruthy());
  });

  it('lists the websites kept signed in with until when, and Stop takes one away at once', async () => {
    const { fetch, calls } = world();
    const user = userEvent.setup();
    renderApp(MAY, mockedServices(fetch));
    const kept = await screen.findByRole('region', { name: K.title });
    expect(within(kept).getByText(FIXTURE_KEPT_SITE)).toBeTruthy();
    expect(within(kept).getByText(/^until /)).toBeTruthy();
    await user.click(within(kept).getByRole('button', { name: K.stopLabel(FIXTURE_KEPT_SITE) }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'DELETE')?.path).toMatch(new RegExp(`^${B}/kept-sites/kst_`)),
    );
    // With none left, the list isn't there.
    await waitFor(() => expect(screen.queryByRole('region', { name: K.title })).toBeNull());
  });
});
