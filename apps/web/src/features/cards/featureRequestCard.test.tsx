/**
 * A tracker's feature request card in Chat over the fixture world's requests (`automationFixtures.ts`): what it shows, the fold, Approve, the two forms, the line a decided
 * request settles into and the card it opens, and a refusal in the server's words.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FEATURE_CARD_TEXT } from '@whombat/client';
import { FEATURE_REQUEST_WORDS } from '@whombat/core';
import { burrow } from '@whombat/fixtures';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FEATURE_THREADS } from '../../app/automationFixtures';
import { FEATURE_REQUEST_IDS } from '../../app/trackerFixtures';
import { jsonAnswer, recordingWorld } from '../../test/recordingWorld';
import { mockedServices, renderApp } from '../../test/renderApp';

const B = `/burrows/${burrow.slug}`;
const W = FEATURE_REQUEST_WORDS;
const WAITING = 'Choose when a rollout starts';
const DECIDED = 'A dark theme for the console';
const DECIDE = `${B}/trackers/feature-requests/${FEATURE_REQUEST_IDS.waiting}/decide`;

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

const open = (thread: string, fetch: typeof globalThis.fetch) =>
  renderApp(`/chat?thread=${thread}&focus=1`, mockedServices(fetch));
const card = async () => screen.findByRole('region', { name: `${W.label}: ${WAITING}` });

describe('a feature request’s card in Chat', () => {
  it('shows the request, its value and what the customer reads, folded', async () => {
    const user = userEvent.setup();
    const { fetch } = recordingWorld({ automations: true });
    open(FEATURE_THREADS.waiting, fetch);
    const fr = await card();
    expect(fr.dataset.requestState).toBe('waiting');
    expect(within(fr).getByRole('heading', { name: WAITING })).toBeTruthy();
    expect(within(fr).getByText('Value 7 of 10')).toBeTruthy();
    expect(within(fr).getByText('From HollowMere College · Acme Desk dev #21')).toBeTruthy();
    const fold = within(fr).getByRole('button', { name: FEATURE_CARD_TEXT.reads });
    const reads = document.getElementById(fold.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(reads.hidden).toBe(true);
    await user.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(reads.hidden).toBe(false);
    expect(within(reads).getByText(W.ifApproved)).toBeTruthy();
    expect(within(reads).getByText(W.ifDeclined)).toBeTruthy();
    // Exactly what the customer gets: the draft with its line breaks and the agent's signature.
    expect(reads.querySelector('[data-feature-read="approved"] blockquote')?.textContent).toContain('\n\n');
    expect(
      within(fr)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([FEATURE_CARD_TEXT.reads, W.approve, W.build, W.decline, W.ask]);
    expect(within(fr).getByText(W.askAgent('Neo'))).toBeTruthy();
  });

  it('Approve sends the choice and settles into its line', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = recordingWorld({ automations: true });
    open(FEATURE_THREADS.waiting, fetch);
    await user.click(within(await card()).getByRole('button', { name: W.approve }));
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({ method: 'POST', path: DECIDE, body: { choice: 'approve' } }),
    );
    const line = await screen.findByRole('region', { name: `${W.label}: ${WAITING}` });
    await waitFor(() => expect(line.dataset.variant).toBe('line'));
    expect(within(line).getByText('Approved by Mara · Planned')).toBeTruthy();
  });

  it('Decline opens its form with the agent’s reason, and Cancel goes back', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = recordingWorld({ automations: true });
    open(FEATURE_THREADS.waiting, fetch);
    const fr = await card();
    await user.click(within(fr).getByRole('button', { name: W.decline }));
    const reason = within(fr).getByLabelText(W.declineLabel) as HTMLTextAreaElement;
    expect(reason.value).toBe('We’re making rollouts faster first.');
    // The keyboard is in the box, after the agent's reason.
    expect(document.activeElement).toBe(reason);
    expect(reason.selectionStart).toBe(reason.value.length);
    expect(within(fr).getByText(W.declineHint('Neo'))).toBeTruthy();
    expect(within(fr).queryByRole('button', { name: W.approve })).toBeNull();
    await user.click(within(fr).getByRole('button', { name: W.cancel }));
    expect(within(fr).getByRole('button', { name: W.approve })).toBeTruthy();
    await user.click(within(fr).getByRole('button', { name: W.decline }));
    const again = within(fr).getByLabelText(W.declineLabel);
    await user.clear(again);
    await user.type(again, 'Not this year.');
    await user.click(within(fr).getByRole('button', { name: W.declineSend }));
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({
        method: 'POST',
        path: DECIDE,
        body: { choice: 'decline', note: 'Not this year.' },
      }),
    );
    const line = await screen.findByRole('region', { name: `${W.label}: ${WAITING}` });
    await waitFor(() => expect(line.dataset.variant).toBe('line'));
    expect(within(line).getByText('Declined by Mara')).toBeTruthy();
  });

  it('Ask waits for a question, then sends it', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = recordingWorld({ automations: true });
    open(FEATURE_THREADS.waiting, fetch);
    const fr = await card();
    await user.click(within(fr).getByRole('button', { name: W.ask }));
    const question = within(fr).getByLabelText(W.askLabel) as HTMLTextAreaElement;
    expect(question.value).toBe('');
    expect(within(fr).getByText(W.askHint('Neo'))).toBeTruthy();
    const send = within(fr).getByRole('button', { name: W.askSend }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await user.type(question, 'Which hours suit you?');
    expect(send.disabled).toBe(false);
    await user.click(send);
    await waitFor(() => expect(calls.at(-1)?.body).toEqual({ choice: 'ask', note: 'Which hours suit you?' }));
    const line = await screen.findByRole('region', { name: `${W.label}: ${WAITING}` });
    await waitFor(() => expect(line.dataset.variant).toBe('line'));
    expect(within(line).getByText('Mara asked the customer')).toBeTruthy();
  });

  it('a decided request is a line that opens the card with how it was decided', async () => {
    const user = userEvent.setup();
    const { fetch } = recordingWorld({ automations: true });
    open(FEATURE_THREADS.decided, fetch);
    const line = await screen.findByRole('region', { name: `${W.label}: ${DECIDED}` });
    expect(line.dataset.variant).toBe('line');
    expect(within(line).getByText('Declined by Mara')).toBeTruthy();
    await user.click(within(line).getByRole('button', { name: 'Show card' }));
    const opened = line.querySelector(
      '[data-card="feature_request"][data-request-state="decided"]',
    ) as HTMLElement;
    const outcome = opened.querySelector('[data-feature-outcome]') as HTMLElement;
    expect(outcome.textContent).toContain('Declined by Mara');
    expect(outcome.textContent).toContain('It only helps one customer for now.');
    expect(within(opened).queryByRole('button', { name: W.approve })).toBeNull();
    expect(within(opened).queryByText(W.askAgent('Neo'))).toBeNull();
  });

  it('a refusal shows the server’s words', async () => {
    const user = userEvent.setup();
    const refusal = 'This feature request isn’t waiting for an answer any more.';
    const { fetch } = recordingWorld({ automations: true }, (call, res) =>
      call.path === DECIDE ? jsonAnswer({ error: { code: 'conflict', message: refusal } }, 409) : res,
    );
    open(FEATURE_THREADS.waiting, fetch);
    await user.click(within(await card()).getByRole('button', { name: W.build }));
    expect((await screen.findByRole('alert')).textContent).toBe(refusal);
  });
});
