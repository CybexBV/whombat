/**
 * What the NAS pages share in slots: the space added per day from Whombat's own readings, the Disks line, and the NAS
 * as its own machine.
 */
import { describe, expect, it } from 'vitest';
import { slotProblems } from '../slots';
import { disksLine, NAS_USED_KEY, signedSize, spaceWeek, usedPoint, withOwn } from './nas';

const now = new Date('2026-10-21T20:00:00Z');
const DAY = 86_400_000;
/** One reading a day at noon, `levels[i]` GB used `levels.length - 1 - i` days ago. */
const daily = (levels: (number | null)[]) =>
  levels.flatMap((value, i) =>
    value === null
      ? []
      : [{ at: new Date(now.getTime() - (levels.length - 1 - i) * DAY - 8 * 3600_000), value }],
  );

describe('space added per day', () => {
  it('draws what was added each day, and the week’s net as its figure', () => {
    const chart = spaceWeek({
      points: daily([1000, 1010, 1030, 1030, 1070, 1060, 1100, 1120]),
      now,
      timeZone: 'UTC',
      what: 'All pools',
    });
    expect(chart?.series[0]?.values).toEqual([10, 20, 0, 40, 0, 40, 20]);
    expect(chart?.figure).toEqual({ value: '+120 GB', rest: 'this week' });
    expect(chart?.meta).toBe('All pools');
    expect(chart?.labels?.at(-1)).toBe('Today');
  });

  it('says a week that freed space with a minus sign; its bars stay at zero', () => {
    const chart = spaceWeek({
      points: daily([500, 480, 470, 460]),
      now,
      timeZone: 'UTC',
      what: 'All volumes',
    });
    expect(chart?.figure?.value).toBe('−40 GB');
    expect(chart?.series[0]?.values.slice(-3)).toEqual([0, 0, 0]);
  });

  it('is left out until two days can be drawn', () => {
    expect(spaceWeek({ points: daily([500, 510]), now, timeZone: 'UTC', what: 'x' })).toBeNull();
    expect(spaceWeek({ points: [], now, timeZone: 'UTC', what: 'x' })).toBeNull();
  });

  it('compares with the week before once Whombat has it, and says when it is full at this pace', () => {
    const levels = Array.from({ length: 16 }, (_, i) => 1000 + i * (i > 8 ? 20 : 10));
    const chart = spaceWeek({ points: daily(levels), now, timeZone: 'UTC', freeBytes: 2e12, what: 'x' });
    expect(chart?.stats?.[0]?.[0]?.text).toMatch(/^\+\d+ %$/);
    expect(chart?.meta).toMatch(/^Full /);
  });

  it('keeps the pass’s reading in GB, and none without one', () => {
    expect(usedPoint(8_366_100_000_000)).toEqual({ [NAS_USED_KEY]: 8366.1 });
    expect(usedPoint(null)).toEqual({});
    expect([signedSize(0.01), signedSize(1200), signedSize(-0.4)]).toEqual(['0 GB', '+1.2 TB', '−400 MB']);
  });
});

describe('the Disks line', () => {
  const disk = (health: 'ok' | 'warn' | 'bad', tempC: number | null, warm?: 'warn' | 'bad') => ({
    health,
    tempC,
    warm,
  });

  it('says the worst of them, else that all are fine with the warmest', () => {
    const line = (ds: ReturnType<typeof disk>[]) => disksLine(ds, 'https://nas.lan').figure;
    expect(line([disk('ok', 34), disk('ok', 41)])).toEqual({ value: '2', note: 'All fine · warmest 41 °C' });
    expect(line([disk('ok', 61, 'bad'), disk('warn', 40)])).toMatchObject({
      note: '1 runs too hot',
      tone: 'bad',
    });
    expect(line([disk('bad', 30), disk('bad', 30)])).toMatchObject({ note: '2 need replacing', tone: 'bad' });
    expect(disksLine([disk('bad', 30)], 'https://nas.lan', 'is failing').figure?.note).toBe('1 is failing');
  });
});

describe('the NAS as its own machine', () => {
  it('gives the card its processor and memory under its name, never its pools as the Disk', () => {
    const got = withOwn(
      { panels: [], slots: { machine: [] } },
      {
        cpuPct: 7,
        cores: null,
        memoryUsedGb: 2,
        memoryTotalGb: 8,
        diskUsedGb: 100,
        diskTotalGb: 200,
        series: null,
      },
      'NAS-Home',
    );
    expect(got.slots?.own).toMatchObject({ name: 'NAS-Home', figures: { cpuPct: 7, diskUsedGb: null } });
    expect(slotProblems({ ...got, kpis: [] })).toEqual([]);
  });
});
