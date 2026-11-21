/**
 * Fusebox, the burrow's AI gateway (Whombat ai-gateway.md AIG-01…AIG-06; AP-1117…AP-1119), against the fixture world's
 * gateway (gatewayFixtures.ts: Fusebox at 10.100.0.235:8317 with Claude Code switched on and ChatGPT off, read 1 min ago):
 * its row says which tools go through it; its page has no agents' parts but which tools use it, the pool's line and a
 * switch per tool, Fusebox's asking first with the terms; Remove says what the server says;
 * a second gateway is refused; without `ai.gateway` there is no tile and no switch.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { pinMockDate } from '../../test/clock';
import { fixtureServices, renderApp } from '../../test/renderApp';

pinMockDate();

const PAGE = '/connections?connection=fusebox&id=con_fixture_fusebox';
const world = () => fixtureServices({ connectors: 'connected', gateway: 'fusebox' });
const TERMS =
  'Fusebox can share Claude and ChatGPT subscriptions between people. Anthropic’s terms say “Each end user must authenticate with their own … credentials”, and OpenAI asks people not to share a ChatGPT sign-in. Either can limit or suspend those accounts.';

const switchOf = (name: string) => screen.getByRole('switch', { name }) as HTMLButtonElement;

describe('Fusebox, the burrow’s AI gateway (AIG-01…AIG-06)', () => {
  it('lists its row with its address only, and offers Fusebox and the AI gateway (AP-1177)', async () => {
    renderApp('/settings?tab=connections', world());
    const connected = await screen.findByRole('region', { name: 'APPS AND SERVICES' });
    const row = await within(connected).findByRole('link', { name: /^Fusebox/ });
    expect(within(row).getByText('10.100.0.235:8317')).toBeTruthy();
    // Which tools go through it is on its page.
    expect(row.textContent).not.toMatch(/tools?|Look only|Used by automations|Connected by|go through/);
    // Their tiles are on Add a connection (AP-1163).
    await userEvent
      .setup()
      .click(
        screen
          .getAllByRole('link', { name: 'Add a connection' })
          .find((l) => !l.closest('[aria-label="Sidebar"]')) as HTMLElement,
      );
    await screen.findByRole('link', { name: 'Connect Home Assistant' });
    expect(document.querySelector('[data-provider="fusebox"]')?.textContent).toContain(
      'Send Claude Code and ChatGPT through Fusebox and see what’s left on its subscriptions.',
    );
    expect(document.querySelector('[data-provider="ai_gateway"]')).toBeTruthy();
  });

  it('shows its page without the agents’ parts: which tools use it, the pool’s line and the switches', async () => {
    renderApp(PAGE, world());
    // The Settings address opens the Settings tab of its own page (connection-pages.md CP-01), named in its head.
    expect(
      await screen.findByRole('heading', { name: 'Fusebox', level: 1 }, { timeout: 12_000 }),
    ).toBeTruthy();
    const card = (await screen.findByRole('region', { name: 'CONNECTION' })) as HTMLElement;
    expect(await within(card).findByText('Updated 1 min ago')).toBeTruthy();
    const used = card.querySelector('[data-block="used-by-gateway"]') as HTMLElement;
    expect(within(used).getByText('Used by Claude Code')).toBeTruthy();
    expect(within(used).getByText(/^Claude Code turns go through it/)).toBeTruthy();
    expect(within(card).queryByText(/CALLS IT$/)).toBeNull();
    expect(within(card).queryByText(/MAY DO$/)).toBeNull();
    expect(within(card).queryByText(/ calls it /)).toBeNull();
    expect(screen.queryByRole('region', { name: 'TOOLS' })).toBeNull();

    const switches = screen.getByRole('region', { name: 'CLAUDE CODE AND CODEX' });
    expect(within(switches).getByText('Send Claude Code through Fusebox')).toBeTruthy();
    expect(within(switches).getByText(/^Every ChatGPT turn .*Fusebox.* Off: /)).toBeTruthy();
    expect(switchOf('Send Claude Code through Fusebox').getAttribute('aria-checked')).toBe('true');
    expect(switchOf('Send ChatGPT through Fusebox').getAttribute('aria-checked')).toBe('false');
    // Its management key is replaced like any token.
    expect(screen.getByRole('button', { name: 'Replace token' })).toBeTruthy();
  });

  it('asks before ChatGPT goes through Fusebox, with the terms; Cancel leaves it off (AIG-06)', async () => {
    const user = userEvent.setup();
    renderApp(PAGE, world());
    await screen.findByRole('region', { name: 'CLAUDE CODE AND CODEX' });
    await user.click(switchOf('Send ChatGPT through Fusebox'));
    let dialog = await screen.findByRole('dialog', { name: 'Send ChatGPT through Fusebox?' });
    expect(within(dialog).getByText(TERMS)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(switchOf('Send ChatGPT through Fusebox').getAttribute('aria-checked')).toBe('false');

    await user.click(switchOf('Send ChatGPT through Fusebox'));
    dialog = await screen.findByRole('dialog', { name: 'Send ChatGPT through Fusebox?' });
    await user.click(within(dialog).getByRole('button', { name: 'Send through Fusebox' }));
    expect(await screen.findByText('ChatGPT turns now go through Fusebox.')).toBeTruthy();
    await waitFor(() =>
      expect(switchOf('Send ChatGPT through Fusebox').getAttribute('aria-checked')).toBe('true'),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('Used by Claude Code and ChatGPT')).toBeTruthy();
  });

  it('switches one off at once, without asking', async () => {
    const user = userEvent.setup();
    renderApp(PAGE, world());
    await screen.findByRole('region', { name: 'CLAUDE CODE AND CODEX' });
    await user.click(switchOf('Send Claude Code through Fusebox'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('Claude Code runs on its own sign-in again.')).toBeTruthy();
    await waitFor(() =>
      expect(switchOf('Send Claude Code through Fusebox').getAttribute('aria-checked')).toBe('false'),
    );
    expect(await screen.findByText('Not switched on yet')).toBeTruthy();
  });

  it('says what the server says after Remove when Fusebox couldn’t be told (AIG-03)', async () => {
    const user = userEvent.setup();
    renderApp(PAGE, world());
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(
      screen.getByText('Remove Fusebox? Claude Code and ChatGPT run on your own sign-in again.'),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove Fusebox' }));
    expect(
      await screen.findByText(
        'Fusebox didn’t answer, so remove the client “Whombat · Burrow HQ” there yourself.',
      ),
    ).toBeTruthy();
  });

  it('refuses a second gateway with the server’s words (AIG-01)', async () => {
    const user = userEvent.setup();
    renderApp('/connections?connection=ai_gateway', world());
    const steps = await screen.findByRole('list', { name: 'Connect AI gateway' });
    // Agents never use it: no level to choose.
    expect(within(steps).queryByText(/^What may .* do\?$/)).toBeNull();
    await user.type(screen.getByLabelText(/^ADDRESS/i), 'https://llm.lumio.example.org');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await within(steps).findByText('How should Whombat sign in?')).toBeTruthy();
    await user.type(screen.getByLabelText(/^KEY/), 'sk-litellm');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(
      await screen.findByText(
        'This Whombat already sends its AI through Fusebox. Remove that connection first.',
      ),
    ).toBeTruthy();
  });
});
