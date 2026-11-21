import { describe, expect, it } from 'vitest';
import type { DeskBox } from './desk';
import { CHART_H, CHART_W, chartLine, chartTop, pointX, storageBar, TEMP_SEGMENTS, tempLit } from './deskBox';

const box = (cpu: (number | null)[], memory: (number | null)[], now = { cpu: 5, memory: 10 }) => ({
  cpu: { percent: now.cpu, cores: 16, tone: 'ok' as const },
  memory: { percent: now.memory, used: { value: '6.4', unit: 'GB' }, total: '64 GB', tone: 'ok' as const },
  history: { stepS: 60, cpu, memory },
});

describe('the chart’s scale (CG-58)', () => {
  it('is the smallest of 25, 50 and 100 % that holds the hour and the figures now', () => {
    expect(chartTop(box([3, 24, null], [18, 18, null]))).toBe(25);
    expect(chartTop(box([3, 26], [18, 18]))).toBe(50);
    expect(chartTop(box([3, 5], [18, 51]))).toBe(100);
    // A spike now that isn't a point yet still fits.
    expect(chartTop(box([3, 5], [18, 18], { cpu: 40, memory: 18 }))).toBe(50);
    expect(chartTop(box([], []))).toBe(25);
  });
});

describe('where the points go', () => {
  it('ends now, one step apart, so a short hour fills only its end', () => {
    expect(pointX(0, 60, 60)).toBe(0);
    expect(pointX(59, 60, 60)).toBe(1);
    expect(pointX(0, 12, 60)).toBeCloseTo(48 / 59);
    expect(pointX(11, 12, 60)).toBe(1);
    expect(pointX(0, 1, 3600)).toBe(1);
  });

  it('draws a run per stretch of measured points: a gap breaks the line, a lone point is a dot', () => {
    const { line, area } = chartLine([10, 20, null, 30, null, 40, 50], 600, 50);
    // 7 points at a step of 10 min: an hour is 6 steps, the first point an hour ago.
    expect(line.match(/M/g)).toHaveLength(3);
    expect(line).toContain(`M0 ${CHART_H - 0.2 * CHART_H}`);
    expect(line).toContain('h0');
    expect(area.match(/Z/g)).toHaveLength(2);
    expect(line.endsWith(`L${CHART_W} 0`)).toBe(true);
  });

  it('keeps the line inside the chart', () => {
    const { line } = chartLine([0, 120], 3600 / 1, 100);
    expect(line).toContain(` ${CHART_H}`);
    expect(line.endsWith(`L${CHART_W} 0`)).toBe(true);
    expect(chartLine([null, null], 60, 25)).toEqual({ line: '', area: '' });
  });
});

describe('storage and temperature', () => {
  const storage = (percent: number, parts: DeskBox['storage']['parts']): DeskBox['storage'] => ({
    percent,
    free: { value: '812', unit: 'GB' },
    total: '937 GB',
    tone: 'ok',
    parts,
  });

  it('shows the parts, then the rest of what is used', () => {
    const parts = [
      { key: 'whombat' as const, value: '41 GB', percent: 4 },
      { key: 'agent' as const, value: '84 GB', percent: 9 },
    ];
    expect(storageBar(storage(13, parts)).map((p) => p.key)).toEqual(['whombat', 'agent']);
    expect(storageBar(storage(20, parts)).at(-1)).toEqual({ key: 'other', percent: 7 });
    expect(storageBar(storage(88, []))).toEqual([{ key: 'other', percent: 88 }]);
  });

  it('lights the temperature’s segments up to 95°', () => {
    expect(tempLit(46)).toBe(15);
    expect(tempLit(0)).toBe(0);
    expect(tempLit(120)).toBe(TEMP_SEGMENTS);
  });
});
