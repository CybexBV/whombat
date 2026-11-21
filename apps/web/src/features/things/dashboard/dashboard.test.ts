/**
 * The Summary renderer's pure parts (dashboards-web.md AP-2050…): a chart row's columns and which cards take the whole
 * width in two columns, the chart model's colours, axes, bars, forecast and words (DS-06, DS-15), and the small line's
 * scale.
 */
import { describe, expect, it } from 'vitest';
import { axisOver, type ChartPanel, chartModel, formatFigure, spanRange, tickWords } from './chartModel';
import { chartRowColumns, twoColumnFull } from './layout';
import { sparkDomain } from './Spark';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-18T10:00:00Z');
const stamps = (n: number, step = HOUR / 4) =>
  Array.from({ length: n }, (_, k) => new Date(T0 + k * step).toISOString());

function chart(over: Partial<ChartPanel>): ChartPanel {
  return {
    kind: 'chart',
    id: 'cpu',
    place: 'chart',
    title: 'CPU',
    timestamps: stamps(4),
    series: [{ key: 'cpu', label: 'CPU', unit: '%', values: [1, 2, 3, 4] }],
    ...over,
  } as ChartPanel;
}

describe('chart rows (DS-04)', () => {
  it('shares three columns evenly and lines a wide card up with the main and side columns', () => {
    expect(chartRowColumns([1, 1, 1])).toBe('minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)');
    expect(chartRowColumns([2, 1])).toBe('minmax(0, 1.85fr) minmax(0, 1fr)');
    expect(chartRowColumns([1, 2])).toBe('minmax(0, 1fr) minmax(0, 1.85fr)');
    expect(chartRowColumns([3])).toBe('minmax(0, 3fr)');
    // A row that isn't full fills the width by its spans.
    expect(chartRowColumns([1, 1])).toBe('minmax(0, 1fr) minmax(0, 1fr)');
  });

  it('gives a wide card and a card left alone the whole width in two columns', () => {
    expect(twoColumnFull([1, 1, 1])).toEqual([false, false, true]);
    expect(twoColumnFull([2, 1])).toEqual([true, true]);
    expect(twoColumnFull([1, 2])).toEqual([true, true]);
    expect(twoColumnFull([1, 1])).toEqual([false, false]);
    expect(twoColumnFull([3])).toEqual([true]);
  });
});

describe('the chart model (DS-06, DS-15)', () => {
  it('colours lines by name, else blue, orange, green, violet in order, and washes only what asks', () => {
    const m = chartModel(
      chart({
        series: [
          { key: 'a', label: 'In', values: [1, 2], color: 'green', fill: true },
          { key: 'b', label: 'Out', values: [2, 1] },
          { key: 'c', label: 'Hot', values: [3, 3], color: 'amber' },
          { key: 'd', label: 'Else', values: [0, 0], color: 'grey' },
          { key: 'e', label: 'Four', values: [1, 1] },
        ],
        timestamps: stamps(2),
      }),
    );
    expect(m.lines.map((l) => [l.color, l.fill])).toEqual([
      ['var(--chart3)', true],
      ['var(--chart2)', false],
      ['var(--warn)', false],
      ['var(--mut)', false],
      ['var(--chart1)', false],
    ]);
  });

  it('keeps a 0.88 card’s wash under its first line', () => {
    const m = chartModel(chart({ place: undefined, width: 'wide' } as Partial<ChartPanel>));
    expect(m.lines[0]?.fill).toBe(true);
  });

  it('uses the card’s fixed ends and unit, and holds the limit and the forecast', () => {
    expect(chartModel(chart({ axis: { min: 0, max: 100, unit: '%' } })).left.ticks).toEqual([0, 50, 100]);
    const disk = chartModel(
      chart({
        axis: { min: 50, unit: '%' },
        series: [{ key: 'd', label: 'Disk', unit: '%', values: [64, 70, 76] }],
        timestamps: stamps(3, 24 * HOUR),
        forecast: { at: new Date(T0 + 63 * 24 * HOUR).toISOString(), value: 100, label: 'full ~18 Dec' },
      }),
    );
    expect(disk.left.ticks).toEqual([50, 75, 100]);
    expect(disk.left.label(75)).toBe('75%');
    expect(disk.forecast).toEqual({ value: 100, label: 'full ~18 Dec', extend: 61 });
    // The time axis runs on past “Now” to the forecast, in days.
    expect(disk.ticks.at(-1)?.index).toBe(63);
    const temp = chartModel(
      chart({ series: [{ key: 't', label: 'Pkg', unit: '°C', values: [60, 70] }], line: { value: 85 } }),
    );
    expect(temp.left.max).toBeGreaterThanOrEqual(85);
    expect(temp.limit).toEqual({ value: 85, label: null });
  });

  it('stacks bars for the axis and draws no wash under them', () => {
    const m = chartModel(
      chart({
        style: 'bars',
        series: [
          { key: 'top', label: 'Modbus', values: [400, 900], fill: true },
          { key: 'rest', label: 'Everything else', values: [50, 80] },
        ],
        timestamps: stamps(2, HOUR),
      }),
    );
    expect(m.bars).toBe(true);
    expect(m.left.max).toBeGreaterThanOrEqual(980);
    expect(m.lines.every((l) => !l.fill)).toBe(true);
  });

  it('maps a second unit onto the left scale and says each value in its own words', () => {
    const m = chartModel(
      chart({
        place: undefined,
        series: [
          { key: 'cpu', label: 'CPU', unit: '%', values: [5, 10] },
          { key: 'mem', label: 'Memory', unit: 'GB', axis: 'right', values: [2, 4] },
        ],
        timestamps: stamps(2),
      } as Partial<ChartPanel>),
    );
    expect(m.right).not.toBeNull();
    const mem = m.lines[1];
    expect(mem?.formatPlotted(mem.plotted[1] as number)).toBe('4 GB');
    expect(m.drawn[0]?.key).toBe('mem');
  });

  it('words numbers as DS-15 does and its axes densely', () => {
    expect(formatFigure(2.44, true)).toBe('2.4');
    expect(formatFigure(63.2, true)).toBe('63');
    expect(formatFigure(11280, false)).toBe('11,280');
    expect(tickWords('°C')(60)).toBe('60°');
    expect(tickWords('GB')(8)).toBe('8 GB');
    expect(tickWords('Mb/s')(500)).toBe('500');
    expect(axisOver([0, 4.6], '%').ticks).toEqual([0, 2.5, 5]);
  });

  it('speaks a 30-day chart in days whatever the page’s range', () => {
    expect(spanRange([T0, T0 + HOUR])).toBe('1h');
    expect(spanRange([T0, T0 + 24 * HOUR])).toBe('24h');
    expect(spanRange([T0, T0 + 30 * 24 * HOUR])).toBe('7d');
  });

  it('says a chart without a reading is empty', () => {
    expect(chartModel(chart({ series: [{ key: 'x', label: 'X', values: [null, null] }] })).empty).toBe(true);
  });
});

describe('the small line', () => {
  it('scales between its own lowest and highest value with room around them', () => {
    expect(sparkDomain([10, 20])).toEqual([8.5, 21.5]);
    expect(sparkDomain([null, null])).toBeNull();
    const [lo, hi] = sparkDomain([5, 5]) ?? [0, 0];
    expect(lo).toBeLessThan(5);
    expect(hi).toBeGreaterThan(5);
  });
});
