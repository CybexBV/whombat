/**
 * The final Settings home, Usage, Vault rows and Files home words (docs/decisions/final-settings-vault-files-usage.md):
 * the facts each line must carry, not its sentences.
 */
import type { SpendOverview } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { filesSpaceLine } from './files';
import { SETTINGS_HOME_GROUPS, settingsHomeRows } from './settingsGroups';
import { usageCost, usageView, usageWindowText } from './usageView';
import { vaultRowLine } from './vaultRow';

const TZ = 'Europe/Amsterdam';

describe('the Settings home', () => {
  it('has five groups in one order, the assistant by its name, and no brief', () => {
    expect(SETTINGS_HOME_GROUPS).toEqual([
      'you',
      'agent',
      'connections',
      'appliance',
      'news',
      'screens',
      'advanced',
    ]);
    const rows = settingsHomeRows('dusty', ['profile', 'notifications', 'devices']);
    expect(rows.map((r) => r.title)).toEqual([
      'You',
      'Dusty',
      'Connections',
      'This Whombat',
      'News and weather',
      'Screens',
      'Advanced',
    ]);
    expect(rows[0]?.line).toContain('Devices');
    expect(rows[1]?.line).toContain('What Dusty may do');
    // Every part of the assistant's page and of This Whombat's, none it doesn't have.
    expect(rows[1]?.line).toContain('Council');
    expect(rows[3]?.line).not.toContain('Screen');
    expect(JSON.stringify(rows)).not.toMatch(/brief/i);
  });
});

describe('Usage', () => {
  const totals = (turns: number, costTurns: number, costUsd: number | null, unreportedTurns = 0) => ({
    turns,
    inputTokens: 90_000,
    outputTokens: 2_580,
    costUsd,
    costTurns,
    unreportedTurns,
  });
  const data: SpendOverview = {
    generatedAt: '2026-09-23T09:22:00.000Z',
    timeZone: TZ,
    totals: { today: totals(5, 4, 0.3737), week: totals(46, 29, 4.62, 1), month: totals(0, 0, null) },
    plans: [{ planId: 'pln_1' as never, title: 'Invoice PDF export', usedTokens: 3_314_805 }],
  };

  it('leads with the cost, the times worked and how many reported a cost', () => {
    const view = usageView(data, 'neo');
    expect(view.worked).toContain('Neo');
    expect(view.windows.today).toMatchObject({
      cost: '$0.37',
      times: 5,
      coverage: 'Cost reported for 4 of 5',
    });
    expect(view.windows.week.reports).toMatch(/^1 time/);
    expect(view.prepared).toMatch(/23 Sep 2026 at 11:22 Amsterdam/);
    expect(view.plans[0]).toMatch(/^Invoice PDF export · 3\.3M/);
  });

  it('says a window with no reports is empty, never $0', () => {
    expect(usageView(data, 'neo').windows.month).toMatchObject({ empty: true, cost: null });
    expect(usageCost(null)).toBeNull();
    expect(usageCost(0.004)).toBe('under $0.01');
  });

  it('names each window and its time zone', () => {
    expect(usageWindowText('today', data.generatedAt, TZ)).toBe('23 Sep 00:00–11:22 · Europe/Amsterdam');
    expect(usageWindowText('week', data.generatedAt, TZ)).toBe(
      '16 Sep 11:22–23 Sep 11:22 · Europe/Amsterdam',
    );
  });

  it('uses no runtime words', () => {
    expect(JSON.stringify(usageView(data, 'neo'))).not.toMatch(/token|turn/i);
  });
});

describe('a Vault row', () => {
  const ctx = { now: '2026-09-23T09:22:00.000Z', timeZone: TZ, agent: 'neo' };
  const entry = {
    kind: 'http' as const,
    auth: { type: 'basic' as const },
    agentOn: true,
    lastUsedAt: '2026-09-23T07:12:00.000Z',
    check: { status: 'reached' as const, summary: 'Reached', checkedAt: null },
  };

  it('says how its check went and when it was last used', () => {
    expect(vaultRowLine(entry as never, ctx)).toEqual({
      text: 'Sign-in reached · Last used 09:12',
      failing: false,
    });
    expect(vaultRowLine({ ...entry, agentOn: false } as never, ctx).text).toMatch(/Neo is off$/);
  });

  it('is loud only when its check is failing', () => {
    const failing = vaultRowLine(
      { ...entry, check: { status: 'failing', summary: 'The server rejected the secret (401).' } } as never,
      ctx,
    );
    expect(failing.failing).toBe(true);
    expect(failing.text).toMatch(/^Not working · /);
  });
});

describe('a Files space', () => {
  it('says how many files, their size and when the last was added', () => {
    expect(
      filesSpaceLine({ count: 4, bytes: 136_000_000, lastAddedAt: '2026-09-23T09:20:00.000Z' }, TZ),
    ).toMatch(/^4 files · .+ · Last added 23 Sep 11:20$/);
  });
});
