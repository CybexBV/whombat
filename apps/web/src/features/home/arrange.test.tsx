/**
 * Arranging the Overview (docs/decisions/overview-arranged.md OVA-03, OVA-04): no gears until Arrange; then a gear on
 * every tile and figure, whose panel changes what a tile shows and its size at once; Remove puts a tile under *Add to
 * Overview*, from where it comes back; Done and Esc end it. Against the fixture world.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderApp } from '../../test/renderApp';

const page = () =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-screen="home"]');
    if (!el) throw new Error('Overview isn’t there yet');
    return el;
  });
const tile = (thing: string) => document.querySelector<HTMLElement>(`[data-size][data-thing="${thing}"]`);

beforeAll(() => import('./HomeScreen'), 30_000);

describe('Arranging the Overview', () => {
  it('shows gears only while arranging, and every choice in a gear’s panel applies at once', async () => {
    const user = userEvent.setup();
    renderApp('/connections');
    const home = await page();
    const arrange = await within(home).findByRole('button', { name: 'Arrange the Overview' });
    expect(within(home).queryByRole('button', { name: /^Change / })).toBeNull();
    expect(within(home).queryByRole('button', { name: /Add to Overview/ })).toBeNull();

    await user.click(arrange);
    expect(within(home).getByRole('button', { name: 'Done arranging' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(within(home).getByText('Arranging the Overview.')).toBeTruthy();
    expect(within(home).getAllByRole('button', { name: 'Change this figure' })).toHaveLength(4);
    // A tile isn't a link while arranging.
    expect(tile('connection:con_unifi')?.tagName).toBe('DIV');

    await user.click(within(home).getByRole('button', { name: 'Change the UniFi tile' }));
    const panel = await screen.findByRole('dialog', { name: 'UniFi' });
    await user.click(await within(panel).findByRole('button', { name: /^Internet/ }));
    await user.click(within(panel).getByRole('button', { name: 'Wide' }));
    await waitFor(() => expect(tile('connection:con_unifi')?.dataset.size).toBe('w'));
    expect(
      within(panel)
        .getByRole('button', { name: /^Internet/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');

    await user.click(within(panel).getByRole('button', { name: 'Remove from Overview' }));
    await waitFor(() => expect(tile('connection:con_unifi')).toBeNull());
    await user.click(within(home).getByRole('button', { name: /Add to Overview/ }));
    const add = await screen.findByRole('dialog', { name: 'Add to Overview' });
    await user.click(within(add).getByRole('button', { name: /UniFi/ }));
    await waitFor(() => expect(tile('connection:con_unifi')?.dataset.size).toBe('w'));

    // Esc closes the panel, then ends arranging; the tiles are links again.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add to Overview' })).toBeNull());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(within(home).queryByRole('button', { name: /^Change / })).toBeNull());
    expect(tile('connection:con_unifi')?.tagName).toBe('A');
  });
});
