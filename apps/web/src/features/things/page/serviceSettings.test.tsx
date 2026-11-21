/**
 * A service's settings on its page (Whombat service-settings.md SST-01…SST-10; mock service-dash-v2 screens 1–3) in the
 * fixture world (`plexSettingsFixtures.ts`): Plex's verdict and tabs, Ask on a card, a switch with Put it back in its
 * toast, the change sheet, and a row's Put it back with the server's refusal when the setting changed again since.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../../test/renderApp';

const PLEX = '/things/connection%3Acon_plex';
const SETTINGS = `${PLEX}?tab=service-settings`;
const world = () => fixtureServices({ services: true, connectors: 'connected' });
const card = async (title: string) =>
  (await screen.findByRole('heading', { name: title, level: 2 }, { timeout: 12_000 })).closest(
    'section',
  ) as HTMLElement;
const row = (within_: HTMLElement, id: string) =>
  within_.querySelector(`[data-setting="${id}"]`) as HTMLElement;
const pageTabs = () => screen.getAllByRole('tab').filter((t) => !t.closest('aside'));
const askBox = async () =>
  within(await screen.findByRole('complementary', { name: 'Ask about Plex' })).getByRole('textbox', {
    name: 'Ask about Plex',
  }) as HTMLTextAreaElement;

describe('a service’s settings (SST-01…SST-10)', () => {
  it('says how Plex is under its name, names the tabs, and asks about a card from its head', async () => {
    renderApp(PLEX, world());
    const playing = await card('Now playing');
    expect(screen.getByText(/^Plex is fine: 3 people are watching and /)).toBeTruthy();
    expect(pageTabs().map((t) => t.textContent)).toEqual([
      'Summary',
      'Plex settings',
      'Activity',
      'Connection',
    ]);

    const user = userEvent.setup();
    const ask = within(playing).getByRole('button', { name: 'Ask Neo about Now playing' });
    await user.click(ask);
    const pop = screen.getByRole('dialog', { name: 'Ask Neo about Now playing' });
    expect(ask.getAttribute('aria-expanded')).toBe('true');
    // Focus goes into it; Escape closes it and gives focus back to Ask.
    expect(document.activeElement?.textContent).toBe('Why is Severance converting on iPad?');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Ask Neo about Now playing' })).toBeNull();
    expect(document.activeElement).toBe(ask);

    await user.click(ask);
    await user.click(
      within(screen.getByRole('dialog', { name: 'Ask Neo about Now playing' })).getByRole('button', {
        name: 'Who watched the most this week?',
      }),
    );
    expect((await askBox()).value).toBe('Who watched the most this week?');
    expect(pop.isConnected).toBe(false);
  });

  it('flips a switch at once, says what Plex says, and puts it back from the toast', async () => {
    renderApp(SETTINGS, world());
    const away = await card('Watching away from home');
    const user = userEvent.setup();
    const remote = within(row(away, 'remote_access')).getByRole('switch', { name: 'Remote access' });
    expect(remote.getAttribute('aria-checked')).toBe('true');
    await user.click(remote);
    expect(remote.getAttribute('aria-checked')).toBe('false');
    expect(within(row(away, 'remote_access')).getByText('Off')).toBeTruthy();
    expect(await screen.findByText('Plex is now only for your home. Checked with Plex.')).toBeTruthy();
    // The row says who changed it, with Put it back, once the page is read again.
    await waitFor(() =>
      expect(within(row(away, 'remote_access')).getByText(/^You changed this today/)).toBeTruthy(),
    );

    await user.click(screen.getByRole('button', { name: 'Put it back' }));
    expect(await screen.findByText('Put back.')).toBeTruthy();
    await waitFor(() =>
      expect(
        within(row(away, 'remote_access'))
          .getByRole('switch', { name: 'Remote access' })
          .getAttribute('aria-checked'),
      ).toBe('true'),
    );
  });

  it('changes a setting in its sheet, and asks Neo instead from it', async () => {
    renderApp(SETTINGS, world());
    const away = await card('Watching away from home');
    const user = userEvent.setup();
    const quality = row(away, 'remote_quality');
    expect(within(quality).getByText('Up to 8 Mbps')).toBeTruthy();
    await user.click(within(quality).getByRole('button', { name: 'Change Quality outside your home' }));
    const sheet = await screen.findByRole('dialog', { name: 'Quality outside your home' });
    const now = within(sheet).getByRole('radio', { name: /^8 Mbps/ });
    expect((now as HTMLInputElement).checked).toBe(true);
    expect(now.closest('label')?.textContent).toContain('Now');
    expect(within(sheet).getByText(/^Your upload is about 40 Mbps/)).toBeTruthy();
    const change = within(sheet).getByRole('button', { name: 'Change it' }) as HTMLButtonElement;
    expect(change.disabled).toBe(true);
    await user.click(within(sheet).getByRole('radio', { name: /^20 Mbps/ }));
    expect(change.disabled).toBe(false);
    await user.click(change);
    expect(
      await screen.findByText('Plex now allows up to 20 Mbps outside your home. Checked with Plex.'),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Quality outside your home' })).toBeNull(),
    );
    await waitFor(() => expect(within(row(away, 'remote_quality')).getByText('Up to 20 Mbps')).toBeTruthy());

    await user.click(
      within(row(away, 'remote_quality')).getByRole('button', { name: 'Change Quality outside your home' }),
    );
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Quality outside your home' })).getByRole('button', {
        name: 'Ask Neo instead',
      }),
    );
    expect((await askBox()).value).toBe('Help me choose Quality outside your home for Plex.');
  });

  it('puts a setting back from its row, and refuses when it was changed again since', async () => {
    renderApp(SETTINGS, world());
    const away = await card('Watching away from home');
    const user = userEvent.setup();
    // Neo raised it yesterday: the row says so and offers Put it back.
    expect(
      within(row(away, 'remote_quality')).getByText('Neo changed this yesterday from 4 Mbps.'),
    ).toBeTruthy();
    await user.click(
      within(row(away, 'remote_quality')).getByRole('button', { name: 'Put Quality outside your home back' }),
    );
    expect(await screen.findByText('Put back.')).toBeTruthy();
    await waitFor(() => expect(within(row(away, 'remote_quality')).getByText('Up to 4 Mbps')).toBeTruthy());

    // Changed twice: the first change's Put it back (its toast) is refused in the server's words.
    const pick = async (choice: RegExp) => {
      await user.click(
        within(row(away, 'remote_quality')).getByRole('button', { name: 'Change Quality outside your home' }),
      );
      const sheet = await screen.findByRole('dialog', { name: 'Quality outside your home' });
      await user.click(within(sheet).getByRole('radio', { name: choice }));
      await user.click(within(sheet).getByRole('button', { name: 'Change it' }));
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Quality outside your home' })).toBeNull(),
      );
    };
    await pick(/^20 Mbps/);
    expect(await screen.findByText(/up to 20 Mbps outside your home/)).toBeTruthy();
    await pick(/^12 Mbps/);
    expect(await screen.findByText(/up to 12 Mbps outside your home/)).toBeTruthy();
    // A toast is its words and its action.
    const first = screen.getByText(/up to 20 Mbps outside your home/);
    await user.click(within(first).getByRole('button', { name: 'Put it back' }));
    expect(
      await screen.findByText(
        'Quality outside your home was changed again since, so Whombat won’t put it back.',
      ),
    ).toBeTruthy();
  });

  it('shows a setting changed in Plex itself as a link there, and Something else? asks Neo', async () => {
    renderApp(SETTINGS, world());
    const upkeep = await card('Upkeep');
    const updates = within(row(upkeep, 'updates')).getByRole('link', { name: /^Updates: change it in Plex/ });
    expect([updates.textContent, updates.getAttribute('target')]).toEqual(['In Plex', '_blank']);
    expect(screen.getByRole('link', { name: 'All settings in Plex' }).getAttribute('target')).toBe('_blank');
    const user = userEvent.setup();
    const more = await card('Something else?');
    await user.click(within(more).getByRole('button', { name: 'Ask Neo' }));
    expect((await askBox()).value).toBe('I’d like to change another Plex setting.');
  });
});
