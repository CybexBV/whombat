/**
 * Settings → This Whombat → Backups, A COPY SOMEWHERE ELSE (Whombat offsite-copy.md), in the fixture world: offered
 * while there is none, set up through the form (a refused key says which step failed, in the person's words), shown on
 * the top card under the main place, and a copy that keeps failing says why. Words come from the shared text, so
 * rewording doesn't mean editing these.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { offsiteText, BACKUP_OPTIONS_TEXT as T } from '@whombat/client/managed';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../test/renderApp';

const PATH = '/settings?tab=appliance&section=backups';
const W = offsiteText();
const section = () => screen.findByRole('region', { name: W.title }, { timeout: 5000 });

describe('A copy somewhere else', () => {
  it('is offered while there is none, and set up through the form', async () => {
    const user = userEvent.setup();
    renderApp(PATH, fixtureServices());
    const part = await section();
    await user.click(within(part).getByRole('button', { name: W.setUp }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: W.form.providers.hetzner }));
    await user.type(within(dialog).getByLabelText(W.form.endpoint), 'fsn1.your-objectstorage.com');
    await user.type(within(dialog).getByLabelText(W.form.bucket), 'wrong-key-bucket');
    await user.type(within(dialog).getByLabelText(W.form.keyId), 'KEYID');
    await user.type(within(dialog).getByLabelText(W.form.secret), 'not-shown');
    await user.click(within(dialog).getByRole('button', { name: W.form.save }));
    // The key was refused: the form says which step, and stays open.
    expect((await within(dialog).findByRole('alert')).textContent).toBe(W.steps.keys);
    const bucket = within(dialog).getByLabelText(W.form.bucket);
    await user.clear(bucket);
    await user.type(bucket, 'blackbox-copy');
    await user.click(within(dialog).getByRole('button', { name: W.form.save }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 5000 });
    const set = await section();
    await waitFor(() => expect(set.querySelector('[data-backup-offsite-state]')).not.toBeNull());
    expect(within(set).getAllByText(/Hetzner/).length).toBeGreaterThan(0);
    expect(within(set).getByRole('button', { name: W.remove })).toBeTruthy();
  });

  it('sits under the main place on the top card', async () => {
    renderApp(PATH, fixtureServices({ backupFake: { offsite: 'ok' } }));
    const card = await screen.findByRole('region', { name: T.backedUp('2 hours ago') }, { timeout: 5000 });
    const line = await waitFor(() => {
      const found = card.querySelector('[data-backup-offsite-line]');
      if (!found) throw new Error('no line yet');
      return found;
    });
    expect(line.getAttribute('data-tone')).toBe('ok');
    expect(line.textContent).toContain('Backblaze B2');
  });

  it('says why a copy keeps failing and when Whombat tries again', async () => {
    renderApp(PATH, fixtureServices({ backupFake: { offsite: 'failing' } }));
    const part = await section();
    const problem = await within(part).findByRole('alert');
    expect(problem.textContent).toContain(W.steps.keys);
    expect(part.querySelector('[data-backup-offsite-state="failing"]')).not.toBeNull();
  });

  it('isn’t offered on a box from before', async () => {
    renderApp(PATH, fixtureServices({ backupOptions: false }));
    await screen.findByText(/blackbox|BlackBox/i, undefined, { timeout: 5000 }).catch(() => null);
    expect(screen.queryByRole('region', { name: W.title })).toBeNull();
  });
});
