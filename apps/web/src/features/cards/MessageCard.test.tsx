/**
 * `<MessageCard>` wired to the client: cards read from the cached message list (as the channel screen
 * does), so optimistic approval decisions and realtime run / plan events re-render them in place.
 */
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CARD_FRAME_WORDS } from '@whombat/client';
import { applyRealtimeEvent } from '@whombat/client/query';
import { useBootstrap, useMessagesInfinite } from '@whombat/client/react';
import type { Message, Run } from '@whombat/core';
import { approval as fixtureApproval, run as fixtureRun, mara } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch, FIXTURE_BASE_URL } from '../../app/fixtureFetch';
import { ASSISTANT_NAME } from '../../app/oneFixtures';
import { Providers } from '../../app/providers';
import type { AppServices } from '../../app/services';
import { fixtureServices, mockedServices } from '../../test/renderApp';
import { MessageCard } from './MessageCard';

const burrow = 'burrow-hq';

/** PR #482's message list, one `<MessageCard>` per card (the room screen's seam). */
function Cards() {
  const boot = useBootstrap({ params: { burrow } });
  const history = useMessagesInfinite({ params: { burrow, conversationId: 'cnv_pr482' } });
  if (!boot.data || !history.data) return null;
  const messages = [...history.data.pages].reverse().flatMap((p) => p.messages);
  return (
    <>
      {messages.map(
        (m) =>
          m.card && (
            <MessageCard
              key={m.id}
              burrow={burrow}
              card={m.card}
              messageId={m.id}
              conversationId={m.conversationId}
            />
          ),
      )}
    </>
  );
}

function renderCards(services: AppServices = fixtureServices()) {
  const history = createMemoryHistory({ initialEntries: ['/pr/482'] });
  const router = createRouter({
    routeTree: createRootRoute({ component: Cards }),
    history,
    notFoundMode: 'root',
  });
  render(
    <Providers services={services}>
      <RouterProvider router={router} />
    </Providers>,
  );
  const location = () => `${history.location.pathname}${history.location.search}`;
  return { services, location };
}

async function approvalCard() {
  return screen.findByRole('region', { name: 'Approval: Deploy feat/invoice-pdf to staging' });
}

