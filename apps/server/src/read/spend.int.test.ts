/**
 * Spend (docs/decisions/spend.md SP-01, SP-02, SP-D01…) against the seeded burrow: dispatches with known usage across
 * the windows — some without cost, some without usage, one on either side of midnight in the burrow's time zone,
 * turns that never ran — summed in SQL and checked against core's pure fold (`spendWindowsFrom`); an owner sees the
 * burrow, a member their own turns and their personal agent's; the plans match their turns. The same
 * turns per calendar day (`spend.daily`, box-status.md BS-07).
 */
import {
  dayKey,
  SPEND_DAILY_DAYS,
  type SpendAgentWeek,
  type SpendDaily,
  type SpendDay,
  type SpendOverview,
  type SpendUsage,
  type SpendWindows,
  spendTokens,
  spendWindowsFrom,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { createBurrow } from '../commands/burrows';
import type { StoredPlanStep } from '../db/schema/index';
import { dispatches, plans, principals } from '../db/schema/index';
import { IDS, TEST_BURROW_ID, TEST_TZ } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { addPersonalAgent } from '../test/personal';
import { sessionFor } from '../test/tokens';
import { loadPrincipalRow } from './principals';
import { spendDaily, spendOverview, zonedDayBounds, zonedDays } from './spend';

const t = useTestServer({ seed: true, app: true });

/** Monday 28 September 2026, 12:00 in Amsterdam (CEST, UTC+2): today began at 22:00 UTC on the 27th. */
const NOW = new Date('2026-09-28T10:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

type Who = 'mara' | 'priya' | 'tom' | 'joris';
const PEOPLE: Who[] = ['mara', 'priya', 'tom', 'joris'];
const accounts = {} as Record<Who, string>;
const cookies = {} as Record<Who, string>;
let hazel = '';
let _hazelHandle = '';

interface Turn {
  id: string;
  agent: string;
  for: Who | null;
  finishedAt: Date | null;
  usage: SpendUsage | null;
  state?: 'done' | 'failed' | 'cancelled' | 'queued';
  attempts?: number;
  planId?: string;
  planStepId?: string;
  burrowId?: string;
  /** Whether it counts as a turn at all (SP-D03): finished and ran, in this burrow, in the last 30 days. */
  counts: boolean;
}

const PLAN_BILLING = 'pln_spend-billing';
const PLAN_PR = 'pln_spend-pr';
const SMALL_PLANS = [3, 4, 5, 6, 7].map((n) => ({ id: `pln_spend-small-${n}`, n }));

/** Filled in once the personal agent exists. */
let TURNS: Turn[] = [];

function turns(): Turn[] {
  return [
    // Today (Amsterdam), one with a cost, one without.
    t1('sp_t1', IDS.dusty, 'priya', ago(HOUR), { inputTokens: 1000, outputTokens: 200, costUsd: 0.012345 }),
    t1('sp_t2', IDS.dusty, 'mara', ago(2 * HOUR), { inputTokens: 5000, outputTokens: 700 }),
    // Midnight in Amsterdam: 22:00 UTC on the 27th is today, a millisecond earlier is yesterday (same UTC day).
    t1('sp_t3', IDS.dusty, 'priya', new Date('2026-09-27T22:00:00.000Z'), {
      inputTokens: 300,
      outputTokens: 40,
      costUsd: 0.5,
    }),
    t1('sp_t4', IDS.dusty, 'tom', new Date('2026-09-27T21:59:59.999Z'), {
      inputTokens: 2000,
      outputTokens: 100,
      costUsd: 0.25,
    }),
    // Without usage: a turn with 0 tokens that says so.
    t1('sp_t5', IDS.dusty, null, ago(3 * DAY), null, { attempts: 1 }),
    // Priya's personal agent: for her, and once for nobody (still hers to see).
    t1('sp_t6', hazel, 'priya', ago(2 * DAY), { inputTokens: 800, outputTokens: 90, costUsd: 0.004 }),
    t1('sp_t7', hazel, null, ago(5 * DAY), { inputTokens: 10, outputTokens: 1 }),
    // In the month, not the week.
    // With a cache split (prompt-efficiency.md PE-04, contracts 0.44.1).
    t1('sp_t8', IDS.dusty, 'mara', ago(10 * DAY), {
      inputTokens: 40_000,
      outputTokens: 3000,
      costUsd: 1.2,
      cacheReadTokens: 30_000,
      cacheWriteTokens: 8000,
    }),
    t1('sp_t10', IDS.dusty, 'priya', ago(7 * DAY), { inputTokens: 600, outputTokens: 60, costUsd: 0.03 }),
    // Just inside the week.
    t1('sp_t10b', IDS.dusty, 'priya', ago(7 * DAY - 1000), { inputTokens: 11, outputTokens: 1 }),
    // Outside the month: exactly 30 days, and 31.
    { ...t1('sp_t9', IDS.dusty, 'priya', ago(31 * DAY), { inputTokens: 9, outputTokens: 9 }), counts: false },
    {
      ...t1('sp_t16', IDS.dusty, 'priya', ago(30 * DAY), { inputTokens: 9, outputTokens: 9 }),
      counts: false,
    },
    // Cancelled before any runner took it: not a turn. Cancelled while running: a turn.
    {
      ...t1('sp_t11', IDS.dusty, 'tom', ago(30 * MIN), null, { state: 'cancelled', attempts: 0 }),
      counts: false,
    },
    t1(
      'sp_t12',
      IDS.dusty,
      'tom',
      ago(20 * MIN),
      { inputTokens: 50, outputTokens: 5 },
      { state: 'cancelled' },
    ),
    // Failed after retries, without usage.
    t1('sp_t13', IDS.dusty, 'joris', ago(DAY), null, { state: 'failed', attempts: 2 }),
    // Still queued: not finished.
    { ...t1('sp_t14', IDS.dusty, 'priya', null, null, { state: 'queued', attempts: 0 }), counts: false },
    // A reported cost of zero is a reported cost.
    t1('sp_t17', IDS.dusty, 'priya', ago(4 * DAY), { inputTokens: 5, outputTokens: 5, costUsd: 0 }),
    // A plan step's turns, one of them older than the month.
    t1(
      'sp_h1',
      IDS.dusty,
      'priya',
      ago(2 * DAY),
      // 100 000 of its input read from the prompt cache count 10 000 (PE-04): 33 000 billed.
      {
        inputTokens: 120_000,
        outputTokens: 3000,
        costUsd: 0.9,
        cacheReadTokens: 100_000,
        cacheWriteTokens: 15_000,
        largestCallInputTokens: 40_000,
      },
      {
        planId: PLAN_BILLING,
        planStepId: 'stp_sb-open',
      },
    ),
    {
      ...t1(
        'sp_h2',
        IDS.dusty,
        'priya',
        ago(40 * DAY),
        { inputTokens: 7000, outputTokens: 700 },
        {
          planId: PLAN_BILLING,
          planStepId: 'stp_sb-open',
        },
      ),
      counts: false,
    },
    t1(
      'sp_h3',
      IDS.dusty,
      'mara',
      ago(DAY),
      { inputTokens: 50_000, outputTokens: 1000 },
      {
        planId: PLAN_BILLING,
        planStepId: 'stp_sb-done',
      },
    ),
    t1(
      'sp_h4',
      IDS.dusty,
      'mara',
      ago(3 * HOUR),
      { inputTokens: 9000, outputTokens: 900, costUsd: 0.05 },
      {
        planId: PLAN_PR,
        planStepId: 'stp_sp-open',
      },
    ),
    t1('sp_h5', IDS.dusty, 'mara', ago(5 * DAY), null, {
      attempts: 1,
      planId: PLAN_BILLING,
      planStepId: 'stp_sb-plain',
    }),
    // Five small plans, one turn each for Tom.
    ...SMALL_PLANS.map((p) =>
      t1(
        `sp_p${p.n}`,
        IDS.dusty,
        'tom',
        ago(6 * DAY),
        { inputTokens: 1000 * p.n, outputTokens: 0 },
        {
          planId: p.id,
          planStepId: `stp_small-${p.n}`,
        },
      ),
    ),
  ];
}

function t1(
  id: string,
  agent: string,
  forWho: Who | null,
  finishedAt: Date | null,
  usage: SpendUsage | null,
  over: Partial<Turn> = {},
): Turn {
  return { id, agent, for: forWho, finishedAt, usage, counts: true, ...over };
}

function step(
  id: string,
  over: Partial<StoredPlanStep> & Pick<StoredPlanStep, 'state' | 'stateLabel'>,
): StoredPlanStep {
  return {
    id,
    title: `Step ${id}`,
    runId: null,
    approvalId: null,
    automationRunId: null,
    dispatchId: null,
    note: null,
    updatedAt: ago(HOUR).toISOString(),
    refs: { runNumber: null, approvalNumber: null, automationRunNumber: null },
    ...over,
  };
}

beforeAll(async () => {
  t.services.clock = () => NOW;
  // The turns name who asked them by the mock's old names; every one is the person's (one-person.md OP-S73).
  const [row] = await t.services.db
    .select({ accountId: principals.accountId })
    .from(principals)
    .where(eq(principals.id, IDS.mara));
  const cookie = (await sessionFor(t.services, IDS.mara)).cookie;
  for (const who of PEOPLE) {
    accounts[who] = row?.accountId as string;
    cookies[who] = cookie;
  }
  const personal = await addPersonalAgent(t.services, TEST_BURROW_ID, IDS.mara, { services: null });
  hazel = personal.agentId;
  _hazelHandle = personal.handle;
  TURNS = turns();

  await t.services.db.insert(plans).values([
    {
      id: PLAN_BILLING,
      burrowId: TEST_BURROW_ID,
      title: 'Credit-note PDFs',
      conversationId: IDS.billing,
      steps: [
        step('stp_sb-open', {
          state: 'active',
          stateLabel: 'In progress',
        }),
        step('stp_sb-done', {
          state: 'done',
          stateLabel: 'Done',
        }),
        step('stp_sb-declined', {
          state: 'blocked',
          stateLabel: 'Declined',
        }),
        step('stp_sb-plain', { state: 'active', stateLabel: 'In progress' }),
      ],
      updatedAt: ago(HOUR),
    },
    {
      id: PLAN_PR,
      burrowId: TEST_BURROW_ID,
      title: 'Rounding fix for PR #482',
      conversationId: IDS.pr482,
      // No budget written: the server's default applies (DG-11).
      steps: [
        step('stp_sp-open', {
          state: 'queued',
          stateLabel: 'Queued',
        }),
      ],
      updatedAt: ago(HOUR),
    },
    ...SMALL_PLANS.map((p) => ({
      id: p.id,
      burrowId: TEST_BURROW_ID,
      title: `Small plan ${p.n}`,
      conversationId: IDS.billing,
      steps: [step(`stp_small-${p.n}`, { state: 'active', stateLabel: 'In progress' })],
      updatedAt: ago(HOUR),
    })),
  ]);

  // Another burrow's turn never counts here.
  const elsewhere = await createBurrow(t.services, accounts.mara, 'Spend Elsewhere', { besideOwn: true });
  await t.services.db.insert(dispatches).values([
    ...TURNS.map((turn) => ({
      id: turn.id,
      burrowId: turn.burrowId ?? TEST_BURROW_ID,
      agentId: turn.agent,
      trigger: 'mention' as const,
      conversationId: IDS.billing,
      state: turn.state ?? 'done',
      attempts: turn.attempts ?? 1,
      claimedAt:
        (turn.attempts ?? 1) > 0 && turn.finishedAt ? new Date(turn.finishedAt.getTime() - MIN) : null,
      createdAt: turn.finishedAt ? new Date(turn.finishedAt.getTime() - 2 * MIN) : ago(MIN),
      finishedAt: turn.finishedAt,
      usage: turn.usage,
      onBehalfOfAccountId: turn.for ? accounts[turn.for] : null,
      ...(turn.planId ? { planId: turn.planId, planStepId: turn.planStepId ?? null } : {}),
    })),
    {
      id: 'sp_elsewhere',
      burrowId: elsewhere.burrowId,
      agentId: IDS.dusty,
      trigger: 'mention' as const,
      conversationId: IDS.billing,
      state: 'done' as const,
      attempts: 1,
      createdAt: ago(HOUR),
      finishedAt: ago(HOUR),
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, costUsd: 99 },
      onBehalfOfAccountId: accounts.mara,
    },
  ]);
});

/* Expected numbers: core's pure fold over the turns a viewer may see ----------------------------------------------- */

const counted = () => TURNS.filter((turn) => turn.counts);
/** SP-01: an owner sees every turn; a member the turns done for them (one-agent.md OA-19). */
const _visibleTo = (who: Who) => counted().filter((turn) => who === 'mara' || turn.for === who);
const fold = (list: readonly Turn[]): SpendWindows =>
  spendWindowsFrom(
    list.map((turn) => ({ finishedAt: turn.finishedAt as Date, usage: turn.usage })),
    NOW,
    TEST_TZ,
  );

async function get<T>(who: Who, path: string, status = 200): Promise<T> {
  const res = await t.api.inject({
    method: 'GET',
    url: `/api/v1/burrows/burrow-hq${path}`,
    headers: { cookie: cookies[who] },
  });
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as T;
}

const overview = (who: Who) => get<SpendOverview>(who, '/spend');

function _expectRows<R extends { windows: SpendWindows }>(
  rows: readonly R[],
  key: (row: R) => string | null,
  expected: Map<string | null, readonly Turn[]>,
) {
  expect(new Set(rows.map(key))).toEqual(new Set(expected.keys()));
  for (const row of rows) expect(row.windows, String(key(row))).toEqual(fold(expected.get(key(row)) ?? []));
  // Most 30-day tokens first.
  const tokens = rows.map((r) => spendTokens(r.windows.month));
  expect(tokens).toEqual([...tokens].sort((a, b) => b - a));
}

function _groupBy(list: readonly Turn[], key: (turn: Turn) => string | null): Map<string | null, Turn[]> {
  const out = new Map<string | null, Turn[]>();
  for (const turn of list) out.set(key(turn), [...(out.get(key(turn)) ?? []), turn]);
  return out;
}

const _personId = (who: Who | null) => (who ? IDS.mara : null);

describe('spend.overview (SP-01)', () => {
  it('counts “today” from midnight in the burrow’s time zone', () => {
    expect(zonedDayBounds(NOW, TEST_TZ)).toEqual({
      start: new Date('2026-09-27T22:00:00.000Z'),
      end: new Date('2026-09-28T22:00:00.000Z'),
    });
    // The night the clocks go back (25 October 2026): a 25-hour day.
    expect(zonedDayBounds(new Date('2026-10-25T12:00:00.000Z'), TEST_TZ)).toEqual({
      start: new Date('2026-10-24T22:00:00.000Z'),
      end: new Date('2026-10-25T23:00:00.000Z'),
    });
  });

  it('gives the person the burrow: sums that match the stored usage exactly', async () => {
    const o = await overview('mara');
    expect(o).toMatchObject({ generatedAt: NOW.toISOString(), timeZone: TEST_TZ });
    expect(o.totals).toEqual(fold(counted()));
    // By hand, so the fold itself is pinned: today is t1, t2, t3, t12 and h4 (t4 was yesterday in Amsterdam, t11 never
    // ran); the week adds t4, then t5, t6, t7, t10b, t13, t17, h1, h3, h5, and the five small plans' turns.
    expect(o.totals.today).toEqual({
      turns: 5,
      inputTokens: 1000 + 5000 + 300 + 50 + 9000,
      outputTokens: 200 + 700 + 40 + 5 + 900,
      costUsd: 0.562345,
      costTurns: 3,
      unreportedTurns: 0,
    });
    expect(o.totals.week.turns).toBe(5 + 1 + 9 + 5);
    expect(o.totals.week.unreportedTurns).toBe(3);
    expect(o.totals.month.turns).toBe(o.totals.week.turns + 2);
    // 0.012345 + 0.5 + 0.25 + 0.004 + 1.2 + 0.03 + 0 + 0.9 + 0.05, to the micro-dollar.
    expect(o.totals.month.costUsd).toBe(2.946345);
    expect(o.totals.month.costTurns).toBe(9);
    // The cache split once a turn in the window reported one (h1 this week, t8 this month), none today.
    expect(o.totals.month).toMatchObject({ cacheReadTokens: 130_000, cacheWriteTokens: 23_000 });
    expect(o.totals.week).toMatchObject({ cacheReadTokens: 100_000, cacheWriteTokens: 15_000 });
    expect(o.totals.today).not.toHaveProperty('cacheReadTokens');
  });

  it('lists the plans that used the most, by title, without budgets (one-agent.md OA-06)', async () => {
    const mara = await overview('mara');
    const planTokens = (id: string) =>
      spendTokens(fold(counted().filter((turn) => turn.planId === id)).month);
    expect(planTokens(PLAN_BILLING)).toBe(33_000 + 51_000);
    expect(mara.plans).toEqual([
      {
        planId: PLAN_BILLING,
        title: 'Credit-note PDFs',
        usedTokens: planTokens(PLAN_BILLING),
      },
      { planId: PLAN_PR, title: 'Rounding fix for PR #482', usedTokens: 9900 },
      // The two smallest are cut (five at most).
      ...[7, 6, 5].map((n) => ({
        planId: `pln_spend-small-${n}`,
        title: `Small plan ${n}`,
        usedTokens: 1000 * n,
      })),
    ]);
  });

  it('refuses agents', async () => {
    const banjo = await loadPrincipalRow(t.services.db, IDS.dusty);
    await expect(
      spendOverview(t.services, banjo as NonNullable<typeof banjo>, {
        id: TEST_BURROW_ID,
        timeZone: TEST_TZ,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('spend.week (SP-02, one-agent.md OA-19)', () => {
  const week = (list: readonly Turn[]) => fold(list).week;
  const agentWeek = (who: Who, _agent?: string, status = 200) =>
    get<SpendAgentWeek>(who, '/spend/week', status);

  it('gives the agent’s whole week', async () => {
    const banjo = counted().filter((turn) => turn.agent === IDS.dusty);
    expect(await agentWeek('mara', 'dusty')).toEqual({ week: week(banjo) });
  });
});

describe('spend.daily (BS-07)', () => {
  const daily = (who: Who) => get<SpendDaily>(who, '/spend/daily');
  /** The days core's `dayKey` gives the turns a viewer sees, every one of the 30 present. */
  const expected = (list: readonly Turn[]): SpendDay[] =>
    zonedDays(NOW, TEST_TZ, SPEND_DAILY_DAYS).days.map(({ date }) => {
      const on = list.filter((turn) => turn.finishedAt && dayKey(turn.finishedAt, TEST_TZ) === date);
      const sum = (f: (u: SpendUsage) => number) =>
        on.reduce((n, turn) => n + (turn.usage ? f(turn.usage) : 0), 0);
      return {
        date,
        turns: on.length,
        inputTokens: sum((u) => u.inputTokens),
        outputTokens: sum((u) => u.outputTokens),
        cacheReadTokens: sum((u) => Math.min(u.cacheReadTokens ?? 0, u.inputTokens)),
        cacheWriteTokens: sum((u) => Math.min(u.cacheWriteTokens ?? 0, u.inputTokens)),
      };
    });

  it('gives the burrow per calendar day in its time zone, today last, quiet days as zeros', async () => {
    const d = await daily('mara');
    expect(d).toMatchObject({ generatedAt: NOW.toISOString(), timeZone: TEST_TZ });
    expect(d.days).toHaveLength(30);
    expect(d.days).toEqual(expected(counted()));
    // By hand: today is t1, t2, t3, t12 and h4 (as spend.overview's today); yesterday t4 (a millisecond before midnight
    // in Amsterdam), t13 (no usage) and h3. Another burrow's turn and turns that never ran count nowhere.
    expect(d.days.at(-1)).toEqual({
      date: '2026-09-28',
      turns: 5,
      inputTokens: 15_350,
      outputTokens: 1845,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(d.days.at(-2)).toMatchObject({
      date: '2026-09-27',
      turns: 3,
      inputTokens: 52_000,
      outputTokens: 1100,
    });
    expect(d.days[0]?.date).toBe('2026-08-30');
    // Ten days ago: the cache split, as reported.
    expect(d.days.find((day) => day.date === '2026-09-18')).toMatchObject({
      turns: 1,
      cacheReadTokens: 30_000,
      cacheWriteTokens: 8000,
    });
    const today = (await overview('mara')).totals.today;
    expect(d.days.at(-1)).toMatchObject({ turns: today.turns, inputTokens: today.inputTokens });
  });

  it('refuses agents', async () => {
    const banjo = await loadPrincipalRow(t.services.db, IDS.dusty);
    await expect(
      spendDaily(t.services, banjo as NonNullable<typeof banjo>, { id: TEST_BURROW_ID, timeZone: TEST_TZ }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
