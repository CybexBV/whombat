import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/renderApp';

describe('side panes take focus and give it back (WE-13)', () => {
  it('the thread pane focuses its heading, and closing it goes back to the room', async () => {
    const user = userEvent.setup();
    const app = renderApp('/pr/482?thread=msg_pr482-mara-1120');
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    const heading = await within(pane).findByRole('heading', { name: 'Thread' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    await user.click(within(pane).getByRole('button', { name: 'Close thread' }));
    await waitFor(() => expect(app.location()).toBe('/pr/482'));
  });
});
