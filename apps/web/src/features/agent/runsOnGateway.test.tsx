/**
 * RUNS ON while the burrow sends the agent's tool through Fusebox (Whombat ai-gateway.md AIG-17; AP-1121): the agent on
 * Claude (Settings → Advanced → Model and effort, one-agent.md AP-4927), in the fixture world with the gateway (gatewayFixtures.ts: Claude Code switched on, Codex off).
 * “Runs on Fusebox” and why, the person's own sign-in for when the switch is off; the same on a self-hosted server that
 * doesn't serve sign-ins.
 */
import { screen, within } from '@testing-library/react';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { createFakeAi } from '../../managed/fake/ai';
import { mockedServices, renderApp } from '../../test/renderApp';

const NOTE = /^Every Claude Code turn on this Whombat goes through Fusebox\./;
const MODEL = '/settings?tab=advanced&part=model';

/** The agent on `provider`; `signIns: false` is a self-hosted server without `signins.*`. */
function server({ provider = 'claude', signIns = true }: { provider?: string; signIns?: boolean } = {}) {
  const base = createWebFixtureFetch({
    ai: createFakeAi({ installed: { claude: '2.1.278' } }),
    gateway: 'fusebox',
  });
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    const path = url.pathname.replace('/api/v1', '');
    if (!signIns && path.startsWith('/sign-ins'))
      return Response.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 });
    const res = await base(new Request(url, init), init);
    if ((init?.method ?? 'GET') === 'GET' && path === `/burrows/${burrow.slug}/agent` && res.ok) {
      const data = (await res.json()) as { agent: { runtime: Record<string, unknown> } };
      data.agent.runtime = { ...data.agent.runtime, provider };
      return Response.json(data);
    }
    return res;
  }) as unknown as typeof globalThis.fetch;
}

describe('RUNS ON through Fusebox (AIG-17)', () => {
  it('says “Runs on Fusebox” and why, and the own sign-in for later', async () => {
    renderApp(MODEL, mockedServices(server()));
    const runsOn = await screen.findByRole('region', { name: 'RUNS ON' });
    expect(await within(runsOn).findByText('Runs on Fusebox')).toBeTruthy();
    expect(within(runsOn).getByText(NOTE)).toBeTruthy();
    expect(within(runsOn).getByText(/^When it’s off: Your own Claude sign-in/)).toBeTruthy();
    // Nobody's own sign-in answers while it is on: no “sign in first”.
    expect(within(runsOn).queryByRole('status')).toBeNull();
  });

  it('shows it on a self-hosted server that doesn’t serve sign-ins too', async () => {
    renderApp(MODEL, mockedServices(server({ signIns: false })));
    const runsOn = await screen.findByRole('region', { name: 'RUNS ON' });
    expect(await within(runsOn).findByText('Runs on Fusebox')).toBeTruthy();
    expect(within(runsOn).getByText(NOTE)).toBeTruthy();
  });
});
