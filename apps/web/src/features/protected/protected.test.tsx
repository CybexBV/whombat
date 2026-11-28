/**
 * What's protected on the web (Whombat backup-trust.md): the three groups with their rows, *Ask {assistant} to set up
 * backups* only where a copy isn't elsewhere, the restore tests' switch and *Test one now*, and the way in from the
 * Servers list. Fixture mode's world (`protectedFixtures.ts`).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../test/renderApp';

const group = async (name: string) => {
  const heading = await screen.findByRole('heading', { name: new RegExp(`^${name}`) });
  const section = heading.closest('section');
  if (!section) throw new Error(`no section for ${name}`);
  return section;
};

describe('What’s protected', () => {
  it('lists each thing in its group, with a way to ask only where no copy is elsewhere', async () => {
    renderApp('/protected', fixtureServices({ protected: 'tested' }));
    const copied = await group('Copied to another machine');
    expect(within(copied).getByText('homeassistant')).toBeTruthy();
    expect(within(copied).getByText(/Backblaze/)).toBeTruthy();
    expect(within(copied).queryByRole('button', { name: /set up backups/ })).toBeNull();
    const local = await group('Only on the same machine');
    expect(within(local).getByText('gitea')).toBeTruthy();
    expect(within(local).getAllByRole('button', { name: /set up backups/ })).toHaveLength(2);
    const none = await group('Not backed up that Whombat can see');
    expect(within(none).getByText('Plex')).toBeTruthy();
    expect(within(none).getAllByText(/can’t see/).length).toBeGreaterThan(0);
    // A machine's row links to its page; a failed restore test says so on its row.
    expect(within(copied).getByRole('link', { name: 'vaultwarden' }).getAttribute('href')).toContain(
      'guest=pve%3A142',
    );
    expect(within(copied).getByText(/didn’t work/)).toBeTruthy();
  });

  it('turns restore tests off and on, and tests one now', async () => {
    const user = userEvent.setup();
    renderApp('/protected', fixtureServices({ protected: 'calm' }));
    const tests = await group('Restore tests');
    const toggle = within(tests).getByRole('switch', { name: 'Test my backups' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    await user.click(within(tests).getByRole('button', { name: 'Test one now' }));
    await waitFor(() => expect(within(tests).getByText(/worked today/)).toBeTruthy());
  });

  it('is reached from the Servers list', async () => {
    renderApp('/servers', fixtureServices({ hosts: true }));
    const link = await screen.findByRole('link', { name: /What’s protected/ });
    expect(link.getAttribute('href')).toBe('/protected');
  });
});
