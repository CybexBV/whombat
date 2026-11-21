/** Spend's arithmetic and words (Whombat spend.md SP-01, SP-02, SP-D01). */
import { describe, expect, it } from 'vitest';
import { API_ENDPOINTS, api } from '../contracts/index.js';
import {
  addTurn,
  addUsage,
  billedTokens,
  CACHE_READ_WEIGHT,
  emptyTotals,
  emptyWindows,
  formatCost,
  formatTokenCount,
  mergeTotals,
  SPEND_PLANS_MAX,
  SpendAgentWeek,
  SpendDaily,
  SpendOverview,
  SpendTotals,
  SpendUsage,
  spendLine,
  spendSummary,
  spendTokens,
  spendWindowsFrom,
  spendWindowsOf,
  usageContextTokens,
} from './spend.js';

const TZ = 'Europe/Amsterdam';
const NOW = '2026-09-23T09:22:00.000Z';

describe('spend arithmetic (SP-D01)', () => {
  it('counts turns, tokens and reported cost; a turn without usage is 0 tokens and unreported', () => {
    let t = emptyTotals();
    expect(t).toEqual({
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      costTurns: 0,
      unreportedTurns: 0,
    });
    t = addUsage(t, { inputTokens: 1200, outputTokens: 300 });
    expect(t).toMatchObject({ turns: 1, inputTokens: 1200, outputTokens: 300, costUsd: null, costTurns: 0 });
    t = addUsage(t, null);
    t = addUsage(t, undefined);
    expect(t).toMatchObject({ turns: 3, inputTokens: 1200, unreportedTurns: 2 });
    t = addUsage(t, { inputTokens: 10, outputTokens: 5, costUsd: 0.1 });
    t = addUsage(t, { inputTokens: 10, outputTokens: 5, costUsd: 0.2 });
    expect(t.costUsd).toBe(0.3);
    expect(t.costTurns).toBe(2);
    t = addUsage(t, { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(t).toMatchObject({ turns: 6, costUsd: 0.3, costTurns: 3, unreportedTurns: 2 });
    expect(spendTokens(t)).toBe(1530);
    expect(SpendTotals.parse(t)).toEqual(t);
  });

  it('does not mutate, and sums without drift', () => {
    const start = emptyTotals();
    addUsage(start, { inputTokens: 1, outputTokens: 1, costUsd: 1 });
    expect(start.turns).toBe(0);
    let t = emptyTotals();
    for (let i = 0; i < 1000; i++) t = addUsage(t, { inputTokens: 1, outputTokens: 0, costUsd: 0.001 });
    expect(t.costUsd).toBe(1);
  });

  it('merges totals, keeping a cost null only when neither part reported one', () => {
    const a = addUsage(emptyTotals(), { inputTokens: 100, outputTokens: 10 });
    const b = addUsage(addUsage(emptyTotals(), null), { inputTokens: 5, outputTokens: 5, costUsd: 0.25 });
    expect(mergeTotals(a, a).costUsd).toBeNull();
    expect(mergeTotals(a, b)).toEqual({
      turns: 3,
      inputTokens: 105,
      outputTokens: 15,
      costUsd: 0.25,
      costTurns: 1,
      unreportedTurns: 1,
    });
    expect(mergeTotals()).toEqual(emptyTotals());
  });

  it('counts a turn in today (the burrow’s day), 7 days and 30 days by when it finished', () => {
    expect(spendWindowsOf('2026-09-23T06:00:00.000Z', NOW, TZ)).toEqual({
      today: true,
      week: true,
      month: true,
    });
    // 23:30 UTC on the 22nd is 01:30 on the 23rd in Amsterdam: today.
    expect(spendWindowsOf('2026-09-22T23:30:00.000Z', NOW, TZ).today).toBe(true);
    expect(spendWindowsOf('2026-09-22T21:30:00.000Z', NOW, TZ).today).toBe(false);
    expect(spendWindowsOf('2026-09-16T09:22:00.001Z', NOW, TZ)).toEqual({
      today: false,
      week: true,
      month: true,
    });
    expect(spendWindowsOf('2026-09-16T09:22:00.000Z', NOW, TZ).week).toBe(false);
    expect(spendWindowsOf('2026-08-24T09:22:00.001Z', NOW, TZ).month).toBe(true);
    expect(spendWindowsOf('2026-08-24T09:22:00.000Z', NOW, TZ).month).toBe(false);
    expect(spendWindowsOf('2026-09-23T09:23:00.000Z', NOW, TZ)).toEqual({
      today: true,
      week: true,
      month: true,
    });
  });

  it('folds turns into their windows', () => {
    const windows = spendWindowsFrom(
      [
        {
          finishedAt: '2026-09-23T08:00:00.000Z',
          usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.5 },
        },
        { finishedAt: '2026-09-20T08:00:00.000Z', usage: { inputTokens: 2000, outputTokens: 400 } },
        { finishedAt: '2026-09-01T08:00:00.000Z', usage: null },
        { finishedAt: '2026-07-01T08:00:00.000Z', usage: { inputTokens: 9, outputTokens: 9, costUsd: 9 } },
      ],
      NOW,
      TZ,
    );
    expect(windows.today).toMatchObject({ turns: 1, inputTokens: 1000, costUsd: 0.5 });
    expect(windows.week).toMatchObject({
      turns: 2,
      inputTokens: 3000,
      outputTokens: 600,
      costUsd: 0.5,
      costTurns: 1,
    });
    expect(windows.month).toMatchObject({ turns: 3, inputTokens: 3000, unreportedTurns: 1, costUsd: 0.5 });
    expect(addTurn(emptyWindows(), { finishedAt: '2026-01-01T00:00:00.000Z', usage: null }, NOW, TZ)).toEqual(
      emptyWindows(),
    );
  });
});

describe('spend words (SP-02)', () => {
  it('formats tokens as 900 / 1.2k / 340k / 1.2M', () => {
    const cases: [number, string][] = [
      [0, '0'],
      [900, '900'],
      [999, '999'],
      [1000, '1k'],
      [1234, '1.2k'],
      [9949, '9.9k'],
      [9950, '10k'],
      [12_345, '12k'],
      [340_000, '340k'],
      [999_499, '999k'],
      [999_500, '1M'],
      [1_234_567, '1.2M'],
      [9_949_999, '9.9M'],
      [12_345_678, '12M'],
      [999_499_999, '999M'],
      [1_500_000_000, '1.5B'],
      [-5, '0'],
    ];
    for (const [n, text] of cases) expect(formatTokenCount(n), String(n)).toBe(text);
  });

  it('formats a reported cost as an estimate', () => {
    expect(formatCost(3.4)).toBe('about $3.40');
    expect(formatCost(3.456)).toBe('about $3.46');
    expect(formatCost(0.01)).toBe('about $0.01');
    expect(formatCost(0.009)).toBe('under $0.01');
    expect(formatCost(0.005)).toBe('under $0.01');
    expect(formatCost(0)).toBe('under $0.01');
    expect(formatCost(1204)).toBe('about $1,204.00');
    expect(formatCost(1234567.891)).toBe('about $1,234,567.89');
    expect(formatCost(null)).toBeNull();
    expect(formatCost(Number.NaN)).toBeNull();
  });

  it('writes the profile line with or without a reported cost', () => {
    const tokensOnly = addUsage(emptyTotals(), { inputTokens: 1_000_000, outputTokens: 200_000 });
    expect(spendLine(tokensOnly)).toBe('This week: 1.2M tokens');
    const withCost = addUsage(tokensOnly, { inputTokens: 0, outputTokens: 0, costUsd: 3.4 });
    expect(spendLine(withCost)).toBe('This week: 1.2M tokens · about $3.40');
    expect(spendSummary(withCost)).toBe('1.2M tokens · about $3.40');
    expect(spendLine(addUsage(emptyTotals(), null))).toBe('This week: 0 tokens');
    expect(spendLine(emptyTotals())).toBe('This week: no turns');
  });
});

describe('spend contracts (SP-01, SP-02)', () => {
  it('has the overview, the agent’s week and the days', () => {
    expect(
      API_ENDPOINTS.filter((e) => e.id.startsWith('spend.')).map((e) => `${e.method} ${e.path}`),
    ).toEqual([
      'GET /burrows/:burrow/spend',
      'GET /burrows/:burrow/spend/week',
      'GET /burrows/:burrow/spend/daily',
    ]);
    expect(
      SpendDaily.safeParse({
        generatedAt: NOW,
        timeZone: TZ,
        days: [
          {
            date: '2026-10-11',
            turns: 12,
            inputTokens: 3_200_000,
            outputTokens: 40_000,
            cacheReadTokens: 3_000_000,
            cacheWriteTokens: 90_000,
          },
        ],
      }).success,
    ).toBe(true);
    const w = { today: emptyTotals(), week: emptyTotals(), month: emptyTotals() };
    const overview = SpendOverview.parse({
      generatedAt: NOW,
      timeZone: TZ,
      totals: w,
      plans: [{ planId: 'pln_invoice-pdf', title: 'Invoice PDF export', budgetTokens: null, usedTokens: 12 }],
    });
    expect(api.spend.overview.response.parse(overview)).toEqual(overview);
    expect(
      SpendOverview.safeParse({
        ...overview,
        plans: Array.from({ length: SPEND_PLANS_MAX + 1 }, () => overview.plans[0]),
      }).success,
    ).toBe(false);
    // One person since 3.0 (CT-1513): no scope and no rows by person.
    expect(SpendOverview.parse({ ...overview, scope: 'own', byPerson: [] })).not.toHaveProperty('byPerson');
    expect(SpendOverview.parse({ ...overview, byAgent: [] })).not.toHaveProperty('byAgent');
    expect(api.spend.week.response.parse({ week: emptyTotals() })).toEqual(
      SpendAgentWeek.parse({ scope: 'yours', week: emptyTotals() }),
    );
  });
});

/** Tokens as they are billed (Whombat prompt-efficiency.md PE-04, contracts 0.44.1). */
describe('the cache split (PE-04)', () => {
  it('reads the cache split and the largest call beside the totals, all optional', () => {
    const claude = {
      inputTokens: 51_400,
      outputTokens: 600,
      costUsd: 0.04,
      cacheReadTokens: 45_000,
      cacheWriteTokens: 6_000,
      largestCallInputTokens: 26_000,
    };
    expect(SpendUsage.parse(claude)).toEqual(claude);
    expect(SpendUsage.parse({ inputTokens: 10, outputTokens: 2 })).toEqual({
      inputTokens: 10,
      outputTokens: 2,
    });
    expect(SpendUsage.safeParse({ ...claude, cacheReadTokens: -1 }).success).toBe(false);
    expect(SpendUsage.safeParse({ ...claude, largestCallInputTokens: 1.5 }).success).toBe(false);
  });

  it('bills uncached input, cache writes and output in full and cache reads at a tenth', () => {
    expect(CACHE_READ_WEIGHT).toBe(0.1);
    // 400 uncached + 6 000 written + 45 000 read at a tenth + 600 out.
    expect(
      billedTokens({
        inputTokens: 51_400,
        outputTokens: 600,
        cacheReadTokens: 45_000,
        cacheWriteTokens: 6_000,
      }),
    ).toBe(400 + 6_000 + 4_500 + 600);
    // Older runners: no split, input plus output.
    expect(billedTokens({ inputTokens: 1200, outputTokens: 300 })).toBe(1500);
    // Rounded; reads past the input are clamped to it.
    expect(billedTokens({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 95 })).toBe(5 + 10);
    expect(billedTokens({ inputTokens: 100, outputTokens: 1, cacheReadTokens: 400 })).toBe(10 + 1);
  });

  it('measures the context by the largest call, else the turn’s sum', () => {
    expect(usageContextTokens({ inputTokens: 150_000, largestCallInputTokens: 52_000 })).toBe(52_000);
    expect(usageContextTokens({ inputTokens: 150_000 })).toBe(150_000);
  });

  it('adds a split to the totals once a turn reports one, and spend counts as billed', () => {
    let t = addUsage(emptyTotals(), { inputTokens: 1000, outputTokens: 100 });
    expect(t).not.toHaveProperty('cacheReadTokens');
    expect(spendTokens(t)).toBe(1100);
    t = addUsage(t, {
      inputTokens: 50_000,
      outputTokens: 500,
      cacheReadTokens: 40_000,
      cacheWriteTokens: 9_000,
    });
    expect(t).toMatchObject({ inputTokens: 51_000, cacheReadTokens: 40_000, cacheWriteTokens: 9_000 });
    t = addUsage(t, { inputTokens: 10_000, outputTokens: 100, cacheReadTokens: 10_000 });
    expect(t).toMatchObject({
      turns: 3,
      inputTokens: 61_000,
      cacheReadTokens: 50_000,
      cacheWriteTokens: 9_000,
    });
    // 11 000 not read from the cache + 5 000 for the 50 000 read + 700 out.
    expect(spendTokens(t)).toBe(11_000 + 5_000 + 700);
    expect(SpendTotals.parse(t)).toEqual(t);
    expect(
      mergeTotals(t, emptyTotals(), addUsage(emptyTotals(), { inputTokens: 5, outputTokens: 5 })),
    ).toMatchObject({
      turns: 4,
      inputTokens: 61_005,
      cacheReadTokens: 50_000,
      cacheWriteTokens: 9_000,
    });
    // Totals without a split stay as they were before 0.44.1.
    expect(mergeTotals(addUsage(emptyTotals(), { inputTokens: 5, outputTokens: 5 }))).toEqual({
      turns: 1,
      inputTokens: 5,
      outputTokens: 5,
      costUsd: null,
      costTurns: 0,
      unreportedTurns: 0,
    });
    expect(spendLine(t)).toBe('This week: 17k tokens');
  });
});
