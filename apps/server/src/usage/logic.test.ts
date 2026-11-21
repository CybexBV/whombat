import type { ProbeUsage, UsageWindow } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  applyReading,
  dueAlerts,
  emptyRow,
  normalizeWindow,
  probeDueAt,
  refreshWaitSeconds,
  type UsageRow,
} from './logic';

const NOW = new Date('2026-09-29T14:00:00.000Z');
const min = (n: number) => n * 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

const w = (
  kind: UsageWindow['kind'],
  usedPct: number | null,
  extra: Partial<UsageWindow> = {},
): UsageWindow => ({
  kind,
  label: kind === 'five_hour' ? '5-hour' : kind === 'seven_day' ? '7-day' : kind,
  usedPct,
  resetsAt: '2026-09-29T16:00:00.000Z',
  status:
    usedPct !== null && usedPct >= 100 ? 'limited' : usedPct !== null && usedPct >= 80 ? 'warning' : 'ok',
  windowMinutes: kind === 'five_hour' ? 300 : 10080,
  ...extra,
});

const probe = (windows: UsageWindow[], extra: Partial<ProbeUsage> = {}): ProbeUsage => ({
  provider: 'claude',
  kind: 'subscription',
  plan: 'max',
  windows,
  observedAt: NOW.toISOString(),
  error: null,
  ...extra,
});

const row = (extra: Partial<UsageRow> = {}): UsageRow => ({ ...emptyRow('acc_jamie', 'claude'), ...extra });

describe('the probe schedule', () => {
  it('never read: due now; used within 24 h: every 15 minutes; otherwise hourly', () => {
    expect(probeDueAt(row(), NOW)).toEqual(NOW);
    const read = row({ observedAt: at(-min(10)) });
    expect(probeDueAt({ ...read, usedAt: at(-min(60)) }, NOW)).toEqual(at(min(5)));
    expect(probeDueAt({ ...read, usedAt: at(-min(25 * 60)) }, NOW)).toEqual(at(min(50)));
    expect(probeDueAt(read, NOW)).toEqual(at(min(50)));
  });

  it('a probe that keeps failing waits the same spacing after each attempt', () => {
    const failing = row({ observedAt: null, probedAt: at(-min(5)), error: 'nope' });
    expect(probeDueAt(failing, NOW)).toEqual(at(min(55)));
    expect(probeDueAt({ ...failing, usedAt: at(-min(1)) }, NOW)).toEqual(at(min(10)));
  });

  it('a person may ask once a minute', () => {
    expect(refreshWaitSeconds(null, NOW)).toBe(0);
    expect(refreshWaitSeconds(row({ refreshedAt: at(-20_000) }), NOW)).toBe(40);
    expect(refreshWaitSeconds(row({ refreshedAt: at(-60_000) }), NOW)).toBe(0);
  });
});

describe('readings', () => {
  it('a probe replaces the snapshot; its reset times land on the minute', () => {
    const next = applyReading(
      row({ windows: [w('seven_day_opus', 50)] }),
      probe([
        w('seven_day', 77, { resetsAt: '2026-10-02T15:00:00.368Z' }),
        w('five_hour', 0, { resetsAt: null }),
      ]),
      'probe',
      NOW,
    );
    expect(next).toMatchObject({
      kind: 'subscription',
      plan: 'max',
      source: 'probe',
      error: null,
      probedAt: NOW,
    });
    expect(next.windows.map((x) => [x.kind, x.usedPct, x.resetsAt])).toEqual([
      ['five_hour', 0, null],
      ['seven_day', 77, '2026-10-02T15:00:00.000Z'],
    ]);
  });

  it('a probe that couldn’t read keeps the last windows and says why', () => {
    const before = row({ windows: [w('five_hour', 40)], observedAt: at(-min(30)), source: 'probe' });
    const next = applyReading(
      before,
      probe([], { plan: null, error: 'Unsupported control request' }),
      'probe',
      NOW,
    );
    expect(next).toMatchObject({
      windows: before.windows,
      observedAt: before.observedAt,
      error: 'Unsupported control request',
      probedAt: NOW,
    });
  });

  it('an API key: pay as you go, no windows', () => {
    const next = applyReading(
      row({ windows: [w('five_hour', 40)] }),
      probe([], { kind: 'api_key', plan: null }),
      'probe',
      NOW,
    );
    expect(next).toMatchObject({ kind: 'api_key', plan: null, windows: [] });
  });

  it('a turn’s reading replaces what it names, keeps the rest and the plan, and marks the subscription used', () => {
    const before = row({ plan: 'max', windows: [w('five_hour', 40), w('seven_day', 70)] });
    const next = applyReading(
      before,
      { provider: 'claude', plan: null, windows: [w('five_hour', 86)], observedAt: NOW.toISOString() },
      'turn',
      NOW,
    );
    expect(next).toMatchObject({ plan: 'max', source: 'turn', usedAt: NOW, error: null });
    expect(next.windows.map((x) => [x.kind, x.usedPct])).toEqual([
      ['five_hour', 86],
      ['seven_day', 70],
    ]);
  });

  it('normalizes a reset time to the whole minute', () => {
    expect(normalizeWindow(w('five_hour', 1, { resetsAt: '2026-09-29T15:59:59.600Z' })).resetsAt).toBe(
      '2026-09-29T16:00:00.000Z',
    );
  });
});

describe('alerts: once per window, level and reset', () => {
  it('80 %, then 95 %, then the limit; never again for the same window', () => {
    let r = row({ windows: [w('five_hour', 82)] });
    let due = dueAlerts(r);
    expect(due.alerts.map((a) => a.level)).toEqual([80]);
    r = { ...r, alerts: due.keys };
    expect(dueAlerts(r).alerts).toEqual([]);
    r = { ...r, windows: [w('five_hour', 96)] };
    due = dueAlerts(r);
    expect(due.alerts.map((a) => a.level)).toEqual([95]);
    r = { ...r, alerts: due.keys, windows: [w('five_hour', 100)] };
    due = dueAlerts(r);
    expect(due.alerts.map((a) => a.level)).toEqual(['limited']);
    r = { ...r, alerts: due.keys };
    expect(dueAlerts(r).alerts).toEqual([]);
  });

  it('a jump from 70 % to 97 % says 95 % once, never 80 % after it', () => {
    let r = row({ windows: [w('five_hour', 97)] });
    const due = dueAlerts(r);
    expect(due.alerts.map((a) => a.level)).toEqual([95]);
    r = { ...r, alerts: due.keys, windows: [w('five_hour', 85)] };
    expect(dueAlerts(r).alerts).toEqual([]);
  });

  it('the next window (another reset time) alerts again; each window on its own', () => {
    const first = row({ windows: [w('five_hour', 85)] });
    const keys = dueAlerts(first).keys;
    const next = row({
      alerts: keys,
      windows: [w('five_hour', 85, { resetsAt: '2026-09-29T21:00:00.000Z' }), w('seven_day', 96)],
    });
    expect(dueAlerts(next).alerts.map((a) => [a.window.kind, a.level])).toEqual([
      ['five_hour', 80],
      ['seven_day', 95],
    ]);
  });

  it('nothing for an API key; the remembered keys stay bounded', () => {
    expect(dueAlerts(row({ kind: 'api_key', windows: [w('five_hour', 99)] })).alerts).toEqual([]);
    const many = row({
      alerts: Array.from({ length: 70 }, (_, i) => `k${i}`),
      windows: [w('five_hour', 90)],
    });
    expect(dueAlerts(many).keys).toHaveLength(64);
  });
});
