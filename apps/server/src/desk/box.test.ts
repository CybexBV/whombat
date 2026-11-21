import { DeskBox } from '@whombat/control-contracts/local';
import { deskBox } from '@whombat/core';
import type { HostSeries } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import type { HostMetricsService } from '../managed/host-metrics';
import { sampleHostMetrics } from '../managed/testing';
import type { Services } from '../services';
import { HostSeriesWindow } from './box';
import { HostPower } from './power';

const T0 = Date.parse('2026-10-20T12:00:00.000Z');
const point = (cpuPermille: number) => ({
  cpuPermille,
  cpuPeakPermille: cpuPermille,
  memoryUsedBytes: 6e9,
  inBytes: 24_000_000,
  outBytes: 3_100_000,
});

/** `n` points of 10 s from `start` (ms), null where `gaps` says. */
function series(start: number, n: number, gaps: number[] = []): HostSeries {
  return {
    range: 'hour',
    start: new Date(start).toISOString(),
    stepS: 10,
    points: Array.from({ length: n }, (_, i) => (gaps.includes(i) ? null : point(100 + i))),
  };
}

describe('the last hour’s points (DK-22)', () => {
  it('asks for the whole hour first, then for the points since the last', () => {
    const w = new HostSeriesWindow();
    expect(w.since(T0)).toBeUndefined();
    expect(w.series()).toBeNull();
    w.add(series(T0 - 3_600_000, 360), T0);
    expect(w.since(T0)).toBe(new Date(T0).toISOString());
    w.add(series(T0, 2), T0 + 20_000);
    const s = w.series();
    expect(s?.points).toHaveLength(360);
    expect(s?.start).toBe(new Date(T0 + 20_000 - 3_600_000).toISOString());
    expect(s?.points.at(-1)).toMatchObject({ cpuPermille: 101 });
    expect(w.since(T0 + 20_000)).toBe(new Date(T0 + 20_000).toISOString());
  });

  it('keeps a gap a gap, and a box just started has a short window', () => {
    const w = new HostSeriesWindow();
    w.add(series(T0 - 60_000, 6, [2, 3]), T0);
    const s = w.series();
    expect(s?.points.map((p) => p?.cpuPermille ?? null)).toEqual([100, 101, null, null, 104, 105]);
    expect(s?.start).toBe(new Date(T0 - 60_000).toISOString());
    // A read with nothing new changes nothing.
    w.add(series(T0, 0), T0 + 5_000);
    expect(w.series()?.points).toHaveLength(6);
  });

  it('starts again after an hour away', () => {
    const w = new HostSeriesWindow();
    w.add(series(T0 - 60_000, 6), T0);
    expect(w.since(T0 + 2 * 3_600_000)).toBeUndefined();
    w.add(series(T0 + 2 * 3_600_000 - 30_000, 3), T0 + 2 * 3_600_000);
    expect(w.series()?.points).toHaveLength(3);
  });
});

describe('reading the panel with the power (DK-22)', () => {
  function setup() {
    let now = T0;
    const asked: { since?: string }[] = [];
    let answer: 'ok' | 'down' = 'ok';
    const host = {
      read: async (input: { since?: string }) => {
        asked.push({ ...(input.since ? { since: input.since } : {}) });
        if (answer === 'down') return { metrics: null, reason: 'unavailable' };
        const metrics = sampleHostMetrics({ at: new Date(now).toISOString(), points: input.since ? 1 : 360 });
        return { metrics, reason: null };
      },
    } as unknown as HostMetricsService;
    const services = { clock: () => new Date(now) } as unknown as Services;
    const power = new HostPower(services, host);
    return {
      power,
      asked,
      later: (ms: number) => {
        now += ms;
      },
      down: () => {
        answer = 'down';
      },
    };
  }

  it('reads no points while nobody wants the panel, the hour once it is wanted, then every 10 s since', async () => {
    const { power, asked, later } = setup();
    await power.read();
    expect(asked).toEqual([{ since: new Date(T0).toISOString() }]);
    expect(power.peekBox()).not.toBeNull();
    await power.read();
    expect(asked[1]).toEqual({});
    const box = power.peekBox();
    expect(box?.input.series.points.length).toBeGreaterThan(300);
    expect(box?.input.now.cores).toBe(8);
    // Within 10 s the same reading, nothing asked.
    later(5_000);
    expect(power.peekBox()?.at).toBe(box?.at);
    expect(asked).toHaveLength(2);
    later(5_000);
    power.peekBox();
    await power.read();
    expect(asked[2]?.since).toBeDefined();
  });

  it('makes a panel the screen takes: the hour as 60 minutes, the network from the last point', async () => {
    const { power } = setup();
    power.peekBox();
    await power.read();
    const read = power.peekBox();
    if (!read) throw new Error('no reading');
    const box = DeskBox.parse(deskBox(read.input));
    expect(box.history.cpu).toHaveLength(60);
    expect(box.history.memory).toHaveLength(60);
    expect(box.history.cpu.at(-1)).toBe(12);
    expect(box.cpu).toMatchObject({ percent: 12, cores: 8 });
    expect(box.network?.down).toMatch(/kB\/s$/);
    expect(box.storage.parts.map((p) => p.key)).toEqual(['whombat', 'agent']);
  });

  it('asks a manager that hasn’t measured yet again after 10 s, one that doesn’t answer after 5 minutes', async () => {
    let now = T0;
    let calls = 0;
    const host = {
      unmeasured: true,
      read: async () => {
        calls++;
        return { metrics: null, reason: 'unavailable' };
      },
    };
    const power = new HostPower({ clock: () => new Date(now) } as unknown as Services, host as never);
    await power.read();
    now += 10_000;
    await power.read();
    expect(calls).toBe(2);
    host.unmeasured = false;
    now += 10_000;
    await power.read();
    now += 60_000;
    await power.read();
    expect(calls).toBe(2 + 1);
  });

  it('has no panel when the manager doesn’t answer', async () => {
    const { power, down, later } = setup();
    power.peekBox();
    await power.read();
    expect(power.peekBox()).not.toBeNull();
    down();
    later(10_000);
    power.peekBox();
    await power.read();
    expect(power.peekBox()).toBeNull();
  });
});
