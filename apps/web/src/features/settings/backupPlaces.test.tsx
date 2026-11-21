/**
 * Where on a backup place (Whombat backup-places.md BPL-13, BPL-14; app backup-places.md AP-6770…): in the fixture
 * world a place with more than one location asks where first, the recommended one preselected, and the place in use
 * names its location and moves the backups to another one after its confirm, saying so while it runs.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../test/renderApp';

const section = async () => {
  const label = await screen.findByRole('heading', { name: 'On your network' }, { timeout: 5000 });
  const s = label.closest('section') as HTMLElement;
  await within(s).findByText('DiskStation');
  return s;
};
const row = (s: HTMLElement, id: string) => s.querySelector(`[data-backup-place="${id}"]`) as HTMLElement;
const radios = (dialog: HTMLElement) =>
  within(dialog)
    .getAllByRole('radio')
    .map((r) => [(r as HTMLInputElement).value, (r as HTMLInputElement).checked]);

describe('where on a place', () => {
  it('asks where on DiskStation first, the recommended folder chosen, then backs up there', async () => {
    const user = userEvent.setup();
    renderApp('/settings?tab=appliance&section=backups', fixtureServices());
    const s = await section();
    await user.click(
      within(row(s, 'connection:con_diskstation')).getByRole('button', { name: 'Back up here' }),
    );
    const where = await screen.findByRole('dialog', { name: 'Where on DiskStation?' });
    expect(radios(where)).toEqual([
      ['whombat', true],
      ['Backups', false],
    ]);
    expect(within(where).getByText('Recommended')).toBeTruthy();
    await user.click(within(where).getByRole('radio', { name: /^Backups/ }));
    await user.click(within(where).getByRole('button', { name: 'Back up here' }));
    // blackbox keeps them now: moving asks first (BPL-06).
    const move = await screen.findByRole('dialog', { name: 'Back up to DiskStation instead?' });
    await user.click(within(move).getByRole('button', { name: 'Back up here' }));
    expect(
      await within(s).findByText(/the shared folder Backups on DiskStation/, {}, { timeout: 5000 }),
    ).toBeTruthy();
  });

  it('names the location in use and moves the backups to another one on Change', async () => {
    const user = userEvent.setup();
    renderApp('/settings?tab=appliance&section=backups', fixtureServices());
    const s = await section();
    const blackbox = row(s, 'server:blackbox');
    expect(within(blackbox).getByText(/the share whombat-backups/)).toBeTruthy();
    await user.click(within(blackbox).getByRole('button', { name: /^Change/ }));
    const where = await screen.findByRole('dialog', { name: 'Where on blackbox?' });
    expect(radios(where)[0]).toEqual(['whombat-backups', true]);
    expect(within(where).getByText('In use')).toBeTruthy();
    const change = within(where).getByRole('button', { name: 'Change' });
    expect(change).toHaveProperty('disabled', true);
    await user.click(within(where).getByRole('radio', { name: /^Backups/ }));
    await user.click(change);
    const confirm = await screen.findByRole('dialog', { name: 'Keep backups in Backups?' });
    expect(within(confirm).getByText(/keep their history/)).toBeTruthy();
    await user.click(within(confirm).getByRole('button', { name: 'Change' }));
    expect(await within(blackbox).findByText(/^Moving your backups to Backups/)).toBeTruthy();
    await waitFor(() => expect(within(blackbox).getByText(/the share Backups now/)).toBeTruthy(), {
      timeout: 8000,
    });
  }, 15_000);
});
