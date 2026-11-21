/**
 * The AI gateway's pool in Settings → Advanced → AI on this Whombat (Whombat ai-gateway.md AIG-13, settings-groups.md
 * AP-1120), against the fixture world's
 * gateway (gatewayFixtures.ts): Fusebox read 1 min before the mock world's moment, Claude Code switched on and ChatGPT off;
 * work@lumio.example.org on Max at 62 % of its 5-hour window, john@lumio.example.org used up until Monday 09:00, ops@lumio.example.org busy until
 * 14:05 and old@lumio.example.org off in Fusebox. Its section comes first, under the gateway's name; a generic gateway only says
 * whether it answers; a Whombat without `ai.gateway` shows none. Your own sign-ins are the assistant's AI sign-in: the
 * pool isn't there.
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { pinMockDate } from '../../test/clock';
import { fixtureServices, renderApp } from '../../test/renderApp';

pinMockDate();

const USAGE = '/settings?tab=advanced&part=ai';

describe('the AI gateway’s pool in Usage (AIG-13)', () => {
  it('shows Fusebox’s accounts by provider, with their plans, states and meters', async () => {
    renderApp(USAGE, fixtureServices({ gateway: 'fusebox' }));
    const section = await screen.findByRole('region', { name: 'FUSEBOX' });
    expect(within(section).getByText('Updated 1 min ago')).toBeTruthy();

    const claude = within(section).getByRole('article', { name: 'Claude' });
    expect(within(claude).getByText('Claude Code turns go through Fusebox')).toBeTruthy();
    const work = claude.querySelector('[data-gateway-account="acct_claude_work"]') as HTMLElement;
    expect(within(work).getByText('work@lumio.example.org')).toBeTruthy();
    expect(within(work).getByText('Max plan')).toBeTruthy();
    expect(
      within(work).getByRole('meter', { name: 'work@lumio.example.org, Claude 5-hour usage' }),
    ).toBeTruthy();
    expect(within(work).getAllByRole('meter')).toHaveLength(3);
    const john = claude.querySelector('[data-gateway-account="acct_claude_john"]') as HTMLElement;
    expect(john.textContent).toContain('Max plan · Used up until Monday 09:00');
    expect(within(john).getByText('Limit reached')).toBeTruthy();

    const chatgpt = within(section).getByRole('article', { name: 'ChatGPT' });
    expect(within(chatgpt).getByText('ChatGPT turns don’t go through Fusebox')).toBeTruthy();
    expect(chatgpt.textContent).toContain('Pro plan · Busy until 14:05');
    const old = chatgpt.querySelector('[data-gateway-account="acct_codex_old"]') as HTMLElement;
    expect(old.textContent).toContain('Plus plan · Off in Fusebox');
    expect(within(old).getByText('Fusebox didn’t report its limits.')).toBeTruthy();
  });

  it('says only whether a generic AI gateway answers', async () => {
    renderApp(USAGE, fixtureServices({ gateway: 'ai_gateway' }));
    const section = await screen.findByRole('region', { name: 'AI GATEWAY' });
    expect(within(section).getByText('Updated 1 min ago')).toBeTruthy();
    expect(within(section).getByText('AI gateway is answering')).toBeTruthy();
    expect(
      within(section).getByText(
        'Claude Code turns go through AI gateway · ChatGPT turns don’t go through AI gateway',
      ),
    ).toBeTruthy();
    expect(within(section).queryByRole('meter')).toBeNull();
  });

  it('leaves the pool out of the assistant’s AI sign-in', async () => {
    renderApp('/settings?tab=agent&part=ai', fixtureServices({ gateway: 'fusebox' }));
    await screen.findByRole('region', { name: 'YOUR AI SIGN-INS' });
    expect(screen.queryByRole('region', { name: 'FUSEBOX' })).toBeNull();
  });
});
