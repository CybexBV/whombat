/**
 * A password Whombat signs in with for a session (Pi-hole, Nginx Proxy Manager; Synology and QNAP, Whombat desk-found.md
 * NS-02…NS-04; AP-3805, AP-3806) against the fixture world, which refuses the passwords `wrong`, `disabled`, `denied`,
 * `2fa`, `locked` and `expired` in the entry's words: the form says why, and never calls the password a token.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../test/renderApp';

describe('a session’s refused password (NS-04, AP-3805)', () => {
  it('says why Pi-hole refused it, and doesn’t name a token', async () => {
    const user = userEvent.setup();
    renderApp(
      '/connections?connection=pihole&url=http://10.0.0.53',
      fixtureServices({ connectors: 'connected' }),
    );
    const password = await screen.findByLabelText('APP PASSWORD');
    await user.type(password, '2fa');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('two-step');
    expect(alert.textContent).toContain('Pi-hole');
    expect(alert.textContent).not.toMatch(/token/i);
    // The only sign-in is the one tried: nothing to switch to.
    expect(screen.queryByRole('button', { name: /instead$/ })).toBeNull();
  });
});

describe('Synology DSM and QNAP’s connect form (NS-01…NS-04, AP-3806, AP-3807)', () => {
  it('asks where it is, the account and its password, trusts its own certificate, and says why DSM refused', async () => {
    const user = userEvent.setup();
    renderApp(
      '/connections?connection=synology&url=https://synology.local:5001',
      fixtureServices({ connectors: 'connected' }),
    );
    // Identified on its own certificate on the home network: trusted at once, with Undo.
    expect(await screen.findByText('Whombat trusts this certificate and only this one.')).toBeTruthy();
    await user.type(screen.getByLabelText('ACCOUNT'), 'whombat');
    await user.type(screen.getByLabelText('PASSWORD'), 'locked');
    // The steps make a user; a password the person chose has nothing to paste.
    expect(screen.getByRole('list', { name: 'Making a user for Whombat' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /^Paste what/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Allow/Block List');
    expect(alert.textContent).not.toMatch(/token/i);
  });

  it('connects QNAP once the password is right', async () => {
    const user = userEvent.setup();
    const app = renderApp(
      '/connections?connection=qnap&url=https://qnap.local',
      fixtureServices({ connectors: 'connected' }),
    );
    expect(await screen.findByText('Whombat trusts this certificate and only this one.')).toBeTruthy();
    await user.type(screen.getByLabelText('ACCOUNT'), 'whombat');
    await user.type(screen.getByLabelText('PASSWORD'), 'a long one');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(app.location()).toMatch(/con_fixture_/));
  });
});
