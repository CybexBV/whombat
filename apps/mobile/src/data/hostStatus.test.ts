import { type HostChartPoint, hostChartPoints, hostDayRows, hostTiles } from '@whombat/client';
import { NBSP } from '@whombat/core/text';
import { HOST_METRICS_POINTS, HOST_METRICS_RANGES, HostMetrics } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { HOST_FIXTURE_ZONE, hostMetricsFixture } from '../fixtures/host';
import {
  areaPath,
  bandAtX,
  chartLabel,
  columnPath,
  columnStack,
  cpuMeasured,
  dayReadout,
  HOST_CHARTS,
  HOST_RANGE_OPTIONS,
  hostDiskTone,
  hostSectionKind,
  indexAtX,
  linePath,
  nearestMeasured,
  networkReadout,
  processorReadout,
  readoutText,
  sparkline,
  stepMeasured,
} from './hostStatus';

const n = (s: string) => s.replaceAll(NBSP, ' ');

describe('the section (BS-01, BS-06)', () => {
  it('shows the box, the sentence, nothing without a manager, or a quiet frame first; tokens are Spend’s', () => {
    const metrics = hostMetricsFixture('day');
    expect(hostSectionKind({ metrics, reason: null })).toBe('box');
    expect(hostSectionKind({ metrics: null, reason: 'unavailable' })).toBe('unavailable');
    expect(hostSectionKind({ metrics: null, reason: 'not_managed' })).toBe('none');
    expect(hostSectionKind({ metrics: null, reason: null })).toBe('loading');
  });

  it('names the charts and the ranges with the contracts’ words, in the web’s order', () => {
    expect(HOST_CHARTS.map((c) => c.label)).toEqual(['Processor', 'Network speed', 'Data per day', 'Disk']);
    expect(HOST_RANGE_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ['hour', 'Last hour'],
      ['day', '24 hours'],
      ['week', '7 days'],
      ['month', '30 days'],
    ]);
  });
});

describe('the fixture (the approved mockup)', () => {
  it('keeps to the contracts in every range', () => {
    for (const range of HOST_METRICS_RANGES) {
      const m = HostMetrics.parse(hostMetricsFixture(range));
      expect(m.series.points).toHaveLength(HOST_METRICS_POINTS[range]);
    }
  });

  it('says what the mock’s tiles say', () => {
    const t = hostTiles(hostMetricsFixture('day'));
    expect(n(t.processor.value)).toBe('4 %');
    expect(n(t.processor.line ?? '')).toMatch(/^Peak [89]\d % at 14:\d5$/);
    expect([t.memory.value, n(t.memory.unit)]).toEqual(['1.8', 'of 16 GB']);
    expect(n(t.memory.line ?? '')).toContain('600 MB');
    expect([t.disk.value, n(t.disk.unit), n(t.disk.line)]).toEqual(['40', 'of 87 GB', '46 GB free']);
    expect([n(t.today.value), t.today.unit, n(t.today.line)]).toEqual(['2.2 GB', 'in', '41 MB out']);
  });
});

