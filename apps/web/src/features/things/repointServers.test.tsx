/**
 * Point them here (Whombat backup-file.md BF-15, BF-16; app backup-file.md AP-4417): BF-16's Needs you item opens the
 * dialog over the Servers list (`/things/servers?repoint=1`, which goes to `/servers?repoint=1`); it lists the servers still looking for the old address, Point
 * them here follows the job server by server, and a server without a Vault key opens Add a server filled in. Against
 * the fixture world with the hosts layer (`fixtures-rp.ts`).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../test/renderApp';

const withServers = () => fixtureServices({ hosts: true });

describe('Point them here (AP-4417)', () => {
  it('opens from Needs you’s address, points the servers here one by one and fills in Add a server for the rest', async () => {
    const user = userEvent.setup();
    const app = renderApp('/things/servers?repoint=1', withServers());
    await waitFor(() => expect(app.location()).toBe('/servers?repoint=1'));
    const dialog = await screen.findByRole('dialog', { name: 'Point them here' });
    expect(await within(dialog).findByText(/10\.100\.1\.160 to 10\.100\.1\.158, and 3 servers/)).toBeTruthy();
    const list = within(dialog).getByRole('list', { name: 'Point them here' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    await user.click(within(dialog).getByRole('button', { name: 'Point them here' }));
    // The job walks server by server (done on its second read in the fixture world; read every 2 s).
    await within(dialog).findByText(/Pointed 2 servers here/, undefined, { timeout: 20_000 });
    expect(within(dialog).getAllByText(/Pointed here/).length).toBeGreaterThanOrEqual(2);
    expect(within(dialog).getByText(/Needs a password/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Point it here' }));
    const add = await screen.findByRole('dialog', { name: 'Add a server' });
    const address = await within(add).findByLabelText('Address', {}, { timeout: 8_000 });
    expect((address as HTMLInputElement).value).toBe('10.100.1.30');
    expect(app.location()).not.toContain('repoint');
  }, 40_000);

  it('Leave them closes it and changes nothing', async () => {
    const user = userEvent.setup();
    const app = renderApp('/servers?repoint=1', withServers());
    const dialog = await screen.findByRole('dialog', { name: 'Point them here' }, { timeout: 8_000 });
    await user.click(await within(dialog).findByRole('button', { name: 'Leave them' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(app.location()).toBe('/servers');
  }, 15_000);
});
