/**
 * *Add a widget* in the editor (Whombat desk-display.md DK-153…DK-156): its sections fold — Whombat's own and *Servers*
 * folded at first, the connections open, each server folded inside *Servers* — and a search opens what matches. The
 * canvas isn't drawn without a layout engine, so choosing a widget (its *Shows*) is checked in the browser.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeDesk, fakeDeskApi } from '@whombat/client/desk/fake';
import { DESK_QUERY_KEY } from '@whombat/client/desk/react';
import { mara } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { deskSeed } from '../../../app/deskFixtures';
import type { AppServices } from '../../../app/services';
import { fixtureServices, renderApp } from '../../../test/renderApp';
import { accountIcon, peekPlace } from './WidgetPanel';

function open() {
  const desk = createFakeDesk(deskSeed('screens', Date.now()));
  const base = fixtureServices({ host: true });
  const services: AppServices = { ...base, desk: fakeDeskApi(desk, { personId: mara.id, name: mara.name }) };
  desk.onChange(() => void base.queryClient.invalidateQueries({ queryKey: DESK_QUERY_KEY }));
  renderApp('/settings/screens/box/layout', services);
}

const panel = () => screen.findByRole('complementary', { name: 'Add a widget' }, { timeout: 8000 });

describe('Add a widget (DK-155)', () => {
  it('starts with Whombat’s own and the servers folded and the connections open', async () => {
    open();
    const add = await panel();
    const own = await within(add).findByRole('button', { name: /^Whombat and/ }, { timeout: 8000 });
    expect(own.getAttribute('aria-expanded')).toBe('false');
    const servers = within(add).getByRole('button', { name: /^Servers/ });
    expect(servers.getAttribute('aria-expanded')).toBe('false');
    expect(within(add).getByRole('button', { name: /^Plex/ }).getAttribute('aria-expanded')).toBe('true');
    expect(within(add).queryByRole('button', { name: 'Add Clock' })).toBeNull();

    // Opening Servers shows each server folded; opening one shows its parts.
    const user = userEvent.setup();
    await user.click(servers);
    const pve = within(add).getByRole('button', { name: /^pve-01/ });
    expect(pve.getAttribute('aria-expanded')).toBe('false');
    await user.click(pve);
    expect(within(add).getByRole('button', { name: 'Add pve-01 · Storage' })).toBeTruthy();
    expect(within(add).getByRole('button', { name: 'Add pve-01 · VMs and containers' })).toBeTruthy();
  });

  it('puts the person’s accounts under Your accounts, each open at first', async () => {
    open();
    const add = await panel();
    const accounts = await within(add).findByRole('button', { name: /^Your accounts/ }, { timeout: 8000 });
    expect(accounts.getAttribute('aria-expanded')).toBe('true');
    expect(
      within(add)
        .getByRole('button', { name: /^GitHub/ })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    expect(within(add).getByRole('button', { name: 'Add GitHub · Waiting for review' })).toBeTruthy();
  });

  it('opens whatever a search matches', async () => {
    open();
    const add = await panel();
    await within(add).findByRole('button', { name: /^Servers/ }, { timeout: 8000 });
    const user = userEvent.setup();
    await user.type(within(add).getByRole('searchbox', { name: 'Search widgets' }), 'clock');
    await waitFor(() => expect(within(add).getByRole('button', { name: 'Add Clock' })).toBeTruthy());
    expect(within(add).queryByRole('button', { name: /^Servers/ })).toBeNull();
  });
});

describe('an account widget’s icon', () => {
  it('says what it shows: its calendar, its mail, its pull requests', () => {
    const icon = (panel: string, name: string) => accountIcon({ name, opts: { panel } });
    expect(icon('today', 'Today')).toBeDefined();
    expect(icon('today', 'Today')).toBe(icon('next-meeting', 'Next meeting'));
    expect(icon('unread', 'Unread mail')).not.toBe(icon('today', 'Today'));
    expect(icon('review', 'Waiting for review')).toBe(icon('pull-requests', 'Pull requests'));
    expect(accountIcon({ name: 'Storage', opts: { panel: 'storage' } })).toBeUndefined();
  });
});

describe('A widget’s preview stays on the page (DK-156)', () => {
  const page = { left: 256, top: 0, right: 1200, bottom: 900 };
  const box = { width: 430, height: 250 };

  it('goes left of a row in the panel beside the screen', () => {
    const row = { left: 900, top: 400, right: 1180, bottom: 447 };
    expect(peekPlace(row, box, page).left).toBe(900 - 14 - 430);
  });

  it('goes under a full-width row (the panel under the screen), inside the page', () => {
    const row = { left: 322, top: 400, right: 1134, bottom: 447 };
    const at = peekPlace(row, box, page);
    expect(at.top).toBe(447 + 14);
    expect(at.left).toBeGreaterThanOrEqual(page.left + 8);
    expect(at.left + box.width).toBeLessThanOrEqual(page.right - 8);
  });

  it('goes over a full-width row near the bottom of the window', () => {
    const row = { left: 322, top: 800, right: 1134, bottom: 847 };
    expect(peekPlace(row, box, page).top).toBe(800 - 14 - 250);
  });
});
