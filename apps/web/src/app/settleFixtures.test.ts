import { cardDisplay, foldIntoRuns } from '@whombat/client';
import { type AnyEndpoint, api } from '@whombat/core/contracts';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { createWebFixtureFetch } from './fixtureFetch';
import { SETTLE_ASK_ROOT, SETTLE_FEATURE_ROOT, SETTLE_ROOT, SETTLE_SCHEDULE } from './settleFixtures';

const B = `/api/v1/burrows/${burrow.slug}`;

async function call<E extends AnyEndpoint>(
  fetch: typeof globalThis.fetch,
  ep: E,
  path: string,
  method = ep.method,
) {
  const res = await fetch(`http://fixtures.local${B}${path}`, { method });
  expect(res.status).toBe(200);
  const parsed = ep.response.safeParse(await res.json());
  if (!parsed.success) throw new Error(`${ep.id}: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
  return parsed.data as ReturnType<E['response']['parse']>;
}

describe('the settled cards’ fixture world (AP-730…AP-735)', () => {
  it('answers the branch room, the report’s thread, the live runs and Cancel to the contract', async () => {
    const fetch = createWebFixtureFetch({ settle: true });
    const page = await call(fetch, api.messages.list, '/conversations/cnv_pr482/messages');
    expect(page.messages.slice(-3).map((m) => m.id)).toEqual([
      SETTLE_FEATURE_ROOT,
      SETTLE_ROOT,
      SETTLE_ASK_ROOT,
    ]);

    const thread = await call(fetch, api.messages.thread, `/messages/${SETTLE_ROOT}/thread`);
    expect(thread.root.replyCount).toBe(thread.replies.length);
    // What John's thread had: settled lines, a folded schedule, a live run, one that needs a person.
    expect(thread.replies.map((m) => (m.card ? cardDisplay(m.card) : null))).toEqual([
      'line',
      'line',
      'line',
      'line',
      'line',
      'live',
      'full',
    ]);
    const folds = foldIntoRuns(thread.replies);
    expect([...folds.hidden]).toEqual(['msg_settle-schedule']);

    const live = await call(fetch, api.runs.list, '/runs?status=live');
    expect(live.runs.map((r) => [r.number, r.threadRootId])).toEqual([
      [33, SETTLE_ROOT],
      [35, SETTLE_ASK_ROOT],
      [34, SETTLE_ROOT],
    ]);
    await call(fetch, api.messages.thread, `/messages/${SETTLE_ASK_ROOT}/thread`);

    const cancelled = await call(
      fetch,
      api.schedules.remove,
      `/agent/schedules/${SETTLE_SCHEDULE}`,
      'DELETE',
    );
    expect(cancelled.schedule.endedReason).toBe('cancelled');
  });

  it('serves no live runs and leaves the branch room as it is when not seeded', async () => {
    const fetch = createWebFixtureFetch({ settle: false });
    const live = await call(fetch, api.runs.list, '/runs?status=live');
    expect(live.runs).toEqual([]);
    const page = await call(fetch, api.messages.list, '/conversations/cnv_pr482/messages');
    expect(page.messages.some((m) => m.id === SETTLE_ROOT)).toBe(false);
  });
});
