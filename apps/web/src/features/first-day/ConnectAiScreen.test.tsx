/**
 * Connect your AI, the claim's third step (Whombat first-day.md), against the fixture world's fake AI: asked while
 * nothing is ready, the sign-in rows of Settings → AI once a provider is picked, Later and Continue into the Whombat,
 * and straight on when a provider is ready already.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import type { FakeAiOptions } from '../../managed/fake/ai';
import { mockedServices, renderApp } from '../../test/renderApp';

function services(ai: FakeAiOptions, extra: Parameters<typeof mockedServices>[1] = {}) {
  const base = createWebFixtureFetch({ ai });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    return base(new Request(url, init), init);
  }) as unknown as typeof globalThis.fetch;
  return mockedServices(fetch, extra);
}

describe('Connect your AI (first-day.md)', () => {
  it('asks while nothing is signed in; a pick shows its sign-in; Later opens the Whombat', async () => {
    const user = userEvent.setup();
    const { history } = renderApp(
      '/connect-ai',
      services({ installed: { claude: '2.1.278' }, signedIn: [] }),
    );
    expect(await screen.findByRole('heading', { name: 'Connect your AI' })).toBeTruthy();
    expect(screen.getByText('CLAIM · STEP 3 OF 3')).toBeTruthy();
    // Nothing is signed in to until a provider is picked.
    expect(screen.queryByRole('region', { name: 'ChatGPT' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Use ChatGPT' }));
    expect(await screen.findByRole('region', { name: 'ChatGPT' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Later' }));
    await waitFor(() => expect(history.location.pathname).toBe('/chat'));
  });

  it('on the box’s own page carries on the box setup’s count', async () => {
    renderApp(
      '/connect-ai',
      services(
        { installed: { claude: '2.1.278' }, signedIn: [] },
        {
          managed: {
            applianceId: 'box',
            applianceName: null,
            deviceFingerprint: 'aaaaa',
            appliancePeerId: 'peer',
            applianceFingerprint: 'bbbbb',
            kitPending: false,
            signOut: () => {},
            switchAppliance: () => {},
            page: { kind: 'box', secure: true },
          },
        },
      ),
    );
    expect(await screen.findByRole('heading', { name: 'Connect your AI' })).toBeTruthy();
    expect(screen.getByText('STEP 6 OF 7')).toBeTruthy();
    expect(screen.queryByText('CLAIM · STEP 3 OF 3')).toBeNull();
  });

  it('opens the Whombat at once when a provider is ready already', async () => {
    const { history } = renderApp(
      '/connect-ai',
      services({ installed: { claude: '2.1.278' }, signedIn: [{ provider: 'codex', authMode: 'chatgpt' }] }),
    );
    await waitFor(() => expect(history.location.pathname).toBe('/chat'));
    expect(screen.queryByRole('heading', { name: 'Connect your AI' })).toBeNull();
  });
});
