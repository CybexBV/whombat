import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { queryKeys } from '@whombat/client/query';
import type { ApprovalResponse } from '@whombat/core';
import { APPROVAL_CARD_WORDS } from '@whombat/core/approvals';
import { approval as fixtureApproval } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { createWebFixtureFetch, type WebFixtureOptions } from '../../app/fixtureFetch';
import { ASSISTANT_NAME } from '../../app/oneFixtures';
import { pinMockDate } from '../../test/clock';
import { mockedServices, renderApp } from '../../test/renderApp';

const QUESTION = 'Deploy feat/invoice-pdf to staging?';
const ROOM = '/pr/482';
const MODAL = `${ROOM}?approval=12`;

/** The fixture world: deploy approval #12 in PR #482's room, asked by the agent. */
function services(options: WebFixtureOptions = {}) {
  const world = createWebFixtureFetch(options);
  return mockedServices(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    return world(input instanceof Request ? input : new Request(url, init));
  });
}

async function openModal(url = MODAL) {
  const app = renderApp(url, services());
  const dialog = await screen.findByRole('dialog', { name: QUESTION });
  await within(dialog).findByRole('button', { name: 'Decline' });
  return { app, dialog };
}

function reopen(app: ReturnType<typeof renderApp>) {
  act(() => {
    void app.history.push(MODAL);
  });
}

pinMockDate();

