/**
 * Settings → This Whombat → Backups → BACKUP FILE (backup-file.md AP-1200…AP-1205, this-whombat-sections.md AP-1228):
 * the two rows and their dialogs in the fixture world, a ready file with a finished restore when seeded, nothing for a
 * server without backup files, and how the web saves a file.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BACKUP_FILE_TEXT } from '@whombat/client';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { fixtureServices, mockedServices, renderApp } from '../../test/renderApp';
import { backupSaveMethod } from './backupSave';

const section = async () => {
  const label = await screen.findByRole('heading', { name: BACKUP_FILE_TEXT.section }, { timeout: 5000 });
  return label.closest('section') as HTMLElement;
};

describe('BACKUP FILE', () => {
  it('two rows; Download a backup… opens the sketch’s ticks, sizes and words, Restore from a file… its Choose a file', async () => {
    const user = userEvent.setup();
    renderApp('/settings?tab=appliance&section=backups', fixtureServices({ backups: false }));
    const s = await section();
    // One card with two rows, each opening its dialog (this-whombat-sections.md AP-1228).
    expect(
      within(s).getByText('Choose what goes in the file. You can restore it here or on another Whombat.'),
    ).toBeTruthy();
    expect(within(s).queryByRole('checkbox')).toBeNull();
    await user.click(within(s).getByRole('button', { name: 'Download a backup…' }));
    const download = await screen.findByRole('dialog', { name: 'Download a backup' });
    await within(download).findByText('Its name, face, model and keys');
    expect(within(download).getByRole('checkbox', { name: /Your Vault/ })).toHaveProperty('checked', true);
    // Nine on by default (BF-21): messages and, where this Whombat watches servers, the servers (AP-4411).
    expect(within(download).getByRole('checkbox', { name: /Messages/ })).toHaveProperty('checked', true);
    expect(within(download).getByRole('checkbox', { name: /Servers/ })).toHaveProperty('checked', true);
    expect(within(download).getByRole('checkbox', { name: /Files/ })).toHaveProperty('checked', false);
    expect(within(download).getByText(/^5 servers/)).toBeTruthy();
    expect(within(download).getByText('Your 8 entries')).toBeTruthy();
    expect(
      await within(download).findByRole('button', { name: 'Download · 124\u00a0MB' }, { timeout: 5000 }),
    ).toBeTruthy();
    expect(
      within(download).getByText('You need it to restore. Whombat can’t get it back for you.'),
    ).toBeTruthy();
    // Too short a password says so, and nothing is made.
    await user.type(within(download).getByLabelText('Password for this file'), 'short');
    await user.click(within(download).getByRole('button', { name: /^Download/ }));
    expect(within(download).getByRole('alert').textContent).toBe('Use at least 10 characters.');
    await user.click(within(download).getByRole('checkbox', { name: /Messages/ }));
    expect(within(download).getByRole('button', { name: 'Download · 4.2\u00a0MB' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(within(s).getByRole('button', { name: 'Restore from a file…' }));
    const restore = await screen.findByRole('dialog', { name: 'Restore from a file' });
    expect(within(restore).getByRole('button', { name: 'Choose a file' })).toBeTruthy();
  });

  it('seeded: the rows say the file is ready and what was restored; their dialogs show the file and what needs Mara', async () => {
    const user = userEvent.setup();
    renderApp('/settings?tab=appliance&section=backups', fixtureServices({ backups: true }));
    const s = await section();
    await within(s).findByText(/^Ready · [\d.]+\sMB · expires in 2[23] hours$/, undefined, { timeout: 5000 });
    expect(within(s).getByText('Restored')).toBeTruthy();
    const [showFile, showRestore] = within(s).getAllByRole('button', { name: 'Show' }) as HTMLElement[];
    await user.click(showFile as HTMLElement);
    const download = await screen.findByRole('dialog', { name: 'Download a backup' });
    expect(within(download).getByText('Your file is ready.')).toBeTruthy();
    expect(within(download).getByRole('button', { name: 'Remove' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(showRestore as HTMLElement);
    const restore = await screen.findByRole('dialog', { name: 'Restore from a file' });
    expect(within(restore).getByText('Fusebox needs you to sign in again. It’s in the Inbox.')).toBeTruthy();
    expect(within(restore).getByRole('link', { name: 'Open Connections' }).getAttribute('href')).toBe(
      '/settings?tab=connections#connections-needs',
    );
    expect(within(restore).getByRole('link', { name: 'Open Automations' }).getAttribute('href')).toBe(
      '/automations',
    );
    // The servers: pointed here, and blackbox to point by hand, which opens Add a server filled in (AP-4416).
    expect(within(restore).getByText(/^Pointed 4 servers here/)).toBeTruthy();
    expect(
      within(restore)
        .getByRole('link', { name: /blackbox/ })
        .getAttribute('href'),
    ).toBe('/connections?add=1&address=10.100.1.31');
    await user.click(within(restore).getByRole('button', { name: 'Done' }));
    expect(within(restore).getByRole('button', { name: 'Choose a file' })).toBeTruthy();
  });

  it('isn’t there for a server without backup files', async () => {
    const base = createWebFixtureFetch({ backups: false });
    let asked = false;
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
      if (url.pathname.startsWith(`/api/v1/burrows/${burrow.slug}/backups`)) {
        asked = true;
        return Response.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 });
      }
      return base(new Request(url, input instanceof Request ? input : init));
    };
    renderApp('/settings?tab=appliance&section=backups', mockedServices(fetch as typeof globalThis.fetch));
    await waitFor(() => expect(asked).toBe(true), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByRole('heading', { name: BACKUP_FILE_TEXT.section })).toBeNull());
    // The part says there is nothing in it (AP-1230's line), rather than staying blank.
    expect(
      await screen.findByText('Nothing to set here on this Whombat.', undefined, { timeout: 3000 }),
    ).toBeTruthy();
  });
});

describe('saving a backup file on the web', () => {
  const win = (extra: Record<string, unknown>) => ({ navigator: {}, ...extra }) as unknown as Window;
  it('writes where the person picks, else the private file system, else memory', () => {
    expect(backupSaveMethod({ win: win({ showSaveFilePicker: () => null }) })).toBe('picker');
    expect(
      backupSaveMethod({
        win: win({
          navigator: { storage: { getDirectory: () => null } },
          FileSystemFileHandle: { prototype: { createWritable: () => null } },
        }),
      }),
    ).toBe('private');
    expect(backupSaveMethod({ win: win({}) })).toBe('memory');
  });
});
