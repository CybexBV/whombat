/**
 * How the box is doing (box-status.md AP-1135): the tiles, a live poll merged into the range, the charts' points and
 * words, the disk's parts and the Tokens card, from `host.metrics`, `spend.daily` and `spend.overview`.
 */
import type { SpendDaily, SpendOverview, SpendTotals } from '@whombat/core/domain';
import { NBSP } from '@whombat/core/text';
import type { HostMetrics, HostPoint, HostSeries } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import type { ApplianceSession } from '../session/types';
import {
  hostChartPoints,
  hostDayLines,
  hostDayRows,
  hostDayScale,
  hostDayTick,
  hostDiskBar,
  hostDiskRows,
  hostDiskText,
  hostMeasuringNote,
  hostMetricsLoader,
  hostPointLabel,
  hostSince,
  hostSpeedScale,
  hostSpeedTick,
  hostTiles,
  hostTimeTicks,
  hostTokens,
  mergeHostSeries,
  niceCeiling,
  splitLead,
} from './model';

const GB = 1_000_000_000;
const TZ = 'Europe/Amsterdam';
/** 21:40 in Amsterdam on Sunday 11 October 2026. */
const END = Date.parse('2026-10-11T19:40:00.000Z');

const n = (s: string) => s.replaceAll(NBSP, ' ');

function point(cpu: number, patch: Partial<HostPoint> = {}): HostPoint {
  return {
    cpuPermille: cpu,
    cpuPeakPermille: cpu,
    memoryUsedBytes: 1.8 * GB,
    inBytes: 0,
    outBytes: 0,
    ...patch,
  };
}

/** A day's range (5-minute steps) ending at `END`, every point at 3 % but `peaks` (index → permille). */
function daySeries(count = 288, peaks: Record<number, number> = {}): HostSeries {
  return {
    range: 'day',
    stepS: 300,
    start: new Date(END - count * 300_000).toISOString(),
    points: Array.from({ length: count }, (_, i) => point(30, { cpuPeakPermille: peaks[i] ?? 40 })),
  };
}

function metrics(patch: Partial<HostMetrics> = {}): HostMetrics {
  const series = patch.series ?? daySeries();
  return {
    now: {
      at: new Date(END).toISOString(),
      cpuPermille: 42,
      cores: 4,
      memoryTotalBytes: 16 * GB,
      memoryUsedBytes: 1.8 * GB,
      containersMemoryBytes: 0.6 * GB,
      uplink: ['enp5s0'],
    },
    disks: {
      data: {
        totalBytes: 87 * GB,
        usedBytes: 40.4 * GB,
        freeBytes: 46 * GB,
        parts: [
          { key: 'work', bytes: 7.5 * GB },
          { key: 'containers', bytes: 22.9 * GB },
          { key: 'whombat', bytes: 9.6 * GB },
          { key: 'database', bytes: 0 },
        ],
      },
      system: { totalBytes: 20 * GB, usedBytes: 6.1 * GB, freeBytes: 13 * GB },
      backup: null,
    },
    series,
    days: Array.from({ length: 30 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 8, 12 + i)).toISOString().slice(0, 10),
      inBytes: 1.2 * GB,
      outBytes: 40_000_000,
    })).map((d, i, all) => (i === all.length - 1 ? { ...d, inBytes: 2.2 * GB, outBytes: 41_000_000 } : d)),
    timeZone: TZ,
    measuringSince: '2026-09-01T00:00:00.000Z',
    ...patch,
  };
}

describe('hostTiles (BS-10)', () => {
  it('says what the mock’s tiles say: now and the peak, used of total, free, today in and out', () => {
    // The peak: 86 % at 14:25 Amsterdam (the range starts at 21:40 yesterday).
    const t = hostTiles(metrics({ series: daySeries(288, { 201: 860 }) }));
    expect(n(t.processor.value)).toBe('4 %');
    expect(n(t.processor.line ?? '')).toBe('Peak 86 % at 14:25');
    expect(t.processor.spark).toHaveLength(288);
    expect([t.memory.value, n(t.memory.unit), n(t.memory.line ?? '')]).toEqual([
      '1.8',
      'of 16 GB',
      'Apps and sites 600 MB',
    ]);
    expect(Math.round(t.memory.pct)).toBe(11);
    expect([t.disk.value, n(t.disk.unit), n(t.disk.line)]).toEqual(['40.4', 'of 87 GB', '46 GB free']);
    expect(Math.round(t.disk.pct)).toBe(47);
    expect([n(t.today.value), t.today.unit, n(t.today.line)]).toEqual(['2.2 GB', 'in', '41 MB out']);
  });

  it('keeps the unit when used and total differ in it, and leaves out what isn’t known', () => {
    const m = metrics();
    const t = hostTiles({
      ...m,
      now: { ...m.now, memoryUsedBytes: 850_000_000, containersMemoryBytes: null },
      series: { ...m.series, points: m.series.points.map(() => null) },
    });
    expect(n(t.memory.value)).toBe('850 MB');
    expect(t.memory.line).toBeNull();
    expect(t.processor.line).toBeNull();
  });
});

