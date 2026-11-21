/**
 * “Always allow {Agent} to …” on a risk-row approval (Whombat resourceful-agents.md RA-06; contracts CT-246, RA-DC08;
 * AP-680): the card and the modal of a deploy, merge, push to main, outside message or refund offer it on a runtime
 * with `agents.risk_rows`; it approves with `scope: 'agent'` and says that the agent won't ask again. An older runtime
 * shows the card as drawn. The deploy card is the shared
 * world's, in PR #482's branch room, the branch it deploys.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { ASSISTANT_NAME } from '../../app/oneFixtures';
import { mockedServices, renderApp } from '../../test/renderApp';

const B = `/burrows/${burrow.slug}`;
const ROOM = '/pr/482';
const ALWAYS = `Always allow ${ASSISTANT_NAME} to deploy`;
const SAID = `Approved. From now on ${ASSISTANT_NAME} may deploy without asking.`;

/** The fixture world, recording every write. */
function server() {
  const world = createWebFixtureFetch();
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    const req = input instanceof Request ? input : new Request(url, init);
    const path = url.pathname.replace('/api/v1', '');
    if (req.method !== 'GET') {
      const text = await req.clone().text();
      calls.push({ method: req.method, path, body: text ? JSON.parse(text) : undefined });
    }
    return world(req);
  });
  return { fetch, calls };
}

async function deployCard() {
  return screen.findByRole('region', { name: /^Approval: Deploy/ });
}

describe('“Always allow” on a risk-row card (RA-06; AP-680)', () => {
  it('sits between Approve and Details, approves with scope `agent` and says so', async () => {
    const { fetch, calls } = server();
    const user = userEvent.setup();
    renderApp(ROOM, mockedServices(fetch));
    const card = await deployCard();
    const buttons = within(card)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(buttons).toEqual(['Approve in advance', ALWAYS, 'Details']);

    await user.click(within(card).getByRole('button', { name: ALWAYS }));
    await waitFor(() => expect(calls.some((c) => c.path === `${B}/approvals/12/decide`)).toBe(true));
    expect(calls.find((c) => c.path === `${B}/approvals/12/decide`)?.body).toEqual({
      decision: 'approve',
      scope: 'agent',
    });
    expect(await screen.findByText(SAID)).toBeTruthy();
  });

  it('keeps Approve without a scope', async () => {
    const { fetch, calls } = server();
    const user = userEvent.setup();
    renderApp(ROOM, mockedServices(fetch));
    await user.click(within(await deployCard()).getByRole('button', { name: 'Approve in advance' }));
    await waitFor(() => expect(calls.some((c) => c.path === `${B}/approvals/12/decide`)).toBe(true));
    expect(calls.find((c) => c.path === `${B}/approvals/12/decide`)?.body).toEqual({ decision: 'approve' });
  });

  it('shows the modal’s choice above Decline · Approve, and sends it from there', async () => {
    const { fetch, calls } = server();
    const user = userEvent.setup();
    renderApp(`${ROOM}?approval=12`, mockedServices(fetch));
    const dialog = await screen.findByRole('dialog');
    const always = await within(dialog).findByRole('button', { name: ALWAYS });
    expect(within(dialog).getByRole('button', { name: 'Decline' })).toBeTruthy();
    await user.click(always);
    await waitFor(() => expect(calls.some((c) => c.path === `${B}/approvals/12/decide`)).toBe(true));
    expect(calls.find((c) => c.path === `${B}/approvals/12/decide`)?.body).toEqual({
      decision: 'approve',
      scope: 'agent',
    });
    expect(await screen.findByText(SAID)).toBeTruthy();
  });
});
