/**
 * Right-click menus on the Chat shell's places and clearing Chat (Whombat chat-clear.md CHC-01; app chat-clear.md
 * AP-4500…AP-4507), against the fixture world's Chat (`chatChannelFixtures.ts`).
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureServices, renderApp } from '../../test/renderApp';

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const chatShell = () => fixtureServices({});
const sidebar = () => screen.findByRole('complementary', { name: 'Sidebar' });
const place = (side: HTMLElement, name: string | RegExp) => within(side).getByRole('link', { name });
const items = () =>
  within(screen.getByRole('menu'))
    .getAllByRole('menuitem')
    .map((i) => i.textContent);

describe('the places’ right-click menus (AP-4500, AP-4501)', () => {
  it('offers Settled and Clear chats on Chat, and what each other place adds; elsewhere nothing opens', async () => {
    const user = userEvent.setup();
    const app = renderApp('/chat', chatShell());
    const side = await sidebar();

    await user.pointer({ keys: '[MouseRight]', target: place(side, /^Chat/) });
    expect(screen.getByRole('menu', { name: 'Chat' })).toBeTruthy();
    expect(items()).toEqual(['Settled', 'Clear chats', 'Settle finished threads']);
    await user.click(screen.getByRole('menuitem', { name: 'Settled' }));
    await waitFor(() => expect(app.location()).toBe('/chat?settled=1'));
    expect(await screen.findByRole('complementary', { name: 'Settled' })).toBeTruthy();

    // Nothing a menu would add: no menu, and not the browser's either (a row, the sidebar's own space).
    expect(fireEvent.contextMenu(place(side, /^Inbox/))).toBe(false);
    expect(fireEvent.contextMenu(within(side).getByRole('navigation', { name: 'Whombat' }))).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();

    // Connections adds a connection (servers-connections-places.md).
    await user.pointer({ keys: '[MouseRight]', target: place(side, /^Connections/) });
    expect(items()).toEqual(['Add a connection']);
    await user.keyboard('{Escape}');

    await user.pointer({ keys: '[MouseRight]', target: place(side, 'Automations') });
    expect(items()).toEqual(['New automation']);
    // Automations are made by talking to the agent: the field that asks it takes the focus.
    await user.click(screen.getByRole('menuitem', { name: 'New automation' }));
    const field = await screen.findByRole('textbox', { name: /what should happen on its own…$/ });
    await waitFor(() => expect(document.activeElement).toBe(field));
    await waitFor(() => expect(app.location()).toBe('/automations'));

    await user.pointer({ keys: '[MouseRight]', target: place(side, 'Vault') });
    expect(items()).toEqual(['Add to Vault']);
    await user.click(screen.getByRole('menuitem', { name: 'Add to Vault' }));
    expect(await screen.findByRole('dialog', { name: 'Add to Vault' })).toBeTruthy();
    expect(app.location()).toBe('/vault?add=1');
  });
});

describe('Clear chats (AP-4502…AP-4504)', () => {
  it('asks first, empties Chat and says search still finds every thread', async () => {
    const user = userEvent.setup();
    const app = renderApp('/chat', chatShell());
    const side = await sidebar();
    const chat = await screen.findByRole('region', { name: 'Chat' });
    // Its threads, one row each (chat-inbox-web.md).
    expect(await within(chat).findAllByRole('link', { name: /\?/ })).not.toHaveLength(0);
    const before = chat.querySelectorAll('[data-inbox-row]').length;

    await user.pointer({ keys: '[MouseRight]', target: place(side, /^Chat/) });
    await user.click(screen.getByRole('menuitem', { name: 'Clear chats' }));
    const dialog = await screen.findByRole('dialog', { name: 'Clear Chat?' });
    expect(within(dialog).getByText(/Neo/)).toBeTruthy();
    expect(within(dialog).getByText(/Search/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Clear chats' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText(/Cleared Chat/)).toBeTruthy();
    // What could settle did; only threads Neo works on or that wait for Mara stay (Whombat chat-inbox.md CIB-13).
    await waitFor(() => {
      const rows = [...screen.getByRole('region', { name: 'Chat' }).querySelectorAll('[data-inbox-row]')];
      expect(rows.length).toBeLessThan(before);
      for (const row of rows) expect(row.getAttribute('aria-label')).toMatch(/waiting for you|working/);
    });
    expect(app.location()).toBe('/chat');
  });
});
