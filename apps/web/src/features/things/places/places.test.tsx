/**
 * Servers and Connections as places (servers-connections-places.md) in the fixture world: on a wide
 * window a place opens a page beside its list and the list stays as it is while rows are picked; on a narrow one the
 * list is alone and a page goes back to it.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../../test/renderApp';
import { INBOX_SPLIT_MEDIA } from '../../chats/inboxNav';

const world = () => fixtureServices({ hosts: true, connectors: 'connected' });
const list = (name: string) => screen.findByRole('navigation', { name }, { timeout: 12_000 });

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
  localStorage.clear();
});

/** A window wide enough for the list beside the page (Chat's split). */
function wide() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === INBOX_SPLIT_MEDIA,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }),
  });
}

describe('a place on a wide window', () => {
  it('opens its first row beside the list, without a crumb, and keeps the list while rows are picked', async () => {
    wide();
    const user = userEvent.setup();
    const app = renderApp('/connected', world());
    const rows = await list('Connections');
    // Never an empty right side: the first row's page opens beside the list.
    await waitFor(() => expect(app.location()).toMatch(/^\/things\/connection%3A/));
    const first = within(rows).getAllByRole('link')[0] as HTMLElement;
    expect(first.getAttribute('aria-current')).toBe('page');
    // The page's own region (the app's main holds the list too).
    const mains = await screen.findAllByRole('main', {}, { timeout: 12_000 });
    const main = mains[mains.length - 1] as HTMLElement;
    expect(within(main).queryByRole('navigation', { name: 'Connections' })).toBeNull();
    // The list is beside it: no crumb back.
    expect(within(main).queryByRole('link', { name: 'Connections' })).toBeNull();
    expect(within(main).queryByRole('link', { name: 'Overview' })).toBeNull();
    // Picking another row keeps the same list (its scroll and focus), only the page changes.
    const other = within(rows).getAllByRole('link')[1] as HTMLElement;
    const href = other.getAttribute('href');
    await user.click(other);
    await waitFor(() => expect(app.location()).toBe(href));
    expect(screen.getByRole('navigation', { name: 'Connections' })).toBe(rows);
    expect(other.getAttribute('aria-current')).toBe('page');
    // The one looked at last is kept for the next time.
    const kept = Object.keys(localStorage).find((k) => k.endsWith('.connections'));
    expect(kept).toMatch(/^whombat\.place\..+\.connections$/);
    expect(localStorage.getItem(kept ?? '')).toBe(decodeURIComponent((href ?? '').replace('/things/', '')));
  });
});

describe('a place on a narrow window', () => {
  it('is the list alone, and a page goes back to it', async () => {
    const user = userEvent.setup();
    const app = renderApp('/servers', world());
    const rows = await list('Servers');
    expect(screen.getByRole('heading', { level: 1, name: 'Servers' })).toBeTruthy();
    expect(app.location()).toBe('/servers');
    await user.click(await within(rows).findByRole('link', { name: /^pve-02/ }));
    await waitFor(() => expect(app.location()).toMatch(/^\/things\/server%3Apve-02/));
    const back = await screen.findByRole('link', { name: 'Servers' }, { timeout: 12_000 });
    expect(back.closest('main')).toBeTruthy();
    expect(back.getAttribute('href')).toBe('/servers');
    expect(screen.queryByRole('navigation', { name: 'Servers' })).toBeNull();
  });
});
