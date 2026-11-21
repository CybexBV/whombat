/**
 * The automation plan card in Chat (docs/app/decisions/automation-chat.md) over the fixture world's plans
 * (`automationFixtures.ts`): what it shows, Turn it on, Keep the old one, the lines decided plans settle into, and a
 * refusal in the server's words.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { burrow } from '@whombat/fixtures';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PLAN_IDS, PLAN_THREADS } from '../../app/automationFixtures';
import { ASSISTANT_NAME } from '../../app/oneFixtures';
import { recordingWorld } from '../../test/recordingWorld';
import { mockedServices, renderApp } from '../../test/renderApp';

const B = `/burrows/${burrow.slug}`;
const WEB_PRS = 'New pull requests on whombat/web';
const BILLING = 'Assess new issues and pull requests on whombat/billing';

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const world = () => recordingWorld({ automations: true });

describe('the plan card in Chat', () => {
  const card = async () =>
    (await screen.findByText('NEW AUTOMATION · WAITING FOR YOU')).closest('[data-card]') as HTMLElement;

  it('shows a new automation in Whombat’s words and turns it on', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = world();
    renderApp(`/chat?thread=${PLAN_THREADS.webPrs}&focus=1`, mockedServices(fetch));
    const plan = await card();
    expect(within(plan).getByRole('heading', { name: WEB_PRS })).toBeTruthy();
    expect(
      within(plan)
        .getAllByRole('term')
        .map((t) => t.textContent),
    ).toEqual(['WHEN', ASSISTANT_NAME.toUpperCase(), 'ASKS YOU', 'POSTS', 'LIMIT']);
    expect((plan.querySelector('[data-plan-fold="thinking"]') as HTMLDetailsElement).open).toBe(true);
    expect((plan.querySelector('[data-plan-fold="prompts"]') as HTMLDetailsElement).open).toBe(false);
    expect(within(plan).getByText('or reply to change it')).toBeTruthy();
    // The newest pull request of whombat/web to try it on.
    expect(await within(plan).findByRole('button', { name: 'Try it on #212' })).toBeTruthy();
    await user.click(within(plan).getByRole('button', { name: 'Turn it on' }));
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({
        method: 'POST',
        path: `${B}/automation-plans/${PLAN_IDS.webPrs}/accept`,
        body: undefined,
      }),
    );
    expect(await screen.findByText(`“${WEB_PRS}” is on.`)).toBeTruthy();
    const line = await screen.findByRole('region', { name: `Automation plan: ${WEB_PRS}` });
    expect(within(line).getByText(`You turned on “${WEB_PRS}”`)).toBeTruthy();
  });

  it('a change lists what changes; the plans before it settled into lines; Keep the old one sets it aside', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = world();
    renderApp(`/chat?thread=${PLAN_THREADS.billing}&focus=1`, mockedServices(fetch));
    const change = (await screen.findByText('CHANGE · WAITING FOR YOU')).closest(
      '[data-card]',
    ) as HTMLElement;
    const what = within(change).getByRole('list', { name: 'WHAT CHANGES' });
    expect(what.querySelectorAll('[data-plan-change="added"]').length).toBeGreaterThan(0);
    expect(within(change).getByRole('button', { name: 'Use this version' })).toBeTruthy();
    expect(screen.getAllByText('Replaced by a newer plan').length).toBeGreaterThan(0);
    expect(screen.getByText(`You turned on “${BILLING}”`)).toBeTruthy();
    await user.click(within(change).getByRole('button', { name: 'Keep the old one' }));
    await waitFor(() =>
      expect(calls.at(-1)?.path).toBe(`${B}/automation-plans/${PLAN_IDS.billingChange}/decline`),
    );
    expect(await screen.findByText('The old version keeps running.')).toBeTruthy();
    expect(await screen.findByText(`Not now: “${BILLING}”`)).toBeTruthy();
  });

  it('a refusal shows the server’s words', async () => {
    const user = userEvent.setup();
    const { fetch } = recordingWorld({ automations: true }, async (call, res) =>
      call.path.endsWith('/accept')
        ? new Response(
            JSON.stringify({
              error: { code: 'conflict', message: 'A newer plan replaced this one: use that one.' },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          )
        : res,
    );
    renderApp(`/chat?thread=${PLAN_THREADS.webPrs}&focus=1`, mockedServices(fetch));
    await user.click(within(await card()).getByRole('button', { name: 'Turn it on' }));
    expect(await screen.findByText('A newer plan replaced this one: use that one.')).toBeTruthy();
  });
});
