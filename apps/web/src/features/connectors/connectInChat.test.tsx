/**
 * The connect page from the assistant's card (Whombat connect-in-chat.md): an entry Whombat looks after best as a
 * server says so above its form, with Add as a server filled in from the address.
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../test/renderApp';

describe('the connect page of Proxmox VE (connect-in-chat.md)', () => {
  it('offers Add as a server first, with the address filled in', async () => {
    renderApp(
      '/settings?tab=connections&connection=proxmox&url=https%3A%2F%2F192.168.1.10%3A8006&access=read',
      fixtureServices({ connectors: 'connected' }),
    );
    expect(await screen.findByText('Add it as a server instead')).toBeTruthy();
    const add = screen.getByRole('link', { name: 'Add as a server' });
    expect(add.getAttribute('href')).toContain('/connections?add=1&address=192.168.1.10');
  });

  it('says nothing of the kind for Home Assistant', async () => {
    renderApp(
      '/settings?tab=connections&connection=homeassistant&url=http%3A%2F%2F192.168.1.20%3A8123&access=manage',
      fixtureServices({ connectors: 'connected' }),
    );
    expect(await screen.findByRole('heading', { name: 'Home Assistant' })).toBeTruthy();
    expect(screen.queryByText('Add it as a server instead')).toBeNull();
  });
});
