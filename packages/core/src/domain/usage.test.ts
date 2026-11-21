import { describe, expect, it } from 'vitest';
import {
  api,
  ProgressBody,
  REALTIME_EVENT_TOPICS,
  RealtimeEvent,
  SIGNIN_METHODS,
} from '../contracts/index.js';
import {
  formatAsOf,
  formatResetsIn,
  formatUsagePct,
  formatUsageWindowLine,
  NBSP,
  usageAlertText,
  usageSummaryText,
} from '../text/usage.js';
import {
  dueUsageAlert,
  isUsageStale,
  nextUsageProbeAt,
  primaryUsageWindow,
  SubscriptionUsage,
  sortUsageWindows,
  USAGE_PROBE_ACTIVE_MS,
  USAGE_PROBE_IDLE_MS,
  type UsageWindow,
  usageAlertLevel,
  usageLevel,
  usagePct,
  usageStatus,
  usageWindowKindForMinutes,
} from './usage.js';

const NOW = '2026-09-29T12:30:00Z';
const TZ = 'Europe/Amsterdam'; // 14:30 local

const fiveHour: UsageWindow = {
  kind: 'five_hour',
  label: '5-hour',
  usedPct: 85,
  resetsAt: '2026-09-29T14:00:00Z',
  status: 'warning',
};
const sevenDay: UsageWindow = {
  kind: 'seven_day',
  label: '7-day',
  usedPct: 41,
  resetsAt: '2026-10-02T07:00:00Z',
  status: 'ok',
  windowMinutes: 10_080,
};

/** The person's Claude sign-in (since 3.0 without whose: one person, CT-1513). */
const claudeMax: SubscriptionUsage = {
  provider: 'claude',
  kind: 'subscription',
  connected: true,
  plan: 'max',
  windows: [sevenDay, fiveHour],
  observedAt: '2026-09-29T12:28:00Z',
  source: 'probe',
  error: null,
};

describe('usage schemas (CT-153, CT-154)', () => {
  it('parses a snapshot, one before the first probe, and an API key', () => {
    expect(SubscriptionUsage.parse(claudeMax)).toEqual(claudeMax);
    const fresh = { ...claudeMax, windows: [], observedAt: null, source: null, plan: null };
    expect(SubscriptionUsage.safeParse(fresh).success).toBe(true);
    expect(SubscriptionUsage.safeParse({ ...fresh, kind: 'api_key' }).success).toBe(true);
    expect(
      SubscriptionUsage.safeParse({ ...claudeMax, windows: [{ ...fiveHour, usedPct: 101 }] }).success,
    ).toBe(false);
  });

  it('declares the endpoints, the event and the runner additions', () => {
    expect(api.usage.list).toMatchObject({ id: 'usage.list', method: 'GET', path: '/burrows/:burrow/usage' });
    expect(api.usage.refresh).toMatchObject({
      id: 'usage.refresh',
      method: 'POST',
      path: '/burrows/:burrow/usage/refresh',
    });
    expect(api.usage.list.response.safeParse({ mine: [claudeMax] }).success).toBe(true);
    expect(api.usage.list.response.parse({ mine: [], everyone: null })).not.toHaveProperty('everyone');
    expect(api.usage.refresh.body.safeParse({ provider: 'codex' }).success).toBe(true);
    expect(api.usage.refresh.body.safeParse({ provider: 'github' }).success).toBe(false);
    expect(RealtimeEvent.safeParse({ type: 'usage.updated', usage: claudeMax }).success).toBe(true);
    expect(REALTIME_EVENT_TOPICS['usage.updated']).toEqual(['me']);
    const probe = SIGNIN_METHODS.usageProbe;
    expect(probe.params.safeParse({ provider: 'claude' }).success).toBe(true);
    expect(
      probe.result.safeParse({
        ok: true,
        usage: {
          provider: 'claude',
          kind: 'subscription',
          plan: 'max',
          windows: [fiveHour],
          observedAt: NOW,
          error: null,
        },
      }).success,
    ).toBe(true);
    expect(probe.result.safeParse({ ok: false, code: 'provider.not_signed_in', message: 'x' }).success).toBe(
      true,
    );
    expect(
      ProgressBody.safeParse({
        state: 'running',
        rateLimits: { provider: 'codex', plan: 'plus', windows: [sevenDay], observedAt: NOW },
      }).success,
    ).toBe(true);
  });
});

describe('usage levels and windows (CT-156)', () => {
  it('grades shares at 80 and 95', () => {
    expect([null, 0, 79.9, 80, 94.9, 95, 100].map(usageLevel)).toEqual([
      null,
      'ok',
      'ok',
      'warning',
      'warning',
      'critical',
      'critical',
    ]);
    expect(usageStatus(50)).toBe('ok');
    expect(usageStatus(80)).toBe('warning');
    expect(usageStatus(100)).toBe('limited');
    expect(usageStatus(null, true)).toBe('limited');
  });

  it('normalises provider numbers and window kinds', () => {
    expect(usagePct(0.4321, 'fraction')).toBe(43.2);
    expect(usagePct(130)).toBe(100);
    expect(usagePct(Number.NaN)).toBeNull();
    expect(usageWindowKindForMinutes(300)).toBe('five_hour');
    expect(usageWindowKindForMinutes(10_080)).toBe('seven_day');
    expect(usageWindowKindForMinutes(60)).toBe('other');
    expect(sortUsageWindows(claudeMax.windows).map((w) => w.kind)).toEqual(['five_hour', 'seven_day']);
    expect(primaryUsageWindow(claudeMax.windows)?.kind).toBe('five_hour');
    expect(primaryUsageWindow([])).toBeNull();
  });

  it('schedules probes and says when data is stale', () => {
    const now = new Date(NOW);
    const seen = new Date('2026-09-29T12:00:00Z');
    expect(nextUsageProbeAt(null, null, now)).toEqual(now);
    expect(nextUsageProbeAt(seen, new Date('2026-09-29T09:00:00Z'), now).getTime()).toBe(
      seen.getTime() + USAGE_PROBE_ACTIVE_MS,
    );
    expect(nextUsageProbeAt(seen, new Date('2026-09-27T09:00:00Z'), now).getTime()).toBe(
      seen.getTime() + USAGE_PROBE_IDLE_MS,
    );
    expect(isUsageStale('2026-09-29T12:28:00Z', now)).toBe(false);
    expect(isUsageStale('2026-09-29T12:00:00Z', now)).toBe(true);
    expect(isUsageStale(null, now)).toBe(true);
  });
});

