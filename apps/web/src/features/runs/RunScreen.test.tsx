import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { applyRealtimeEvent } from '@whombat/client/query';
import type { Run } from '@whombat/core';
import { burrow, run as fixtureRun, LIVE_LOG_LINES } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch, FIXTURE_BASE_URL } from '../../app/fixtureFetch';
import { ASSISTANT_NAME } from '../../app/oneFixtures';
import { fixtureServices, mockedServices, renderApp } from '../../test/renderApp';

async function openRun() {
  const app = renderApp('/runs/1907');
  await screen.findByRole('heading', { name: 'Address review on PR #482', level: 1 });
  return app;
}

describe('run page', () => {
  it('streams run.updated and run.log into the page', async () => {
    const app = await openRun();
    const qc = app.services.queryClient;
    const line = LIVE_LOG_LINES[0];
    if (!line) throw new Error('fixture');
    act(() => {
      applyRealtimeEvent(qc, { type: 'run.log', runId: fixtureRun.id, runNumber: 1907, lines: [line] });
      applyRealtimeEvent(
        qc,
        {
          type: 'run.updated',
          run: {
            ...fixtureRun,
            tests: { passed: 41, total: 41 },
            diff: { add: 220, del: 14, files: 6 },
            logCount: 9,
            steps: fixtureRun.steps.map((s, i) => ({
              ...s,
              state: i === 0 ? 'done' : 'active',
              at: s.at ?? '2026-09-23T09:24:00.000Z',
            })),
          },
        },
        { at: '2026-09-23T09:24:00.000Z' },
      );
    });
    const log = screen.getByRole('log', { name: 'Live log' });
    await waitFor(() => expect(log.lastElementChild?.textContent).toBe('11:24Editing billing/pdf/format.ts'));
    expect(screen.getByTestId('run-tests').textContent).toBe('41 of 41 passing');
    expect(screen.getByText('+220')).toBeTruthy();
    expect(
      screen
        .getAllByRole('listitem')
        .some((li) => li.textContent?.includes('Round VAT before formatting · In progress')),
    ).toBe(true);

    act(() => {
      applyRealtimeEvent(
        qc,
        { type: 'run.updated', run: { ...fixtureRun, status: 'done', summary: 'Pushed.' } },
        { at: '2026-09-23T09:36:00.000Z' },
      );
    });
    await waitFor(() => expect(screen.getByTestId('run-kicker').textContent).toMatch(/^RUN · DONE/));
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Branch room' })).toBeTruthy();
  });

  it('pauses and resumes', async () => {
    const user = userEvent.setup();
    await openRun();
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.getByTestId('run-kicker').textContent).toMatch(/^RUN · PAUSED/);
    expect(screen.getByTestId('run-notice').textContent).toBe(
      `You paused this run. ${ASSISTANT_NAME} stopped where it was and picks up from the last step on Resume.`,
    );
    expect(screen.getByRole('status').textContent).toBe(`Paused. ${ASSISTANT_NAME} stopped where it was.`);

    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(screen.queryByTestId('run-notice')).toBeNull();
  });

  it('takes over after confirming, and hands over the branch', async () => {
    const user = userEvent.setup();
    await openRun();
    await user.click(screen.getByRole('button', { name: 'Take over' }));
    const dialog = await screen.findByRole('dialog', { name: `Take over ${ASSISTANT_NAME}’s run?` });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('run-kicker').textContent).toMatch(/^RUN · LIVE/);

    await user.click(screen.getByRole('button', { name: 'Take over' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(screen.getByTestId('run-kicker').textContent).toMatch(/^RUN · TAKEN OVER/));
    expect(screen.getByTestId('run-notice').textContent).toBe(
      `You took over feat/invoice-pdf. ${ASSISTANT_NAME} has stopped and won’t push to it again. Pick it up locally: git fetch origin feat/invoice-pdf && git switch feat/invoice-pdf`,
    );
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(
      `You have feat/invoice-pdf now. ${ASSISTANT_NAME} has stopped.`,
    );
  });

  it('shows a quiet placeholder for a run that is not there', async () => {
    renderApp('/runs/42');
    expect(await screen.findByRole('heading', { name: 'Run #42', level: 1 })).toBeTruthy();
  });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * The fixture world with run #1907 failed (it has no failed run of its own); `runs.retry` puts it live again, as the
 * runtime does (CT-197). `retries` counts the calls.
 */
function failedRunWorld() {
  const world = createWebFixtureFetch();
  const state = { failed: true, retries: 0 };
  const failedRun: Run = {
    ...fixtureRun,
    status: 'failed',
    summary: null,
    finishedAt: '2026-09-23T09:30:00.000Z',
  };
  const runPath = `/api/v1/burrows/${burrow.slug}/runs/1907`;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req =
      input instanceof Request ? input : new Request(new URL(String(input), FIXTURE_BASE_URL), init);
    const url = new URL(req.url, FIXTURE_BASE_URL);
    if (req.method === 'POST' && url.pathname === `${runPath}/retry`) {
      state.retries += 1;
      state.failed = false;
      return json({ run: { ...fixtureRun, status: 'live', attention: null } });
    }
    const res = await world(url.toString(), req);
    if (req.method === 'GET' && url.pathname === runPath && state.failed) {
      const detail = (await res.json()) as { run: Run };
      return json({ ...detail, run: failedRun });
    }
    return res;
  });
  return { fetch: fetch as typeof globalThis.fetch, state };
}

describe('Try again on a failed run (CT-197, AP-596)', () => {
  it('offers Try again on a failed run and puts it live again with runs.retry', async () => {
    const user = userEvent.setup();
    const { fetch, state } = failedRunWorld();
    renderApp('/runs/1907', mockedServices(fetch));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(screen.getByTestId('run-kicker').textContent).toMatch(/^RUN · FAILED/);
    expect(screen.getByTestId('run-notice').textContent).toBe(
      `${ASSISTANT_NAME} stopped after an error. Try again to give it another turn.`,
    );
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();

    await user.click(retry);
    await waitFor(() => expect(screen.getByTestId('run-kicker').textContent).toMatch(/^RUN · LIVE/));
    expect(state.retries).toBe(1);
    expect(screen.getByRole('status').textContent).toBe(`Asked ${ASSISTANT_NAME} to try again.`);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  it('says why a live run needs attention, and drops it once the run moves again', async () => {
    const app = await openRun();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByTestId('run-attention')).toBeNull();
    const qc = app.services.queryClient;
    act(() => {
      applyRealtimeEvent(
        qc,
        {
          type: 'run.updated',
          run: { ...fixtureRun, attention: `${ASSISTANT_NAME} stopped without finishing this run.` },
        },
        { at: '2026-09-23T09:40:00.000Z' },
      );
    });
    await waitFor(() =>
      expect(screen.getByTestId('run-attention').textContent).toBe(
        `Needs attention · ${ASSISTANT_NAME} stopped without finishing this run.`,
      ),
    );
    act(() => {
      applyRealtimeEvent(
        qc,
        { type: 'run.updated', run: { ...fixtureRun, attention: null } },
        { at: '2026-09-23T09:41:00.000Z' },
      );
    });
    await waitFor(() => expect(screen.queryByTestId('run-attention')).toBeNull());
  });
});

describe('RunScreen quiet states (TODO 16.4)', () => {
  it('shows a one-line error with Retry when the run fails to load', async () => {
    const user = userEvent.setup();
    renderApp('/runs/1907', fixtureServices({ failing: ['runs.get'] }));
    expect(await screen.findByText('Couldn’t load this run. Try again in a moment.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Couldn’t load this run. Try again in a moment.')).toBeTruthy();
  });
});
