import { screen, within } from '@testing-library/react';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { createFakeAi, type FakeAi } from '../../managed/fake/ai';
import { mockedServices, renderApp } from '../../test/renderApp';

/** Settings → Advanced → Model and effort (one-agent.md AP-4927). */
const MODEL = '/settings?tab=advanced&part=model';

/** RUNS ON (CT-69, OP-09) on a server where the person signs in here (it serves `signins.*`): the agent on Claude. */
function server(ai: FakeAi) {
  const base = createWebFixtureFetch({ ai });
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    const path = url.pathname.replace('/api/v1', '');
    const res = await base(new Request(url, init), init);
    if ((init?.method ?? 'GET') === 'GET' && path === `/burrows/${burrow.slug}/agent` && res.ok) {
      const data = (await res.json()) as { agent: { runtime: Record<string, unknown> } };
      data.agent.runtime = { ...data.agent.runtime, provider: 'claude' };
      return Response.json(data);
    }
    return res;
  }) as unknown as typeof globalThis.fetch;
}

describe('RUNS ON: the person’s own sign-in (CT-1503, OP-09; AP-5692)', () => {
  it('names the person’s own sign-in, and tells them how to sign in when they haven’t', async () => {
    const ai = createFakeAi({ installed: { claude: '2.1.278' } });
    renderApp(MODEL, mockedServices(server(ai)));
    const runsOn = await screen.findByRole('region', { name: 'RUNS ON' });
    expect(within(runsOn).getByText(/Your own Claude sign-in/)).toBeTruthy();
    const notice = await within(runsOn).findByRole('status');
    expect(notice.textContent).toContain('Claude');
    expect(within(notice).getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(
      `/settings?tab=agent&part=ai`,
    );
    // Nothing to choose: no Change, no organization keys, no sign-in to share.
    expect(within(runsOn).queryByRole('button')).toBeNull();
  });

  it('says nothing about signing in once the person has', async () => {
    const ai = createFakeAi({
      installed: { claude: '2.1.278' },
      signedIn: [{ provider: 'claude', authMode: 'subscription_cli' }],
    });
    renderApp(MODEL, mockedServices(server(ai)));
    const runsOn = await screen.findByRole('region', { name: 'RUNS ON' });
    await within(runsOn).findByText(/Your own Claude sign-in/);
    await new Promise((r) => setTimeout(r, 50));
    expect(within(runsOn).queryByRole('status')).toBeNull();
  });
});
