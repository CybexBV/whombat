/**
 * Open to the internet (Whombat internet-exposure.md) in the fixture world: the row at the end of Servers opens it,
 * what is worth a look and what is new come first, and This is meant takes the row's New away with Undo in the toast.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../../test/renderApp';

const world = () => fixtureServices({ hosts: true, connectors: 'connected' });

describe('Open to the internet', () => {
  it('opens from the Servers list and lists every opening with where Whombat looked', async () => {
    const user = userEvent.setup();
    const app = renderApp('/servers', world());
    const rows = await screen.findByRole('navigation', { name: 'Servers' }, { timeout: 12_000 });
    await user.click(within(rows).getByRole('link', { name: /^Open to the internet/ }));
    await waitFor(() => expect(app.location()).toBe('/internet'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Open to the internet' })).toBeTruthy();
    const openings = await screen.findByRole('region', { name: 'Open now' }, { timeout: 12_000 });
    const items = within(openings).getAllByRole('listitem');
    // Worth a look first, then what is new.
    expect(items[0]?.textContent).toContain('pve.example.com');
    expect(items[0]?.textContent).toContain('Worth a look');
    expect(items[1]?.textContent).toContain('photos.example.com');
    expect(within(items[1] as HTMLElement).getByText('New')).toBeTruthy();
    // Each says where to change it, outside Whombat.
    const manage = within(items[0] as HTMLElement).getByRole('link', { name: /Nginx Proxy Manager/ });
    expect(manage.getAttribute('target')).toBe('_blank');
    // Where it looked, including what it couldn't see.
    const places = screen.getByRole('region', { name: 'Where Whombat looked' });
    expect(within(places).getByText(/UPnP is on/)).toBeTruthy();
    // Back to the list on a narrow window.
    expect(screen.getByRole('link', { name: 'Servers' }).getAttribute('href')).toBe('/servers');
  });

  it('This is meant takes New away at once and offers Undo', async () => {
    const user = userEvent.setup();
    renderApp('/internet', world());
    const openings = await screen.findByRole('region', { name: 'Open now' }, { timeout: 12_000 });
    const row = within(openings)
      .getAllByRole('listitem')
      .find((li) => li.textContent?.includes('photos.example.com')) as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'This is meant' }));
    await waitFor(() => expect(within(row).queryByText('New')).toBeNull());
    expect(within(row).getByText('Meant')).toBeTruthy();
    const toast = await screen.findByRole('button', { name: 'Undo' });
    await user.click(toast);
    await waitFor(() => expect(within(row).queryByText('Meant')).toBeNull());
  });
});