describe('MessageCard (live)', () => {
  it('rolls back and says why when the decision is blocked', async () => {
    const user = userEvent.setup();
    const services = fixtureServices();
    vi.spyOn(services.client.approvals, 'decide').mockResolvedValue({
      status: 'blocked',
      keyNeeded: { id: 'approvals.decide', label: 'Approve requests' },
      eventId: 'evt_000000000001',
      message: 'Neo can’t approve its own request.',
    });
    renderCards(services);
    const card = await approvalCard();
    await user.click(within(card).getByRole('button', { name: 'Approve in advance' }));
    expect(await screen.findByText('Neo can’t approve its own request.')).toBeTruthy();
    await waitFor(() => expect(within(card).getByText('NEEDS A PERSON')).toBeTruthy());
  });

  it('streams the run from realtime events: the compact live card, then a line that opens the card (AP-730)', async () => {
    const user = userEvent.setup();
    const { services } = renderCards();
    const live = await screen.findByRole('region', { name: /^Run #1907/ });
    expect(live.dataset.variant).toBe('live');
    expect(within(live).getByText(`Run #1907 · ${fixtureRun.title}`)).toBeTruthy();

    act(() => {
      applyRealtimeEvent(services.queryClient, {
        type: 'run.updated',
        run: {
          ...fixtureRun,
          progress: 84,
          activity: 'Running the billing test suite',
          tests: { passed: 40, total: 41 },
        },
      });
    });
    await waitFor(() => expect(within(live).getByText('Now: Running the billing test suite')).toBeTruthy());
    expect(within(live).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('84');
    expect(within(live).getByRole('link', { name: 'Watch run' })).toBeTruthy();

    // The control opens the full card under the live one.
    await user.click(within(live).getByRole('button', { name: 'Show card' }));
    const full = screen.getByRole('region', { name: /^Working · Run\./ });
    // Its tests are under Details.
    await user.click(within(full).getByText(CARD_FRAME_WORDS.details));
    expect(within(full).getByText('40 of 41 passing')).toBeTruthy();
    await user.click(within(live).getByRole('button', { name: 'Hide card' }));
    expect(screen.queryByRole('region', { name: /^Working · Run\./ })).toBeNull();

    act(() => {
      applyRealtimeEvent(services.queryClient, {
        type: 'run.updated',
        run: {
          ...fixtureRun,
          status: 'done',
          progress: 100,
          finishedAt: '2026-09-23T09:28:12.000Z',
          summary: 'Pushed 7be20f and asked Mara to re-review.',
          tests: { passed: 41, total: 41 },
        },
      });
    });
    await waitFor(() =>
      expect(screen.getByRole('region', { name: /^Run #1907/ }).dataset.variant).toBe('line'),
    );
    const line = screen.getByRole('region', { name: /^Run #1907/ });
    expect(line.textContent).toContain('Run #1907 · Done');
    expect(line.textContent).toContain('Pushed 7be20f and asked Mara to re-review.');
    expect(within(line).getByText(`PR #${fixtureRun.prNumber}`)).toBeTruthy();
    expect(line.textContent).toContain(`+${fixtureRun.diff.add} −${fixtureRun.diff.del}`);
    await user.click(within(line).getByRole('button', { name: 'Show card' }));
    const done = within(line).getByRole('region', { name: /^Done · Run\./ });
    await user.click(within(done).getByText(CARD_FRAME_WORDS.details));
    expect(within(done).getByText('41 of 41 passing').className).toMatch(/testsPassing/);
  });
});

describe('a settled card is a line that opens the card in place (AP-730, AP-731)', () => {
  it('turns the approval into its line once decided, opens the card in place, and is the card again when pending', async () => {
    const user = userEvent.setup();
    const { services } = renderCards();
    const card = await approvalCard();
    expect(card.dataset.card).toBe('approval');
    expect(card.dataset.variant).toBeUndefined();

    // Approved, the deploy waiting for its checks: settled, a line that keeps Undo as the card would.
    act(() => {
      applyRealtimeEvent(services.queryClient, {
        type: 'approval.updated',
        approval: {
          ...fixtureApproval,
          state: 'approved',
          decidedById: mara.id,
          decidedAt: '2026-09-23T09:30:00.000Z',
        },
      });
    });
    await waitFor(() =>
      expect(screen.getByRole('region', { name: /^Approval: / }).dataset.variant).toBe('line'),
    );
    const line = screen.getByRole('region', { name: /^Approval: / });
    expect(line.textContent).toBe('Approved by Mara · Deploy feat/invoice-pdf to stagingUndo');
    expect(within(line).getByRole('button', { name: 'Undo' })).toBeTruthy();

    // The control opens the card under the line and closes it again.
    const show = within(line).getByRole('button', { name: 'Show card' });
    expect(show.getAttribute('aria-expanded')).toBe('false');
    await user.click(show);
    const hide = within(line).getByRole('button', { name: 'Hide card' });
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    expect(
      within(line).getByRole('region', { name: 'Approval: Deploy feat/invoice-pdf to staging' }),
    ).toBeTruthy();
    await user.click(hide);
    expect(
      within(line).queryByRole('region', { name: 'Approval: Deploy feat/invoice-pdf to staging' }),
    ).toBeNull();

    // Pending again (an undo): the card is back, with its buttons.
    act(() => {
      applyRealtimeEvent(services.queryClient, { type: 'approval.updated', approval: fixtureApproval });
    });
    await waitFor(() =>
      expect(screen.getByRole('region', { name: /^Approval: / }).dataset.variant).toBeUndefined(),
    );
    expect(screen.getByRole('button', { name: 'Approve in advance' })).toBeTruthy();
  });
});

describe('a card only a newer Whombat sends (AP-255)', () => {
  it('shows “This needs a newer version of the app.”; the other cards stay', async () => {
    const world = createWebFixtureFetch();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), FIXTURE_BASE_URL);
      const res = await world(url.toString(), init);
      if (!url.pathname.endsWith('/conversations/cnv_pr482/messages')) return res;
      const body = (await res.json()) as { messages: { card: unknown }[] };
      const i = body.messages.findIndex((m) => m.card !== null);
      body.messages[i] = { ...body.messages[i], card: { kind: 'kanban', columns: [{ title: 'To do' }] } };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    renderCards(mockedServices(fetch as typeof globalThis.fetch));
    expect(await screen.findByText('This needs a newer version of the app.')).toBeTruthy();
    expect(await approvalCard()).toBeTruthy();
  });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * PR #482's room with run #1907 failed: `quiet` (no changed file, no pull request) it shows as the run line, otherwise as
 * the run card. `runs.retry` waits for `answer()` and then puts the run live again, or answers `retryError`; `retries`
 * counts the calls.
 */
function failedRunWorld({
  quiet,
  retryError,
}: {
  quiet: boolean;
  retryError?: { status: number; body: unknown };
}) {
  const world = createWebFixtureFetch();
  const state = { retries: 0 };
  let answer = () => {};
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const failed: Run = {
    ...fixtureRun,
    status: 'failed',
    summary: 'Couldn’t fetch the repository from GitHub.',
    finishedAt: '2026-09-23T09:24:30.000Z',
    attention: null,
    ...(quiet && { diff: { add: 0, del: 0, files: 0 }, files: [], prNumber: null }),
  };
  const live: Run = { ...failed, status: 'live', summary: null, finishedAt: null };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req =
      input instanceof Request ? input : new Request(new URL(String(input), FIXTURE_BASE_URL), init);
    const url = new URL(req.url, FIXTURE_BASE_URL);
    if (req.method === 'POST' && url.pathname === `/api/v1/burrows/${burrow}/runs/1907/retry`) {
      state.retries += 1;
      await answered;
      return retryError ? json(retryError.body, retryError.status) : json({ run: live });
    }
    const res = await world(url.toString(), req);
    if (req.method !== 'GET' || !url.pathname.endsWith('/conversations/cnv_pr482/messages')) return res;
    const body = (await res.json()) as { messages: Message[] };
    const messages = body.messages.map((m) =>
      m.card?.kind === 'run' ? { ...m, card: { ...m.card, run: failed } } : m,
    );
    return json({ ...body, messages });
  });
  return { fetch: fetch as typeof globalThis.fetch, state, answer, live };
}

describe('Try again on a failed run in a conversation (AP-699)', () => {
  it('offers it on a failed run line: busy until the server answers, then live again from the run’s update', async () => {
    const user = userEvent.setup();
    const { fetch, state, answer, live } = failedRunWorld({ quiet: true });
    const { services } = renderCards(mockedServices(fetch));
    const line = await screen.findByRole('region', { name: /^Run #1907/ });
    expect(line.dataset.variant).toBe('line');
    expect(line.textContent).toContain(
      'Run #1907 · Failed in 2m 30s · Couldn’t fetch the repository from GitHub.',
    );
    expect(within(line).getByRole('link', { name: 'Open run' })).toBeTruthy();
    expect(within(line).queryByRole('link', { name: 'Watch run' })).toBeNull();

    await user.click(within(line).getByRole('button', { name: 'Try again' }));
    const busy = within(line).getByRole('button', { name: 'Try again' }) as HTMLButtonElement;
    await waitFor(() => expect(busy.disabled).toBe(true));
    expect(busy.getAttribute('aria-busy')).toBe('true');
    answer();
    expect(await screen.findByText(`Asked ${ASSISTANT_NAME} to try again.`)).toBeTruthy();
    expect(state.retries).toBe(1);

    // The run's own `run.updated` puts the line live again.
    act(() => {
      applyRealtimeEvent(
        services.queryClient,
        { type: 'run.updated', run: { ...live, activity: 'Fetching the repository' } },
        { at: '2026-09-23T09:25:00.000Z' },
      );
    });
    await waitFor(() => expect(line.textContent).toContain('Checking · Fetching the repository'));
    expect(within(line).getByRole('link', { name: 'Watch run' })).toBeTruthy();
    expect(within(line).queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('says why when the retry is refused, as the run page does, and offers it again', async () => {
    const user = userEvent.setup();
    const { fetch, answer } = failedRunWorld({
      quiet: true,
      retryError: { status: 409, body: { error: { code: 'conflict', message: 'Neo is already on it.' } } },
    });
    renderCards(mockedServices(fetch));
    const line = await screen.findByRole('region', { name: /^Run #1907/ });
    await user.click(within(line).getByRole('button', { name: 'Try again' }));
    answer();
    expect(await screen.findByText('Neo is already on it.')).toBeTruthy();
    await waitFor(() =>
      expect((within(line).getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(line.textContent).toContain('Run #1907 · Failed');
  });

  it('offers it on a failed run card too, beside Watch run', async () => {
    const user = userEvent.setup();
    const { fetch, state, answer } = failedRunWorld({ quiet: false });
    renderCards(mockedServices(fetch));
    const card = await screen.findByRole('region', { name: /^Didn’t finish · Run\./ });
    expect(within(card).getByRole('link', { name: 'Watch run' })).toBeTruthy();
    answer();
    await user.click(within(card).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(`Asked ${ASSISTANT_NAME} to try again.`)).toBeTruthy();
    expect(state.retries).toBe(1);
  });
});
