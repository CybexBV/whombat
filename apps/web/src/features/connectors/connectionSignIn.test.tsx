/**
 * Connections that sign in properly (Whombat connection-signin.md SG-01…SG-09; AP-3911…AP-3913) against the fixture world:
 * Sign in with Plex in a new tab, polled until connected (and Sign in again on its page), UniFi's emailed code sent back
 * with its challenge, and Synology's two-step code asked once on connect and on Replace password.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CONNECT_FORM_TEXT } from '@whombat/client/connections';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureServices, renderApp } from '../../test/renderApp';

/** The code field's label, as the form shows it (upper case). */
const CODE_LABEL = CONNECT_FORM_TEXT.code.toUpperCase();

/** A tab `window.open` hands back: where the form points it, and whether it closed it. */
function fakeTab() {
  const tab = { opener: {} as unknown, location: { href: 'about:blank' }, closed: false, close: vi.fn() };
  tab.close.mockImplementation(() => {
    tab.closed = true;
  });
  return tab;
}

/** Two of the fixture's polls (every 2 s; it connects on the second). */
async function twoPolls() {
  for (let i = 0; i < 2; i++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
}

// The page's screens are loaded before the first test's waits start: imported cold on a busy machine, their modules can
// take most of `findBy`'s five seconds before anything renders.
beforeAll(() => Promise.all([import('../home/HomeScreen'), import('../settings/ConnectionsPages')]), 30_000);

describe('signing in on the service’s own page (SG-01…SG-05)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens Plex’s page in a tab, waits, closes the tab and opens the connection; signs in again there', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const tab = fakeTab();
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const app = renderApp(
      '/connections?connection=plex&url=http://10.0.0.40:32400',
      fixtureServices({ connectors: 'connected' }),
    );
    const plex = await screen.findByRole('radio', { name: /^Sign in with Plex/ });
    expect((plex as HTMLInputElement).checked).toBe(true);
    expect(plex.closest('label')?.textContent).toContain('Recommended');
    // It takes the level: no note that it connects to manage.
    await user.click(screen.getByRole('radio', { name: /^Look only/ }));
    expect(screen.queryByText(/set it to Look only on its page/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Sign in with Plex' }));
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(await screen.findByText('Waiting for Plex…')).toBeTruthy();
    expect(tab.location.href).toContain('https://app.plex.tv/auth#?clientID=');
    expect(tab.opener).toBeNull();
    expect(screen.getByRole('link', { name: /Open the Plex sign-in/ }).getAttribute('href')).toBe(
      tab.location.href,
    );

    await twoPolls();
    await waitFor(() => expect(app.location()).toMatch(/con_fixture_/));
    expect(tab.close).toHaveBeenCalled();
    // Saved at the level asked (CT-738).
    expect(await screen.findByText(/^Look only: /)).toBeTruthy();

    // Its page's Connection tab signs in again on Plex's page, for the same connection.
    await user.click(screen.getByRole('tab', { name: 'Connection' }));
    const again = fakeTab();
    open.mockReturnValue(again as unknown as Window);
    const where = app.location();
    await user.click(await screen.findByRole('button', { name: 'Sign in again' }));
    expect(await screen.findByText('Waiting for Plex…')).toBeTruthy();
    await twoPolls();
    await waitFor(() => expect(screen.queryByText('Waiting for Plex…')).toBeNull());
    expect(again.close).toHaveBeenCalled();
    expect(app.location()).toBe(where);
    expect(screen.getByRole('button', { name: 'Replace token' })).toBeTruthy();
  });

  it('makes Plex’s page ready while the form is open, so the click opens that page itself', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const app = renderApp(
      '/connections?connection=plex&url=http://10.0.0.40:32400',
      fixtureServices({ connectors: 'connected' }),
    );
    await screen.findByRole('radio', { name: /^Sign in with Plex/ });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await user.click(screen.getByRole('button', { name: 'Sign in with Plex' }));
    expect(open).toHaveBeenCalledTimes(1);
    const [url, target, features] = open.mock.calls[0] ?? [];
    expect(String(url)).toContain('https://app.plex.tv/auth#?clientID=');
    expect([target, features]).toEqual(['_blank', 'noopener']);
    expect(await screen.findByText('Waiting for Plex…')).toBeTruthy();
    await twoPolls();
    await waitFor(() => expect(app.location()).toMatch(/con_fixture_/));
  });

  it('says what Plex said when the server didn’t accept the account, and lets the person try again', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.spyOn(window, 'open').mockReturnValue(fakeTab() as unknown as Window);
    renderApp(
      '/connections?connection=plex&url=http://notowner.lan:32400',
      fixtureServices({ connectors: 'connected' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Sign in with Plex' }));
    await screen.findByText('Waiting for Plex…');
    await twoPolls();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('owner');
    expect(screen.getByRole('button', { name: 'Sign in with Plex' })).toBeTruthy();
  });
});

describe('a code that belongs to a challenge (SG-06, SG-07)', () => {
  it('sends UniFi’s challenge back with the code, and forgets it when the password changes', async () => {
    const user = userEvent.setup();
    const app = renderApp(
      '/connections?connection=unifi_network&url=http://10.0.0.1',
      fixtureServices({ connectors: 'connected' }),
    );
    await user.type(await screen.findByLabelText('USERNAME'), 'mara@burrowhq.example');
    await user.type(screen.getByLabelText('PASSWORD'), '2fa');
    await user.click(screen.getByRole('button', { name: 'Sign in and connect' }));
    const code = await screen.findByLabelText(CODE_LABEL);
    expect(screen.getByText(/emailed to m•••@burrowhq\.example/)).toBeTruthy();
    await user.type(code, '123456');
    // A new password starts the sign-in again: the old challenge isn't sent, so UniFi asks again.
    const password = screen.getByLabelText('PASSWORD');
    await user.clear(password);
    await user.type(password, '2fa');
    await user.click(screen.getByRole('button', { name: 'Sign in and connect' }));
    await waitFor(() => expect(screen.getByLabelText(CODE_LABEL)).toBeTruthy());
    expect(app.location()).not.toMatch(/con_fixture_/);
    // Now with the challenge that came with the ask: connected.
    await user.click(screen.getByRole('button', { name: 'Sign in and connect' }));
    await waitFor(() => expect(app.location()).toMatch(/con_fixture_/));
  });
});

/** What keeps Safari's AutoFill and password managers' fill menus, which take the focus, off a field. */
function expectNotALogin(field: HTMLElement) {
  expect(field.getAttribute('autocomplete')).not.toMatch(/^(username|current-password|email|on)?$/);
  expect(field.hasAttribute('data-1p-ignore')).toBe(true);
  expect(field.getAttribute('data-lpignore')).toBe('true');
  expect(field.hasAttribute('data-bwignore')).toBe(true);
  expect(field.getAttribute('data-form-type')).toBe('other');
}

describe('a service’s own username and password are not a login to this page', () => {
  it('keeps AutoFill and password managers off UniFi’s username and password, as off its API key', async () => {
    const user = userEvent.setup();
    renderApp(
      '/connections?connection=unifi_network&url=http://10.0.0.1',
      fixtureServices({ connectors: 'connected' }),
    );
    const username = await screen.findByLabelText('USERNAME');
    const password = screen.getByLabelText('PASSWORD');
    expectNotALogin(username);
    expectNotALogin(password);
    expect(password.getAttribute('autocomplete')).toBe('new-password');

    await user.click(screen.getByRole('radio', { name: /^API key/ }));
    expect(screen.getByLabelText('API KEY').getAttribute('autocomplete')).toBe('new-password');
  });
});

describe('a session’s two-step code, asked once (SG-09)', () => {
  it('asks Synology’s code on connect and on Replace password, and says when a code didn’t work', async () => {
    const user = userEvent.setup();
    const app = renderApp(
      '/connections?connection=synology&url=https://synology.local:5001',
      fixtureServices({ connectors: 'connected' }),
    );
    expect(await screen.findByText('Whombat trusts this certificate and only this one.')).toBeTruthy();
    await user.type(screen.getByLabelText('ACCOUNT'), 'whombat');
    expect(screen.queryByLabelText(/^CODE/)).toBeNull();
    await user.type(screen.getByLabelText('PASSWORD'), '2fa');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    const code = await screen.findByLabelText(CODE_LABEL);
    await user.type(code, '000000');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/That code didn’t work/)).toBeTruthy();
    await user.clear(code);
    await user.type(code, '123456');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(app.location()).toMatch(/con_fixture_/));

    // Replace password, on its page's Settings: DSM asks for a code with a new password.
    await user.click(await screen.findByRole('tab', { name: 'Connection' }));
    await user.click(await screen.findByRole('button', { name: 'Replace password' }));
    const section = screen.getByRole('region', { name: 'SIGN-IN' });
    await user.type(within(section).getByLabelText('PASSWORD'), '2fa');
    await user.click(within(section).getByRole('button', { name: 'Save' }));
    const again = await within(section).findByLabelText(CODE_LABEL);
    await user.type(again, '654321');
    await user.click(within(section).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Password replaced.')).toBeTruthy();
  });
});

