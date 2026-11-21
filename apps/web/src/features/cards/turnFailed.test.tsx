import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TurnFailedCard as TurnFailedCardData } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch, FIXTURE_BASE_URL } from '../../app/fixtureFetch';
import { ASSISTANT_NAME } from '../../app/oneFixtures';
import { renderChatCards } from '../../test/chatCards';
import { fixtureServices, mockedServices } from '../../test/renderApp';
import { TurnFailedCard } from './TurnFailedCard';
import { retryFailureText, turnFailureFix } from './turnFailed';

const card: TurnFailedCardData = {
  kind: 'turn_failed',
  dispatchId: 'dsp_failed',
  agentId: 'prn_dusty',
  code: 'usage_limit',
  reason:
    'I stopped because the Claude usage limit was reached. It resets at 16:00; press Try again after that.',
  retriedAt: null,
  retryDispatchId: null,
};

describe('the turn_failed card (essentials item 4, AP-480)', () => {
  it('says why in the failure’s label and sentence, and offers Try again to who may wake the agent', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <TurnFailedCard
        card={card}
        agentName={ASSISTANT_NAME}
        canRetry
        onRetry={onRetry}
        timeZone="Europe/Amsterdam"
      />,
    );
    const region = screen.getByRole('region', { name: `${ASSISTANT_NAME} couldn’t finish` });
    expect(within(region).getByText('USAGE LIMIT')).toBeTruthy();
    expect(within(region).getByText(card.reason)).toBeTruthy();
    await user.click(within(region).getByRole('button', { name: `Try again: ${ASSISTANT_NAME}` }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows no button to someone who may not wake the agent, and “Tried again · 14:32” once retried', () => {
    const { rerender } = render(
      <TurnFailedCard card={card} agentName={ASSISTANT_NAME} canRetry={false} timeZone="Europe/Amsterdam" />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    rerender(
      <TurnFailedCard
        card={{ ...card, retriedAt: '2026-09-30T12:32:00.000Z', retryDispatchId: 'dsp_retry' }}
        agentName={ASSISTANT_NAME}
        canRetry
        timeZone="Europe/Amsterdam"
        showReason={false}
      />,
    );
    expect(screen.getByText('Tried again · 14:32')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    // The message's own text already says it: the card doesn't repeat it.
    expect(screen.queryByText(card.reason)).toBeNull();
  });

  it('links a sign-in failure to Settings → AI, and says why a retry didn’t happen', () => {
    expect(turnFailureFix('signin')).toEqual({
      href: '/settings?tab=agent&part=ai',
      label: 'See the AI sign-in',
    });
    expect(turnFailureFix('timeout')).toBeNull();
    expect(retryFailureText({ status: 'blocked', message: 'Neo is switched off.' })).toBe(
      'Neo is switched off.',
    );
    expect(retryFailureText(new Error('offline'))).toBe(
      'Couldn’t reach Whombat. Nothing changed, try again.',
    );
  });

  it('tries again from Chat: the card says “Tried again” at once', async () => {
    const user = userEvent.setup();
    renderChatCards(fixtureServices({ essentialsSettings: true }));
    const region = await screen.findByRole('region', { name: `${ASSISTANT_NAME} couldn’t finish` });
    expect(within(region).getByText('NOT SIGNED IN')).toBeTruthy();
    expect(within(region).getByRole('link', { name: 'See the AI sign-in' }).getAttribute('href')).toBe(
      '/settings?tab=agent&part=ai',
    );
    await user.click(within(region).getByRole('button', { name: `Try again: ${ASSISTANT_NAME}` }));
    expect(await screen.findByText(`Asked ${ASSISTANT_NAME} to try again.`)).toBeTruthy();
    // Retried, the card settles into its line (card-settle AP-730): it opens the card, which says when.
    const line = await screen.findByRole('region', { name: `${ASSISTANT_NAME} couldn’t finish` });
    await waitFor(() => expect(line.dataset.variant).toBe('line'));
    expect(line.textContent).toMatch(/^Turn failed · Tried again at \d\d:\d\d$/);
    await user.click(within(line).getByRole('button', { name: 'Show card' }));
    const card = within(line).getByRole('region', { name: `${ASSISTANT_NAME} couldn’t finish` });
    expect(within(card).getByText(/^Tried again · \d\d:\d\d$/)).toBeTruthy();
    expect(within(card).queryByRole('button', { name: `Try again: ${ASSISTANT_NAME}` })).toBeNull();
  });
  it('shows the runtime’s refusal on the card and offers it no more (409: the person left)', async () => {
    const user = userEvent.setup();
    const world = createWebFixtureFetch({ essentialsSettings: true });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), FIXTURE_BASE_URL);
      if (url.pathname.endsWith('/dispatches/dsp_agent-signin-failed/retry'))
        return new Response(
          JSON.stringify({
            error: { code: 'conflict', message: 'Mara left, so nobody can ask again.' },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
      return world(url.toString(), init);
    });
    renderChatCards(mockedServices(fetch as typeof globalThis.fetch));
    const region = await screen.findByRole('region', { name: `${ASSISTANT_NAME} couldn’t finish` });
    await user.click(within(region).getByRole('button', { name: `Try again: ${ASSISTANT_NAME}` }));
    expect(await within(region).findByRole('alert')).toHaveProperty(
      'textContent',
      'Mara left, so nobody can ask again.',
    );
    expect(within(region).queryByRole('button', { name: `Try again: ${ASSISTANT_NAME}` })).toBeNull();
  });
});