describe('usage alerts (CT-156)', () => {
  it('alerts once per window per level until it resets', () => {
    const sent = new Set<string>();
    const due = dueUsageAlert(claudeMax, fiveHour, (k) => sent.has(k));
    expect(due?.level).toBe(80);
    for (const k of due?.markSent ?? []) sent.add(k);
    expect(dueUsageAlert(claudeMax, fiveHour, (k) => sent.has(k))).toBeNull();
    // 70 → 97 in one step: 95 once, and 80 is covered.
    const jump = dueUsageAlert(claudeMax, { ...fiveHour, usedPct: 97 }, (k) => sent.has(k));
    expect(jump?.level).toBe(95);
    expect(jump?.markSent).toHaveLength(2);
    // Limited after that, then a new window after the reset alerts again.
    for (const k of jump?.markSent ?? []) sent.add(k);
    expect(dueUsageAlert(claudeMax, { ...fiveHour, status: 'limited' }, (k) => sent.has(k))?.level).toBe(
      'limited',
    );
    const next = { ...fiveHour, resetsAt: '2026-09-29T19:00:00Z' };
    expect(dueUsageAlert(claudeMax, next, (k) => sent.has(k))?.level).toBe(80);
    expect(usageAlertLevel({ usedPct: 12, status: 'ok' })).toBeNull();
  });
});

describe('usage copy (CT-156)', () => {
  it('formats shares, spans and times', () => {
    expect(formatUsagePct(85.4)).toBe(`85${NBSP}%`);
    expect(formatUsagePct(0.2)).toBe(`<1${NBSP}%`);
    expect(formatUsagePct(null)).toBe('—');
    expect(formatResetsIn('2026-09-29T14:40:00Z', NOW)).toBe('resets in 2 h 10 min');
    expect(formatResetsIn('2026-09-29T13:15:00Z', NOW)).toBe('resets in 45 min');
    expect(formatResetsIn('2026-09-29T14:30:00Z', NOW)).toBe('resets in 2 h');
    expect(formatResetsIn('2026-10-02T16:30:00Z', NOW)).toBe('resets in 3 d 4 h');
    expect(formatResetsIn('2026-09-29T12:00:00Z', NOW)).toBe('resets now');
    expect(formatResetsIn(null, NOW)).toBe('');
    expect(formatAsOf('2026-09-29T12:32:00Z', NOW, TZ)).toBe('as of 14:32');
    expect(formatAsOf('2026-09-28T12:32:00Z', NOW, TZ)).toBe('as of 28 Sep, 14:32');
    expect(formatAsOf(null, NOW, TZ)).toBe('not read yet');
    expect(formatUsageWindowLine(fiveHour, NOW)).toBe(`5-hour · 85${NBSP}% · resets in 1 h 30 min`);
  });

  it('writes the assistant’s alerts', () => {
    const base = { provider: 'claude' as const, personName: 'Jamie', now: NOW, timeZone: TZ };
    expect(usageAlertText({ ...base, level: 80, window: fiveHour, forOwner: true })).toBe(
      `Your Claude subscription is at 85${NBSP}% of its 5-hour limit, resets at 16:00.`,
    );
    expect(usageAlertText({ ...base, level: 80, window: fiveHour, forOwner: false })).toBe(
      `Jamie’s Claude subscription is at 85${NBSP}% of its 5-hour limit, resets at 16:00.`,
    );
    expect(
      usageAlertText({ ...base, level: 95, window: { ...sevenDay, usedPct: 96 }, forOwner: false }),
    ).toBe(`Jamie’s Claude subscription is at 96${NBSP}% of its 7-day limit, resets Fri 09:00.`);
    expect(
      usageAlertText({ ...base, provider: 'codex', level: 'limited', window: fiveHour, forOwner: true }),
    ).toBe('Your ChatGPT subscription hit its 5-hour limit, resets at 16:00. Turns on it wait until then.');
    expect(
      usageAlertText({ ...base, level: 'limited', window: { ...fiveHour, resetsAt: null }, forOwner: false }),
    ).toBe('Jamie’s Claude subscription hit its 5-hour limit.');
  });

  it('summarises a snapshot', () => {
    expect(usageSummaryText(claudeMax, NOW)).toBe(
      `Claude · 5-hour · 85${NBSP}% · resets in 1 h 30 min · 7-day · 41${NBSP}% · resets in 2 d 18 h`,
    );
    expect(usageSummaryText({ ...claudeMax, kind: 'api_key' }, NOW)).toBe(
      'Claude · Pay as you go — see Spend',
    );
    expect(usageSummaryText({ ...claudeMax, connected: false }, NOW)).toBe('Claude · not signed in');
  });
});
