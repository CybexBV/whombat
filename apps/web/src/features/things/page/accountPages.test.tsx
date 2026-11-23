/**
 * An account's own page (session minor 7): Google, Email, GitHub and Website feedback open on their Summary, with
 * their mark in the head, and their Connection tab is that account's own settings page, drawn inside the page: no way
 * back and no logo-and-name header of its own, then What Whombat watches.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../../test/renderApp';

const page = (thing: string, tab = '') => `/things/${encodeURIComponent(thing)}${tab}`;

/** The page's Connection tab, once the page answered. */
async function panel() {
  return within(await screen.findByRole('tabpanel', { name: 'Connection' }, { timeout: 12_000 }));
}

describe('an account’s page', () => {
  it('draws Google’s own settings as its Connection tab, and asks nothing about what it runs on', async () => {
    renderApp(page('connection:con_mara', '?tab=settings'), fixtureServices({ connectors: 'connected' }));
    const tab = await panel();
    expect(await tab.findByText('mara@burrowhq.example')).toBeTruthy();
    expect(tab.getByRole('list', { name: 'Services' })).toBeTruthy();
    expect(tab.getByRole('button', { name: 'Check again' })).toBeTruthy();
    // Embedded: the page's head names it; no way back and no header of the Settings page.
    expect(screen.queryByRole('link', { name: '← Overview' })).toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: 'Google' })).toBeNull();
    expect(await tab.findByText('What Whombat watches')).toBeTruthy();
    const head = screen.getByRole('heading', { level: 1, name: 'Google' });
    expect(head).toBeTruthy();
    expect(document.querySelector('[data-mark="google"]')).toBeTruthy();
    // An account's address is its mail address: it runs on nothing of the person's.
    expect(screen.queryByRole('button', { name: 'What does it run on?' })).toBeNull();
  });

  it('opens Email’s Settings page once it is disconnected from its Connection tab', async () => {
    const user = userEvent.setup();
    const app = renderApp(
      page('connection:con_mail_mara_fastmail_com', '?tab=settings'),
      fixtureServices({ connectors: 'connected' }),
    );
    const tab = await panel();
    const account = within(await tab.findByRole('region', { name: 'YOUR ACCOUNT' }));
    expect(await account.findByText('mara@fastmail.com')).toBeTruthy();
    expect(document.querySelector('[data-mark="imap"]')).toBeTruthy();
    await user.click(account.getByRole('button', { name: 'Disconnect' }));
    await user.click(account.getByRole('button', { name: 'Disconnect email' }));
    await waitFor(() => expect(app.location()).toBe('/connections?connection=imap'));
    expect(await screen.findByLabelText('EMAIL ADDRESS')).toBeTruthy();
  });

  it.each([
    ['connection:github', 'github', 'REPOSITORIES'],
    ['connection:feedback', 'feedback', 'INTEGRATIONS'],
  ])(
    'draws %s’s own settings as its Connection tab, with its mark in the head',
    async (thing, mark, section) => {
      renderApp(page(thing, '?tab=settings'), fixtureServices());
      const tab = await panel();
      expect(await tab.findByText(section)).toBeTruthy();
      expect(await tab.findByText('What Whombat watches')).toBeTruthy();
      expect(document.querySelector(`main [data-mark="${mark}"]`)).toBeTruthy();
    },
  );
});
