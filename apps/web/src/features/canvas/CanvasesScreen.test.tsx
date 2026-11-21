import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../test/renderApp';

function _grid() {
  return document.querySelector('[data-screen="canvases"]') as HTMLElement;
}

describe('CanvasesScreen quiet states (TODO 16.4)', () => {
  it('shows a one-line error with Retry when the list fails to load', async () => {
    const user = userEvent.setup();
    renderApp('/canvases', fixtureServices({ failing: ['canvases.list'] }));
    expect(await screen.findByText('Couldn’t load canvases. Try again in a moment.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Canvases' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Couldn’t load canvases. Try again in a moment.')).toBeTruthy();
  });
});

describe('New canvas (essentials-messages.md AP-449)', () => {
  it('creates a canvas with a title, then opens it', async () => {
    const user = userEvent.setup();
    const app = renderApp('/canvases');
    await user.click(await screen.findByRole('button', { name: 'New canvas' }));
    const dialog = await screen.findByRole('dialog', { name: 'Start a canvas' });
    const create = screen.getByRole('button', { name: 'Create canvas' });
    expect(create.hasAttribute('disabled')).toBe(true);
    await user.type(screen.getByRole('textbox', { name: 'TITLE' }), 'Launch notes');
    await user.click(create);
    await waitFor(() => expect(app.location()).toBe('/canvases/launch-notes'));
    expect(dialog.isConnected).toBe(false);
  });
});
