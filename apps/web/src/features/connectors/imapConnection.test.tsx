import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../test/renderApp';

/** Email (IMAP)'s page (connections-more-web.md AP-2764…); the fixture answers are in `app/connectorFixtures.ts`. */
const IMAP = '/connections?connection=imap';

async function account() {
  return within(await screen.findByRole('region', { name: 'YOUR ACCOUNT' }));
}

describe('Email (IMAP) (Whombat CM-20…CM-22, CM-29)', () => {
  it('finds the servers, says the provider’s hint, refuses a wrong password, then connects', async () => {
    const user = userEvent.setup();
    renderApp(IMAP, fixtureServices({ connectors: 'none' }));
    expect(await screen.findByRole('heading', { name: 'Email (IMAP)' })).toBeTruthy();
    const card = await account();
    await user.type(card.getByLabelText('EMAIL ADDRESS'), 'mara@fastmail.com');
    await user.tab();
    expect(await card.findByText('imap.fastmail.com')).toBeTruthy();
    expect(card.getByText('smtp.fastmail.com')).toBeTruthy();
    expect(card.getByRole('link', { name: /Open Fastmail/ }).getAttribute('href')).toContain('fastmail.com');

    await user.click(card.getByRole('button', { name: 'Change' }));
    expect((card.getByLabelText('Server', { selector: '[id$="imapHost"]' }) as HTMLInputElement).value).toBe(
      'imap.fastmail.com',
    );

    await user.type(card.getByLabelText('PASSWORD'), 'wrong');
    await user.click(card.getByRole('button', { name: 'Connect email' }));
    expect((await card.findByRole('alert')).textContent).toContain('refused the password');

    await user.clear(card.getByLabelText('PASSWORD'));
    await user.type(card.getByLabelText('PASSWORD'), 'app-password');
    await user.click(card.getByRole('button', { name: 'Connect email' }));
    expect(await card.findByText('mara@fastmail.com')).toBeTruthy();
    expect(card.getByText(/imap\.fastmail\.com and smtp\.fastmail\.com/)).toBeTruthy();
    expect(card.getByRole('button', { name: 'Check again' })).toBeTruthy();
  });

  it('opens the server fields with a guess when nothing is found, and says which server it couldn’t reach', async () => {
    const user = userEvent.setup();
    renderApp(IMAP, fixtureServices({ connectors: 'none' }));
    const card = await account();
    await user.type(card.getByLabelText('EMAIL ADDRESS'), 'mara@example.org');
    await user.tab();
    const smtp = (await card.findByLabelText('Server', { selector: '[id$="smtpHost"]' })) as HTMLInputElement;
    expect(smtp.value).toBe('smtp.example.org');
    expect(card.getByText(/couldn’t find your mail servers/)).toBeTruthy();

    await user.clear(smtp);
    await user.type(smtp, 'down.example.org');
    await user.type(card.getByLabelText('PASSWORD'), 'secret');
    await user.click(card.getByRole('button', { name: 'Connect email' }));
    expect((await card.findByRole('alert')).textContent).toContain('down.example.org');
  });

  it('points Gmail at the Google connection', async () => {
    const user = userEvent.setup();
    renderApp(IMAP, fixtureServices({ connectors: 'none' }));
    const card = await account();
    await user.type(card.getByLabelText('EMAIL ADDRESS'), 'mara@gmail.com');
    await user.tab();
    const link = await card.findByRole('link', { name: 'Connect Google instead' });
    expect(link.getAttribute('href')).toContain('connection=google');
  });

  it('disconnects a connected account', async () => {
    const user = userEvent.setup();
    renderApp(IMAP, fixtureServices({ connectors: 'connected' }));
    const card = await account();
    expect(await card.findByText('mara@fastmail.com')).toBeTruthy();
    await user.click(card.getByRole('button', { name: 'Disconnect' }));
    await user.click(card.getByRole('button', { name: 'Disconnect email' }));
    await waitFor(() => expect(card.getByLabelText('EMAIL ADDRESS')).toBeTruthy());
  });

  it('offers Gmail both ways: the Google connection, and an app password for mail only (SG-18d, AP-3915)', async () => {
    const user = userEvent.setup();
    renderApp(IMAP, fixtureServices({ connectors: 'none' }));
    const card = await account();
    await user.type(card.getByLabelText('EMAIL ADDRESS'), 'mara@gmail.com');
    await user.tab();
    const instead = await card.findByRole('link', { name: 'Connect Google instead' });
    expect(instead.getAttribute('href')).toContain('connection=google');
    const appPassword = card.getByRole('link', { name: /Make an app password/ });
    expect(appPassword.getAttribute('href')).toContain('myaccount.google.com/apppasswords');
  });
});
