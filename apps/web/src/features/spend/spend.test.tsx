/**
 * Usage (Settings' old Spend address, `USAGE_HREF`: the Spend report under its one name; docs/decisions/final-settings-vault-files-usage.md) against the
 * fixture world: the cost and the times the assistant worked, with how many reported a cost, the window and when it
 * was prepared; the other windows; the empty and failed reads; Settings' old Spend address opening it.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { USAGE_HREF } from '@whombat/client';
import type { SpendOverview } from '@whombat/core/domain';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { pinMockDate } from '../../test/clock';
import { mockedServices, renderApp } from '../../test/renderApp';

pinMockDate();

const B = burrow.slug;

/** The fixture world, counting `spend.overview` reads; `answer` replaces its answer. */
function world(answer?: () => Response) {
  const base = createWebFixtureFetch();
  const reads = { count: 0 };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    if (url.pathname === `/api/v1/burrows/${B}/spend`) {
      reads.count++;
      if (answer) return answer();
    }
    return base(new Request(url, init), init);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, reads };
}

const quiet: SpendOverview = {
  generatedAt: '2026-09-23T09:22:00.000Z',
  timeZone: 'Europe/Amsterdam',
  totals: {
    today: { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: null, costTurns: 0, unreportedTurns: 0 },
    week: { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: null, costTurns: 0, unreportedTurns: 0 },
    month: { turns: 2, inputTokens: 900, outputTokens: 100, costUsd: null, costTurns: 0, unreportedTurns: 1 },
  },
  plans: [],
};

describe('Usage', () => {
  it('leads with what it cost and how many times the assistant worked today', async () => {
    renderApp(USAGE_HREF, mockedServices(world().fetch));
    expect(await screen.findByRole('heading', { level: 1, name: 'Usage' })).toBeTruthy();
    expect(await screen.findByText('$0.37')).toBeTruthy();
    expect(screen.getByText(/^Cost reported for \d+ of 5$/)).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText(/Europe\/Amsterdam$/)).toBeTruthy();
    expect(screen.getByText(/^Prepared 23 Sep 2026 at /)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Today' }).getAttribute('aria-pressed')).toBe('true');
    // Plain words: no runtime vocabulary on the page.
    expect(screen.queryByText(/tokens|turns/i)).toBeNull();
  });

  it('switches to the last 7 days in place', async () => {
    const user = userEvent.setup();
    renderApp(USAGE_HREF, mockedServices(world().fetch));
    await screen.findByText('$0.37');
    await user.click(screen.getByRole('button', { name: 'Last 7 days' }));
    expect(screen.getByText('$4.62')).toBeTruthy();
    expect(screen.getByText(/^Cost reported for \d+ of 46$/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Last 7 days' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('says a window had no reports, never $0, and keeps the chooser', async () => {
    const user = userEvent.setup();
    renderApp(USAGE_HREF, mockedServices(world(() => Response.json(quiet)).fetch));
    expect(await screen.findByText('No usage reported for this window')).toBeTruthy();
    expect(screen.queryByText('$0.00')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Last 30 days' }));
    expect(screen.getByText('No cost reported')).toBeTruthy();
    expect(screen.getByText('Cost reported for 0 of 2')).toBeTruthy();
  });

  it('says it couldn’t read Usage, with Try again, and reads once more on it', async () => {
    const user = userEvent.setup();
    const w = world(() => Response.json({ error: { code: 'internal', message: 'down' } }, { status: 500 }));
    renderApp(USAGE_HREF, mockedServices(w.fetch));
    const failed = await screen.findByRole('alert');
    expect(within(failed).getByText('Couldn’t read Usage')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Usage time window' })).toBeTruthy();
    const before = w.reads.count;
    await user.click(within(failed).getByRole('button', { name: 'Try again' }));
    expect(w.reads.count).toBeGreaterThan(before);
  });

  it('opens from Settings’ older Spend addresses', async () => {
    renderApp('/settings?tab=ai#spend', mockedServices(world().fetch));
    expect(await screen.findByRole('heading', { level: 1, name: 'Usage' })).toBeTruthy();
  });
});
