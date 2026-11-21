import { emptyTotals } from '@whombat/core';
import { spendWeek } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { agentSpendLine } from './lists';

describe('the agent’s spend line (SP-02, AP-4975)', () => {
  it('reads tokens and the reported cost, or tokens alone when the provider reports no cost', () => {
    const week = spendWeek();
    expect(agentSpendLine(week)).toMatch(/^This week: [\d.]+[kMB]? tokens/);
    const noCost = { ...week, week: { ...week.week, turns: 2, costUsd: null, costTurns: 0 } };
    expect(agentSpendLine(noCost)).toMatch(/^This week: [\d.]+[kMB]? tokens$/);
  });

  it('says so for an agent that did nothing, and nothing while it isn’t known', () => {
    expect(agentSpendLine({ week: emptyTotals() })).toBe('This week: no tasks');
    expect(
      agentSpendLine({
        week: {
          ...emptyTotals(),
          turns: 3,
          inputTokens: 1_150_000,
          outputTokens: 50_000,
          costUsd: 3.4,
          costTurns: 3,
        },
      }),
    ).toBe('This week: 1.2M tokens · about $3.40');
    expect(agentSpendLine(undefined)).toBeNull();
  });
});
