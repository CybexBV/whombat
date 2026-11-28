/**
 * Add a server over the Servers list (servers-connections-places.md): the Servers list's and the Overview's old
 * addresses open it, filled in from the assistant's card; every guest of every server keeps its own address. Against
 * the fixture world with the hosts layer (`VITE_FIXTURE_HOSTS`'s).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../../test/renderApp';

const withServers = () => fixtureServices({ hosts: true });
// The page's screens are loaded before the first test's waits start: imported cold on a busy machine, their modules can
// take most of `findBy`'s five seconds before anything renders.
beforeAll(() => import('./ThingPlace'), 30_000);

describe('the servers list’s address', () => {
  it('opens Add a server over the Servers list, filled in from the assistant’s card', async () => {
    // A link in a chat (the assistant's card, SI-10), and the same in an older message.
    for (const path of ['/things/servers', '/connections']) {
      const app = renderApp(`${path}?add=1&address=10.100.0.14&user=admin&control=operate`, withServers());
      await waitFor(() =>
        expect(app.location()).toBe('/servers?add=1&address=10.100.0.14&user=admin&control=operate'),
      );
      const dialog = await screen.findByRole('dialog', { name: 'Add a server' });
      const address = await within(dialog).findByLabelText('Address', {}, { timeout: 8_000 });
      expect((address as HTMLInputElement).value).toBe('10.100.0.14');
      expect((within(dialog).getByLabelText('User name') as HTMLInputElement).value).toBe('admin');
      await userEvent.setup().keyboard('{Escape}');
      await waitFor(() => expect(app.location()).toBe('/servers'));
      app.unmount();
    }
  }, 20_000);

  it('keeps every guest of every server where it was, with the crumb to Servers', async () => {
    const app = renderApp('/things/servers?view=guests', withServers());
    expect(
      await screen.findByRole('heading', { name: 'Everything running on your servers', level: 1 }),
    ).toBeTruthy();
    expect(app.location()).toBe('/things/servers?view=guests');
    const main = screen.getByRole('main', { name: 'Everything running on your servers' });
    expect(within(main).getByRole('link', { name: 'Servers' }).getAttribute('href')).toBe('/servers');
  });
});

describe('add a server by signing in once (server-signin-web.md)', () => {
  /** The Servers list with Add a server opened from a link. */
  async function openAdd(query: string) {
    renderApp(`/servers?${query}`, withServers());
    const dialog = await screen.findByRole('dialog', { name: 'Add a server' });
    await within(dialog).findByRole('tab', { name: 'Sign in once' }, { timeout: 8_000 });
    return dialog;
  }

  it('says what went wrong and tries again without the password', async () => {
    const user = userEvent.setup();
    const dialog = await openAdd('add=1&address=10.100.0.14&user=admin&control=operate');
    expect(within(dialog).getByRole('tab', { name: 'Sign in once', selected: true })).toBeTruthy();
    expect(
      (within(dialog).getByRole('radio', { name: 'Restart and consoles' }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (within(dialog).getByRole('checkbox', { name: /Leave a Vault key on it/ }) as HTMLInputElement).checked,
    ).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Add server' }));
    expect(within(dialog).getByText('Type its password.')).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Password', { exact: true }), 'wrong');
    await user.click(within(dialog).getByRole('button', { name: 'Add server' }));
    expect(await within(dialog).findByRole('heading', { name: 'Adding 10.100.0.14' })).toBeTruthy();
    // One plain card (connect-in-chat.md): what happened, and Try again.
    expect(
      await within(dialog).findByText(
        'The user name or password for 10.100.0.14 isn’t right.',
        {},
        { timeout: 8_000 },
      ),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect((within(dialog).getByLabelText('Address') as HTMLInputElement).value).toBe('10.100.0.14');
    expect((within(dialog).getByLabelText('Password', { exact: true }) as HTMLInputElement).value).toBe('');
  }, 20_000);

  it('offers the one line to run when the server can’t reach the Whombat (connect-in-chat.md)', async () => {
    const user = userEvent.setup();
    const dialog = await openAdd('add=1&address=10.20.0.5');
    await user.type(within(dialog).getByLabelText('Password', { exact: true }), 'hunter22');
    await user.click(within(dialog).getByRole('button', { name: 'Add server' }));
    const run = await within(dialog).findByRole(
      'button',
      { name: 'Run this one line on it instead' },
      { timeout: 10_000 },
    );
    await user.click(run);
    expect(await within(dialog).findByRole('tab', { name: 'Run a command', selected: true })).toBeTruthy();
  }, 20_000);

  it('asks to trust a key that changed (connect-in-chat.md)', async () => {
    const user = userEvent.setup();
    const dialog = await openAdd('add=1&address=10.20.0.6');
    await user.type(within(dialog).getByLabelText('Password', { exact: true }), 'hunter22');
    await user.click(within(dialog).getByRole('button', { name: 'Add server' }));
    expect(
      await within(dialog).findByText(
        'Its key changed since last time. Trust the new one?',
        {},
        { timeout: 10_000 },
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Trust the new one' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'No' })).toBeTruthy();
  }, 20_000);

  it('makes the pre-approved command for the level chosen', async () => {
    const user = userEvent.setup();
    const dialog = await openAdd('add=1');
    await user.click(within(dialog).getByRole('tab', { name: 'Run a command' }));
    expect(await within(dialog).findByText(/--control full$/)).toBeTruthy();
    await user.click(within(dialog).getByRole('radio', { name: 'Watch only' }));
    expect(await within(dialog).findByText(/--control watch$/)).toBeTruthy();
  }, 15_000);
});