describe('a pairing code, and signing in again with a new one (T3 Code, t3code.md)', () => {
  it('connects T3 Code with its code alone, then signs that connection in again on its page', async () => {
    const user = userEvent.setup();
    const app = renderApp(
      '/connections?connection=t3code&url=http://10.0.0.20:3773',
      fixtureServices({ connectors: 'connected' }),
    );
    // The code alone, the steps to make it, and the http warning in its words.
    const code = await screen.findByLabelText('PAIRING CODE');
    expect(screen.queryByLabelText(/^USERNAME|^ACCOUNT|^PASSWORD/)).toBeNull();
    const steps = screen.getByRole('list', { name: 'Making the pairing code' });
    expect(within(steps).getAllByRole('listitem').length).toBeGreaterThan(1);
    expect(screen.getByText(/the pairing code and Whombat’s key/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Sign in and connect' }));
    expect(await screen.findByText('Pairing code is needed.')).toBeTruthy();
    await user.type(code, 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in and connect' }));
    expect(await screen.findByText(/That pairing code didn’t work/)).toBeTruthy();
    await user.clear(code);
    await user.type(code, 'ABCD2345EFGH');
    await user.click(screen.getByRole('button', { name: 'Sign in and connect' }));
    await waitFor(() => expect(app.location()).toMatch(/con_fixture_/));

    // Its page signs it in again with a new code, never Replace token.
    await user.click(await screen.findByRole('tab', { name: 'Connection' }));
    const section = await screen.findByRole('region', { name: 'SIGN-IN' });
    expect(within(section).queryByRole('button', { name: /^Replace/ })).toBeNull();
    await user.click(within(section).getByRole('button', { name: 'Sign in again' }));
    expect(within(section).getByRole('list', { name: 'Making the pairing code' })).toBeTruthy();
    const again = within(section).getByLabelText('PAIRING CODE');
    await user.type(again, 'wrong');
    await user.click(within(section).getByRole('button', { name: 'Sign in' }));
    expect(await within(section).findByText(/That pairing code didn’t work/)).toBeTruthy();
    await user.clear(again);
    await user.type(again, 'WXYZ6789ABCD');
    await user.click(within(section).getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Signed in to T3 Code again.')).toBeTruthy();
    expect(within(section).queryByLabelText('PAIRING CODE')).toBeNull();
  });
});

describe('the vendors’ own MCP sign-in first (SG-20)', () => {
  it.each([
    ['todoist', 'Todoist'],
    ['airtable', 'Airtable'],
    ['mollie', 'Mollie'],
    ['cloudflare', 'Cloudflare'],
  ])('offers Sign in with %s first, like Notion, and its token beside it', async (id, name) => {
    const user = userEvent.setup();
    renderApp(`/connections?connection=${id}`, fixtureServices({ connectors: 'connected' }));
    const group = await screen.findByRole('group', { name: 'How Whombat signs in' });
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios[0]?.checked).toBe(true);
    expect(radios[0]?.closest('label')?.textContent).toContain(`Sign in with ${name}`);
    expect(screen.getByRole('button', { name: `Continue to ${name}` })).toBeTruthy();
    // The token made by hand is the other choice, with its own field.
    await user.click(radios[radios.length - 1] as HTMLElement);
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
  });
});
