import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/renderApp';

async function ready() {
  await screen.findByRole('complementary', { name: 'Sidebar' });
}

describe('global keyboard', () => {
  it('opens search with Ctrl K and ⌘K, and Esc goes back to where it was opened', async () => {
    const user = userEvent.setup();
    const app = renderApp('/chat');
    await ready();

    await user.keyboard('{Control>}k{/Control}');
    await waitFor(() => expect(app.location()).toBe('/search'));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(app.location()).toBe('/chat'));

    await user.keyboard('{Meta>}k{/Meta}');
    await waitFor(() => expect(app.location()).toBe('/search'));
  });

  it('opens Settings with Ctrl , and ⌘,', async () => {
    const user = userEvent.setup();
    const app = renderApp('/inbox');
    await ready();
    await user.keyboard('{Control>},{/Control}');
    await waitFor(() => expect(app.location()).toBe('/settings'));
    await user.click(screen.getByRole('link', { name: 'Chat' }));
    await waitFor(() => expect(app.location()).toBe('/chat'));
    await user.keyboard('{Meta>},{/Meta}');
    await waitFor(() => expect(app.location()).toBe('/settings'));
  });

  it('focuses the search field when search is already open', async () => {
    const user = userEvent.setup();
    renderApp('/search?q=vat');
    const input = await screen.findByRole('textbox', { name: 'Search everything' });
    await waitFor(() => expect(document.activeElement).toBe(input));
    input.blur();
    await user.keyboard('{Control>}k{/Control}');
    expect(document.activeElement).toBe(input);
  });

  it('steps to the person’s rooms with Alt+↑/↓: from elsewhere into Chat, wrapping around', async () => {
    const user = userEvent.setup();
    const app = renderApp('/inbox');
    await ready();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(app.location()).toBe('/chat'));
    // Chat is this world's one room: it wraps onto itself.
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await waitFor(() => expect(app.location()).toBe('/chat'));
  });
});
