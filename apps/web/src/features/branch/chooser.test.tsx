import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../test/renderApp';

describe('branch rooms of several repos (essentials item 5, AP-496)', () => {
  it('asks which PR #1 when the link doesn’t say, and opens the one picked', async () => {
    const user = userEvent.setup();
    const app = renderApp('/pr/1', fixtureServices({ essentialsSettings: true }));
    const chooser = await screen.findByRole('region', { name: 'Which PR #1?' });
    const rows = within(chooser).getAllByRole('link');
    expect(rows.map((a) => a.getAttribute('href'))).toEqual([
      '/pr/1?repo=whombat/infra',
      '/pr/1?repo=whombat/web',
    ]);
    await user.click(within(chooser).getByRole('link', { name: /whombat\/web/ }));
    await waitFor(() => expect(app.location()).toBe('/pr/1?repo=whombat/web'));
    expect(await screen.findByText('PR #1 · Dark mode for the invoice pages · whombat/web')).toBeTruthy();
  });

  it('opens the room of the asked repo; the sidebar lists no rooms (docs/decisions/settings-simplify.md SS-20)', async () => {
    renderApp('/pr/1?repo=whombat/infra', fixtureServices({ essentialsSettings: true }));
    expect(await screen.findByText('chore/terraform-1-9', { selector: 'h1 *, h1' })).toBeTruthy();
    const side = screen.getByRole('complementary', { name: 'Sidebar' });
    expect(within(side).queryByRole('region', { name: 'BRANCH ROOMS' })).toBeNull();
    expect(within(side).queryByRole('link', { name: /chore\/terraform-1-9|feat\/dark-mode/ })).toBeNull();
  });

  it('opens an old link with the only room of that number', async () => {
    renderApp('/pr/482');
    expect(await screen.findByText('feat/invoice-pdf', { selector: 'h1 *, h1' })).toBeTruthy();
  });

  it('offers Copy branch name from the header’s More, as the sidebar row did (SS-53, AP-5226)', async () => {
    const user = userEvent.setup();
    renderApp('/pr/482');
    await user.click(await screen.findByRole('button', { name: 'More for feat/invoice-pdf' }));
    const menu = screen.getByRole('menu', { name: 'feat/invoice-pdf' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Copy branch name']);
  });
});