describe('approval modal', () => {
  it('shows who is asking, what happens, the live conditions and the explainer', async () => {
    const { dialog } = await openModal();
    expect(within(dialog).getByText(`${ASSISTANT_NAME.toUpperCase()} IS ASKING`)).toBeTruthy();
    expect(within(dialog).getByRole('img', { name: ASSISTANT_NAME })).toBeTruthy();
    const [steps, conditions] = within(dialog).getAllByRole('list');
    expect(
      within(steps as HTMLElement)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      '01Build 7be20f, the latest commit on feat/invoice-pdf',
      '02Run migrations. There are none in this change.',
      '03Roll billing-api to staging, 2 of 2 pods',
      '04Roll back on its own if errors stay above 1% for 5 minutes',
    ]);
    expect(
      within(conditions as HTMLElement)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Checks pass on the latest commit · not yet38 of 41 · fixing',
      'Mara approves the PR · not yetchanges requested',
      'You say yes · not yetyou',
    ]);
    // The explainer is the approval's own words (the shared seed's).
    expect(within(dialog).getByTestId('approval-explainer').textContent).toBe(fixtureApproval.explainer);
    expect(within(dialog).getByRole('button', { name: 'Approve in advance' })).toBeTruthy();
  });

  it('says “Approve and deploy” once the other conditions are met, live', async () => {
    const { app, dialog } = await openModal();
    const key = queryKeys.approvals.get({ params: { burrow: 'burrow-hq', number: 12 } });
    act(() => {
      app.services.queryClient.setQueryData<ApprovalResponse>(key, (d) =>
        d
          ? {
              ...d,
              approval: {
                ...d.approval,
                conditions: d.approval.conditions.map((c) =>
                  c.kind === 'checks_pass'
                    ? { ...c, met: true, state: 'passed', passed: 41, total: 41, fixing: false }
                    : c.kind === 'review_approved'
                      ? { ...c, met: true, reviewState: 'approved', reviewedAt: '2026-09-23T09:38:00.000Z' }
                      : c,
                ),
              },
            }
          : d,
      );
    });
    expect(await within(dialog).findByRole('button', { name: 'Approve and deploy' })).toBeTruthy();
    expect(within(dialog).getByText('41 of 41')).toBeTruthy();
    expect(within(dialog).getByText('approved 11:38')).toBeTruthy();
  });

  it('asks the question from the action, and says what actually runs when the stored wording disagrees', async () => {
    const { app, dialog } = await openModal();
    expect(within(dialog).queryByRole('note')).toBeNull();
    const key = queryKeys.approvals.get({ params: { burrow: 'burrow-hq', number: 12 } });
    act(() => {
      app.services.queryClient.setQueryData<ApprovalResponse>(key, (d) =>
        d
          ? {
              ...d,
              approval: {
                ...d.approval,
                keyId: 'deploy.production',
                action: {
                  type: 'deploy',
                  params: {
                    environment: 'production',
                    service: 'billing-api',
                    ref: 'main',
                    sha: null,
                    repo: 'whombat/billing',
                  },
                },
              },
            }
          : d,
      );
    });
    expect(await within(dialog).findByRole('heading', { name: 'Deploy main to production?' })).toBeTruthy();
    expect(within(dialog).getByRole('note').textContent).toBe(
      'What actually runs: Build the latest commit on main in whombat/billing, then roll billing-api to production.',
    );
  });

  it('approves in advance: closes, toasts as the mock, and the modal shows the decision after', async () => {
    const user = userEvent.setup();
    const { app, dialog } = await openModal();
    await user.click(within(dialog).getByRole('button', { name: 'Approve in advance' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(app.location()).toBe(ROOM);
    expect(screen.getByRole('status').textContent).toBe(
      `Approved in advance. ${ASSISTANT_NAME} will deploy when checks are green.`,
    );

    // The fixture world fast-forwards to the deployed end state (fixtures FX-14): no Undo once executed.
    reopen(app);
    const again = await screen.findByRole('dialog', { name: QUESTION });
    expect(await within(again).findByText('DEPLOYED')).toBeTruthy();
    expect(within(again).queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(within(again).queryByRole('button', { name: 'Decline' })).toBeNull();
  });

  it('declines, shows the declined state, and Undo puts it back to pending', async () => {
    const user = userEvent.setup();
    const { app, dialog } = await openModal();
    await user.click(within(dialog).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('status').textContent).toBe(
      `Declined. ${ASSISTANT_NAME} won’t deploy this commit.`,
    );

    reopen(app);
    const again = await screen.findByRole('dialog', { name: QUESTION });
    expect(await within(again).findByText('DECLINED')).toBeTruthy();
    expect(within(again).getByTestId('approval-explainer').textContent).toContain(
      `Declined. ${ASSISTANT_NAME} won’t deploy this commit.`,
    );
    expect(within(again).getByText('declined')).toBeTruthy();

    await user.click(within(again).getByRole('button', { name: 'Undo' }));
    expect(await within(again).findByRole('button', { name: 'Approve in advance' })).toBeTruthy();
    expect(within(again).getByText(`${ASSISTANT_NAME.toUpperCase()} IS ASKING`)).toBeTruthy();
  });

  it('closes on Esc and on an overlay click, leaving the page as it was', async () => {
    const user = userEvent.setup();
    const { app } = await openModal();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(app.location()).toBe(ROOM);

    reopen(app);
    await screen.findByRole('dialog', { name: QUESTION });
    await user.click(screen.getByTestId('modal-overlay'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(app.location()).toBe(ROOM);
  });

  it('says there is no approval to show when the request is not there', async () => {
    renderApp(`${ROOM}?approval=99`, services());
    const dialog = await screen.findByRole('dialog', { name: 'Approval details' });
    expect(await within(dialog).findByText(APPROVAL_CARD_WORDS.empty)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: APPROVAL_CARD_WORDS.openInbox })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /^Yes/ })).toBeNull();
  });
});

describe('approval modal read states', () => {
  it('says it is loading while the approval is read', async () => {
    renderApp(MODAL, services({ latencyMs: 60 }));
    const loading = await screen.findByRole('dialog', { name: 'Approval details' });
    expect(within(loading).getByRole('status', { name: APPROVAL_CARD_WORDS.loading })).toBeTruthy();
    expect(document.querySelector('[data-screen="approval"][aria-busy="true"]')).toBeTruthy();
    await screen.findByRole('dialog', { name: QUESTION });
  });

  it('says the first read failed, with Try again and no answers', async () => {
    renderApp(MODAL, services({ failing: ['approvals.get'] }));
    const dialog = await screen.findByRole('dialog', { name: 'Approval details' });
    expect(await within(dialog).findByText(APPROVAL_CARD_WORDS.failed)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: APPROVAL_CARD_WORDS.retry })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /Approve|Decline/ })).toBeNull();
  });
});
