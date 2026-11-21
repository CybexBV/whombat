/**
 * Quiet notices on the web (Whombat quiet-notices.md QN-02, QN-10…QN-15, QN-23; app quiet-notices.md AP-4822…AP-4831)
 * against the fixture world: UniFi's ⋯ menu, Ignore greying the line with Undo, Stop watching and What Whombat watches
 * on its Settings tab, links by kind, a server's lines, and a Whombat without `things.quiet` (no menu).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../../test/renderApp';

const UNIFI = '/things/connection%3Acon_unifi';
const world = () => fixtureServices({ hosts: true, connectors: 'connected' });
const card = async (title: string) =>
  (await screen.findByRole('heading', { name: title, level: 2 }, { timeout: 12_000 })).closest(
    'section',
  ) as HTMLElement;
const strip = async () => screen.findByRole('region', { name: 'Worth a look' }, { timeout: 12_000 });
const line = (worth: HTMLElement, title: string) =>
  within(worth).getByText(title, { exact: false, selector: 'b' }).closest('[data-notice]') as HTMLElement;

describe('a line’s ⋯ menu (AP-4822…AP-4825)', () => {
  it('ignores a line until it changes: greyed at the bottom with who and Undo, the toast with Undo', async () => {
    const user = userEvent.setup();
    renderApp(UNIFI, world());
    // UniFi's page is in slots: Worth a look is the strip on top.
    const worth = await strip();
    // A heads-up never asks; the heads-ups are folded behind their own row.
    await user.click(within(worth).getByRole('button', { name: /^Show \d+ heads-ups?$/ }));
    const firmware = line(worth, '3 devices have updates');
    expect(within(firmware).queryByRole('button', { name: /^Ask Neo/ })).toBeNull();
    const ap = line(worth, 'AP Paardenstal is offline');
    expect(within(ap).getByRole('button', { name: /^Ask Neo/ })).toBeTruthy();
    await user.click(within(ap).getByRole('button', { name: 'More for AP Paardenstal is offline' }));
    const menu = await screen.findByRole('menu', { name: 'More for AP Paardenstal is offline' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual([
      'IgnoreUntil it’s back online.',
      'Remind me tomorrow',
      expect.stringContaining('Stop watching AP Paardenstal'),
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: /^Ignore/ }));
    expect(await screen.findByText('Ignored. You’ll hear if it changes.')).toBeTruthy();
    await waitFor(() => expect(line(worth, 'AP Paardenstal is offline').dataset.quiet).toBe('ignored'));
    const quiet = line(worth, 'AP Paardenstal is offline');
    expect(within(quiet).getByText('Ignored by Mara until it’s back online')).toBeTruthy();
    expect(within(quiet).queryByRole('button', { name: /^Ask Neo/ })).toBeNull();
    // Greyed at the bottom; the count is the lines that ask.
    const rows = [...worth.querySelectorAll('[data-notice]')].map((r) => r.getAttribute('data-notice'));
    expect(rows.at(-1)).toBe('offline-ap-paardenstal');
    await user.click(within(quiet).getByRole('button', { name: 'Undo: AP Paardenstal is offline' }));
    await waitFor(() => expect(line(worth, 'AP Paardenstal is offline').dataset.quiet).toBeUndefined());
  });

  it('stops watching an item: the line goes, Settings lists it with Undo', async () => {
    const user = userEvent.setup();
    renderApp(UNIFI, world());
    const worth = await strip();
    await user.click(within(line(worth, 'AP Paardenstal')).getByRole('button', { name: /^More for/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Stop watching AP Paardenstal/ }));
    expect(await screen.findByText('Whombat stopped watching AP Paardenstal.')).toBeTruthy();
    await waitFor(() => expect(within(worth).queryByText('AP Paardenstal is offline')).toBeNull());
    await user.click(screen.getByRole('tab', { name: 'Connection' }));
    const watching = await card('What Whombat watches');
    const row = within(watching)
      .getByText('Access points and switches going offline')
      .closest('[data-check]');
    expect(row?.textContent).toContain('AP Paardenstal');
    expect(row?.textContent).toContain('always');
    // Every check has its switch; switching one off says who and when.
    const firmware = within(watching).getByRole('switch', { name: 'Firmware updates' });
    expect(firmware.getAttribute('aria-checked')).toBe('true');
    await user.click(firmware);
    await waitFor(() => expect(within(watching).getByText(/^Off since .* \(Mara\)$/)).toBeTruthy());
    await user.click(within(row as HTMLElement).getByRole('button', { name: /^Undo: AP Paardenstal/ }));
    expect(await screen.findByText(/Whombat watches AP Paardenstal/)).toBeTruthy();
  });
});

describe('a server’s lines (AP-4828)', () => {
  it('ignores a hint on a server’s Summary', async () => {
    const user = userEvent.setup();
    renderApp('/things/server%3Apve-02', world());
    const worth = await card('Worth a look');
    // Getting warm is a heads-up: folded until opened.
    await user.click(await within(worth).findByRole('button', { name: /heads?-ups?/ }));
    const warm = await within(worth).findByRole('button', { name: /^More for CPU package/ });
    await user.click(warm);
    await user.click(await screen.findByRole('menuitem', { name: /^Ignore/ }));
    expect(await screen.findByText('Ignored. You’ll hear if it changes.')).toBeTruthy();
    await waitFor(() =>
      expect(worth.querySelector('[data-quiet="ignored"]')?.textContent).toContain('Ignored by Mara'),
    );
  });
});