describe('the readout above a chart', () => {
  const metrics = hostMetricsFixture('day');
  const points = hostChartPoints(metrics.series);

  it('says a point’s moment and its values, the values in bold', () => {
    const last = points.at(-1) as HostChartPoint;
    const cpu = processorReadout(last, 'day', HOST_FIXTURE_ZONE);
    expect(cpu.title).toBe('21:35');
    expect(cpu.lines.map((l) => [l.swatch, n(l.value), l.rest])).toEqual([['chart1', '4 %', 'busy']]);
    const net = networkReadout({ ...last, downBps: 12_000_000, upBps: 400_000 }, 'week', HOST_FIXTURE_ZONE);
    expect(net.title).toBe('Sun 11 Oct · 21:35');
    expect(net.lines.map((l) => [l.swatch, n(l.value), l.rest])).toEqual([
      ['chart1', '12 Mbit/s', 'down'],
      ['chart2', '0.4 Mbit/s', 'up'],
    ]);
    expect(n(readoutText(net))).toBe('Sun 11 Oct · 21:35, 12 Mbit/s down, 0.4 Mbit/s up');
  });

  it('says a day’s traffic', () => {
    const today = hostDayRows(metrics.days).at(-1);
    if (!today) throw new Error('no days');
    expect(dayReadout(today).lines.map((l) => l.swatch)).toEqual(['chart1', 'chart2']);
    expect(n(readoutText(dayReadout(today)))).toContain('2.2 GB');
  });

  it('snaps to the nearest measured point across a gap', () => {
    const gappy = points.map((p, i) => (i >= 100 && i < 110 ? { ...p, cpuPct: null } : p));
    expect(nearestMeasured(gappy, 103, cpuMeasured)).toBe(99);
    expect(nearestMeasured(gappy, 107, cpuMeasured)).toBe(110);
    expect(nearestMeasured(gappy, 9_999, cpuMeasured)).toBe(points.length - 1);
    expect(
      nearestMeasured(
        points.map((p) => ({ ...p, cpuPct: null })),
        5,
        cpuMeasured,
      ),
    ).toBeNull();
  });

  it('moves TalkBack along a chart past a gap, and stops at its ends', () => {
    const gappy = points.map((p, i) => (i >= 100 && i < 130 ? { ...p, cpuPct: null } : p));
    expect(stepMeasured(gappy, 90, 1, 12, cpuMeasured)).toBe(130);
    expect(stepMeasured(gappy, 130, -1, 12, cpuMeasured)).toBe(99);
    expect(stepMeasured(gappy, 280, 1, 12, cpuMeasured)).toBe(points.length - 1);
    expect(stepMeasured(gappy, points.length - 1, 1, 12, cpuMeasured)).toBe(points.length - 1);
    expect(stepMeasured(gappy, 5, -1, 12, cpuMeasured)).toBe(0);
  });

  it('names a chart for TalkBack with what it covers', () => {
    expect(chartLabel('Processor', '24 hours', 'Peak 86 % at 14:25')).toBe(
      'Processor, 24 hours, Peak 86 % at 14:25',
    );
    expect(chartLabel('Tokens', '3.4M today', null)).toBe('Tokens, 3.4M today');
  });
});

describe('the disk’s colours (BS-10)', () => {
  it('gives the three largest parts of the mock the chart colours, Free the track', () => {
    expect(
      ['containers', 'whombat', 'work', 'database', 'free'].map((k) => hostDiskTone(k as never, true)),
    ).toEqual(['chart1', 'chart2', 'chart3', 'mut', 'free']);
    expect(hostDiskTone('other', true)).toBe('line2');
    // While the parts are recounted, Other is all of used.
    expect(hostDiskTone('other', false)).toBe('chart1');
  });
});

describe('geometry (BS-11)', () => {
  const x = (i: number) => i * 10;
  const y = (v: number) => 100 - v;

  it('breaks a line where nothing was measured and closes one wash per run', () => {
    expect(linePath([1, 2, null, 4, 5], x, y)).toBe('M0.0 99.0L10.0 98.0M30.0 96.0L40.0 95.0');
    expect(areaPath([1, 2, null, 4], x, y, 100)).toBe('M0.0 99.0L10.0 98.0L10.0 100.0L0.0 100.0Z');
    expect(linePath([null, null], x, y)).toBe('');
  });

  it('rounds a column’s top corners by 4, never more than half its height', () => {
    expect(columnPath(10, 8, 20, 30, 4)).toBe('M6.0 50.0V24.0q0 -4.0 4.0 -4.0H10.0q4.0 0 4.0 4.0V50.0Z');
    expect(columnPath(10, 8, 20, 2, 4)).toContain('V21.0q0 -1.0 1.0 -1.0');
  });

  it('stacks parts bottom up, 2 apart, only the topmost rounded, empty values left out', () => {
    const parts = columnStack([50, 10], y);
    expect(parts).toEqual([
      { index: 0, top: 50, height: 50, radius: 0 },
      { index: 1, top: 40, height: 8, radius: 4 },
    ]);
    expect(columnStack([30, 0], y)).toEqual([{ index: 0, top: 70, height: 30, radius: 4 }]);
    expect(columnStack([0, 0], y)).toEqual([]);
  });

  it('turns a finger into a point or a column', () => {
    expect(indexAtX(34, 34, 288, 288)).toBe(0);
    expect(indexAtX(34 + 144, 34, 288, 288)).toBe(144);
    expect(indexAtX(999, 34, 288, 288)).toBe(287);
    expect(bandAtX(34 + 299, 34, 300, 14)).toBe(13);
    expect(bandAtX(0, 34, 300, 14)).toBe(0);
  });

  it('draws a sparkline of at most 96 values, the latest always in it with the dot', () => {
    const values = Array.from({ length: 288 }, (_, i) => (i === 287 ? 50 : 10));
    const s = sparkline(values, 100, 26);
    expect(s.path.match(/[ML]/g)).toHaveLength(96);
    expect(s.dot).toEqual({ x: 98, y: 3 });
    expect(sparkline([null, null, null], 100, 26).dot).toBeNull();
    expect(sparkline([1, 2], 0, 26).path).toBe('');
  });
});
