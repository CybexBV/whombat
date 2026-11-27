/**
 * *Add a widget* in the editor (Whombat desk-display.md DK-156, DK-163…DK-165): Whombat's own as tiles, each server,
 * connection and account once, a search listing single views; adding one chooses it, and its settings offer *What it
 * shows* and the size's shapes. The canvas isn't drawn without a layout engine, so dragging is checked in the browser.
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

describe('Add a widget (DK-163)', () => {
  it('lists Whombat’s own as tiles and each server, connection and account once', async () => {
    open();
    const add = await panel();
    const clock = await within(add).findByRole('button', { name: /^Add Clock/ }, { timeout: 8000 });
    expect(clock.className).toMatch(/ownTile/);
    // A server once, by its name; its parts are its widget's What it shows.
    expect(within(add).getByRole('button', { name: 'Add pve-01' })).toBeTruthy();
    expect(within(add).queryByRole('button', { name: /Storage/ })).toBeNull();
    // A connection once, and an account once.
    expect(within(add).getByRole('button', { name: 'Add Plex' })).toBeTruthy();
    expect(within(add).queryByRole('button', { name: /Now playing/ })).toBeNull();
    expect(within(add).getAllByRole('button', { name: /^Add GitHub/ })).toHaveLength(1);
    // No folds any more.
    expect(within(add).queryByRole('button', { expanded: false })).toBeNull();
  });

  it('finds single views with a search, named with what they belong to', async () => {
    open();
    const add = await panel();
    await within(add).findByRole('button', { name: 'Add pve-01' }, { timeout: 8000 });
    const user = userEvent.setup();
    const search = within(add).getByRole('searchbox', { name: 'Search widgets' });
    await user.type(search, 'storage');
    await waitFor(() =>
      expect(within(add).getByRole('button', { name: 'Add pve-01 · Storage' })).toBeTruthy(),
    );
    expect(within(add).queryByRole('button', { name: 'Add pve-01' })).toBeNull();
    await user.clear(search);
    await user.type(search, 'now playing');
    await waitFor(() =>
      expect(within(add).getByRole('button', { name: 'Add Plex · Now playing' })).toBeTruthy(),
    );
  });

  it('adds a service’s main view and offers its other views and the size’s shapes', async () => {
    open();
    const add = await panel();
    const user = userEvent.setup();
    const plex = await within(add).findByRole('button', { name: 'Add Plex' }, { timeout: 8000 });
    // The first page is full: a new one has room.
    await user.click(screen.getByRole('button', { name: '+ Page' }));
    await user.click(plex);
    const chosen = await screen.findByRole('complementary', { name: 'Plex · Figures' });
    const shows = within(chosen).getByRole('group', { name: 'What it shows' });
    const figures = within(shows).getByRole('button', { name: /^Figures/ });
    expect(figures.getAttribute('aria-pressed')).toBe('true');
    await user.click(within(shows).getByRole('button', { name: /^Now playing/ }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('complementary', { name: 'Now playing' }))
          .getByRole('button', { name: /^Now playing/ })
          .getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    const sizes = within(screen.getByRole('complementary', { name: 'Now playing' })).getByRole('group', {
      name: 'Size',
    });
    const shapes = within(sizes).getAllByRole('button');
    expect(shapes.length).toBeGreaterThan(1);
    expect(shapes.filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
  });
});

describe('the news and the weather lead to Settings → News and weather', () => {
  it('offers the news’ Choose sources, asking first while the layout isn’t saved', async () => {
    open();
    const add = await panel();
    const user = userEvent.setup();
    const news = await within(add).findByRole('button', { name: /^Add News/ }, { timeout: 8000 });
    await user.click(screen.getByRole('button', { name: '+ Page' }));
    await user.click(news);
    const chosen = await screen.findByRole('complementary', { name: 'News' });
    const link = within(chosen).getByRole('link', { name: 'Choose sources' });
    expect(link.getAttribute('href')).toBe('/settings?tab=news#news');
    await user.click(link);
    const ask = await screen.findByRole('dialog');
    await user.click(within(ask).getByRole('button', { name: 'Leave' }));
    expect(await screen.findByRole('heading', { name: 'News and weather', level: 1 })).toBeTruthy();
  });

  it('offers the weather’s place', async () => {
    open();
    const add = await panel();
    const user = userEvent.setup();
    const weather = await within(add).findByRole('button', { name: /^Add Weather/ }, { timeout: 8000 });
    await user.click(screen.getByRole('button', { name: '+ Page' }));
    await user.click(weather);
    const chosen = await screen.findByRole('complementary', { name: 'Weather' });
    const link = within(chosen).getByRole('link', { name: 'Choose where this Whombat is in Settings' });
    expect(link.getAttribute('href')).toBe('/settings?tab=news#place');
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