describe('a live poll (BS-08)', () => {
  it('asks from the end of the last point', () => {
    expect(hostSince(daySeries())).toBe('2026-10-11T19:40:00.000Z');
  });

  it('adds the new points, drops what falls out of the range and leaves a missed step empty', () => {
    const current = daySeries();
    const next: HostSeries = {
      range: 'day',
      stepS: 300,
      // One step skipped (19:40 never came), then two new points.
      start: '2026-10-11T19:45:00.000Z',
      points: [point(500), point(600)],
    };
    const merged = mergeHostSeries(current, next);
    expect(merged.points).toHaveLength(288);
    expect(merged.start).toBe(new Date(Date.parse(current.start) + 3 * 300_000).toISOString());
    expect(merged.points.slice(-3)).toEqual([null, point(500), point(600)]);
    expect(hostSince(merged)).toBe('2026-10-11T19:55:00.000Z');
  });

  it('replaces a point it already has, and starts over for another range or after a long time away', () => {
    const current = daySeries(10);
    const again = mergeHostSeries(current, { ...current, start: hostSince(current), points: [] });
    expect(again.points).toHaveLength(10);
    const last: HostSeries = {
      ...current,
      start: new Date(END - 300_000).toISOString(),
      points: [point(900)],
    };
    expect(mergeHostSeries(current, last).points.at(-1)).toEqual(point(900));
    const hour: HostSeries = { range: 'hour', stepS: 10, start: current.start, points: [point(1)] };
    expect(mergeHostSeries(current, hour)).toBe(hour);
    const later: HostSeries = { ...current, start: new Date(END + 2 * 86_400_000).toISOString(), points: [] };
    expect(mergeHostSeries(current, later)).toBe(later);
  });
});

describe('the charts', () => {
  it('pad a short range at the old end, in percent and bits per second', () => {
    const s = daySeries(2);
    s.points[1] = point(125, { cpuPeakPermille: 40, inBytes: 3_750_000, outBytes: 0 });
    const pts = hostChartPoints(s);
    expect(pts).toHaveLength(288);
    expect(pts[0]?.cpuPct).toBeNull();
    expect(pts.at(-1)).toEqual({
      at: END - 300_000,
      cpuPct: 12.5,
      cpuPeakPct: 4,
      downBps: 100_000,
      upBps: 0,
    });
  });

  it('put five ticks on the time axis, the last one “now”', () => {
    const pts = hostChartPoints(daySeries());
    expect(hostTimeTicks(pts, 'day', TZ)).toEqual([
      { index: 0, label: '21:40' },
      { index: 72, label: '03:40' },
      { index: 144, label: '09:40' },
      { index: 215, label: '15:35' },
      { index: 287, label: 'now' },
    ]);
    expect(hostTimeTicks(pts, 'week', TZ)[1]?.label).toBe('Sun');
    expect(hostTimeTicks(pts, 'month', TZ)[0]?.label).toBe('10 Oct');
    expect(hostPointLabel(END, 'day', TZ)).toBe('21:40');
    expect(hostPointLabel(END, 'week', TZ)).toBe('Sun 11 Oct · 21:40');
  });

  it('round the scales up to numbers whose half is round too', () => {
    expect([0.3, 1, 3, 41, 76, 120, 900].map((v) => niceCeiling(v, 1))).toEqual([1, 1, 4, 50, 80, 200, 1000]);
    const pts = hostChartPoints(daySeries());
    expect(hostSpeedScale(pts)).toEqual({ max: 1_000_000, ticks: [0, 500_000, 1_000_000] });
    expect(hostSpeedTick(40_000_000)).toBe('40');
    expect(hostSpeedTick(2_500_000)).toBe('2.5');
  });

  it('split a tooltip line where its value ends', () => {
    expect(splitLead(`12${NBSP}Mbit/s down`)).toEqual({ value: `12${NBSP}Mbit/s`, rest: 'down' });
    expect(splitLead(`3.4M tokens`)).toEqual({ value: '3.4M', rest: 'tokens' });
  });

  it('say measuring since while the range reaches back before the first measurement', () => {
    expect(hostMeasuringNote(metrics())).toBeNull();
    expect(n(hostMeasuringNote(metrics({ measuringSince: '2026-10-11T12:02:00.000Z' })) ?? '')).toBe(
      'Measuring since 14:02. The charts fill in as time goes on.',
    );
  });
});

