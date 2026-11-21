/**
 * Bringing things back from one backup (app backup-look.md AP-6940…AP-6946), in the fixture world: from a backup's
 * page the backup opens (saying so while it does), shows its categories with counts, lists a category's things with
 * a search and which are here already, brings the picked ones back with a line that says how it went, and closes.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../test/renderApp';

const PATH = '/settings?tab=appliance&section=backups';
const list = () => document.querySelector('[data-backup-list]') as HTMLElement;

async function openFlow(user: ReturnType<typeof userEvent.setup>) {
  renderApp(PATH, fixtureServices());
  await screen.findByRole('region', { name: 'Backed up 2 hours ago' }, { timeout: 5000 });
  await user.click(list().querySelector('[data-backup]') as HTMLElement);
  const page = await screen.findByRole('dialog', { name: /^(Today|Yesterday), \d\d:\d\d$/ });
  await user.click(within(page).getByRole('button', { name: 'Bring things back from this backup' }));
  return screen.findByRole('dialog', { name: 'Bring things back' });
}

describe('Bring things back from a backup', () => {
  it('opens the backup, finds a chat, brings it back and says so', async () => {
    const user = userEvent.setup();
    const flow = await openFlow(user);
    // A short wait that says what it is.
    expect(within(flow).getByText('Opening this backup…')).toBeTruthy();
    const kinds = await within(flow).findByRole('list', { name: 'What’s in it' }, { timeout: 5000 });
    expect(within(kinds).getByRole('button', { name: /^Chats\s*3$/ })).toBeTruthy();
    expect(within(flow).getByRole('button', { name: 'Bring back' })).toHaveProperty('disabled', true);

    await user.click(within(kinds).getByRole('button', { name: /^Chats/ }));
    await user.type(within(flow).getByRole('searchbox', { name: 'Search chats' }), 'roof');
    const chats = await within(flow).findByRole('list', { name: 'Chats' });
    await waitFor(() => expect(within(chats).getAllByRole('checkbox')).toHaveLength(1), { timeout: 3000 });
    const roof = within(chats).getByRole('checkbox', { name: /roof is leaking/ });
    await user.click(roof);
    await user.click(within(flow).getByRole('button', { name: 'Bring back 1 thing' }));
    const done = await within(flow).findByText(/is back\.$/);
    expect(done.textContent).toContain('“Our roof is leaking again above the kitchen”');

    // Bringing back again: what is here already is said, nothing changes.
    await user.click(within(flow).getByRole('button', { name: 'Bring back more' }));
    await user.click(within(flow).getByRole('button', { name: /^Chats/ }));
    const again = await within(flow).findByRole('list', { name: 'Chats' });
    await waitFor(() => expect(within(again).getAllByText('Already here').length).toBe(2));
    await user.click(within(again).getByRole('checkbox', { name: /roof is leaking/ }));
    await user.click(within(again).getByRole('checkbox', { name: /heating invoice/ }));
    await user.click(within(flow).getByRole('button', { name: 'Bring back 2 things' }));
    expect(await within(flow).findByText(/^All 2 were already here/)).toBeTruthy();
    await user.click(within(flow).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Bring things back' })).toBeNull());
  });
});