describe('Data per day (BS-05)', () => {
  it('shows 14 days, today last, a weekday under every third, received and sent in the tooltip', () => {
    const rows = hostDayRows(metrics().days);
    expect(rows).toHaveLength(14);
    expect(rows.map((r) => r.axis)).toEqual([
      '',
      'Tue',
      '',
      '',
      'Fri',
      '',
      '',
      'Mon',
      '',
      '',
      'Thu',
      '',
      '',
      'today',
    ]);
    expect(rows[0]?.title).toBe('Mon 28 Sep');
    expect(rows.at(-1)?.title).toBe('Today so far');
    const lines = hostDayLines(rows.at(-1) as (typeof rows)[number]);
    expect([n(lines.received), n(lines.sent)]).toEqual(['2.2 GB received', '41 MB sent']);
    const scale = hostDayScale(rows);
    expect(scale.max).toBe(4 * GB);
    expect(hostDayTick(scale.ticks[1], scale.max)).toBe('2');
  });
});

describe('the disk', () => {
  it('lists the parts largest first, then Other from half a gigabyte, then Free', () => {
    const m = metrics();
    const rows = hostDiskRows(m.disks.data);
    expect(rows.map((r) => [r.key, r.label, n(r.value)])).toEqual([
      ['containers', 'The agent’s containers', '22.9 GB'],
      ['whombat', 'Whombat’s own data', '9.6 GB'],
      ['work', 'Work folders', '7.5 GB'],
      ['free', 'Free', '46 GB'],
    ]);
    const more = hostDiskRows({ ...m.disks.data, usedBytes: 41.2 * GB });
    expect(more.map((r) => r.key)).toEqual(['containers', 'whombat', 'work', 'other', 'free']);
    expect(n(more[3]?.value ?? '')).toBe('1.2 GB');
    expect(n(hostDiskText(m.disks).used)).toBe('40.4 GB used of 87 GB');
    expect(hostDiskText(m.disks).others.map(n)).toEqual(['System 6.1 GB of 20 GB']);
  });

  it('draws used as one part while the parts are recounted', () => {
    const data = { ...metrics().disks.data, parts: null };
    const rows = hostDiskRows(data);
    expect(rows.map((r) => r.key)).toEqual(['free']);
    expect(hostDiskBar(data, rows).map((r) => [r.key, r.bytes])).toEqual([
      ['other', 40.4 * GB],
      ['free', 46 * GB],
    ]);
  });
});

const totals = (input: number, cacheRead: number, output: number): SpendTotals => ({
  turns: input > 0 ? 3 : 0,
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: 0,
  costUsd: null,
  costTurns: 0,
  unreportedTurns: 0,
});

describe('Tokens (BS-07)', () => {
  const daily: SpendDaily = {
    generatedAt: '2026-10-11T19:40:00.000Z',
    timeZone: TZ,
    days: Array.from({ length: 30 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 8, 12 + i)).toISOString().slice(0, 10),
      turns: 4,
      inputTokens: 10_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 9_400_000,
      cacheWriteTokens: 0,
    })),
  };
  const overview = {
    totals: { today: totals(1, 0, 0) },
  } as unknown as SpendOverview;

  it('says today’s total with the cache share and 14 columns', () => {
    const t = hostTokens(daily, overview);
    // Billed: 0.6M uncached + 0.94M cache reads at a tenth + 0.1M out.
    expect(n(t.summary)).toBe('1.6M today · 94 % read from cache');
    expect(t.days).toHaveLength(14);
    expect(t.days.at(-1)?.title).toBe('Today so far');
    expect(t.days.at(-1)?.line).toBe('1.6M tokens');
  });

  it('takes today from the overview while the days aren’t there', () => {
    expect(
      hostTokens(null, { ...overview, totals: { today: totals(2000, 0, 500) } } as SpendOverview).summary,
    ).toBe('2.5k today');
  });
});

describe('hostMetricsLoader', () => {
  it('asks the box', async () => {
    const asked: string[] = [];
    const session = {
      invoke: async (op: string) => {
        asked.push(op);
        return { status: 200, body: { metrics: null, reason: 'unavailable' } };
      },
    } as unknown as ApplianceSession;
    await expect(hostMetricsLoader(session)({ range: 'hour' })).resolves.toEqual({
      metrics: null,
      reason: 'unavailable',
    });
    expect(asked).toEqual(['host.metrics']);
  });
});
