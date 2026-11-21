/**
 * Live while on screen (box-status.md BS-08, AP-1136): `host.metrics` every 10 seconds with `since`, the whole range on
 * a range change, spend on open and every 5 minutes, nothing while not active.
 */
import type { HostMetrics, HostMetricsInput, HostMetricsOutput, HostPoint } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { createHostPoller, type HostSpend } from './poller';

const START = Date.parse('2026-10-11T19:00:00.000Z');

function point(cpu: number): HostPoint {
  return {
    cpuPermille: cpu,
    cpuPeakPermille: cpu,
    memoryUsedBytes: 0,
    inBytes: 0,
    outBytes: 0,
  };
}

/** The manager: an hour's range of 10 s points ending at `end`, or only those from `since`. */
function metricsAt(end: number, input: HostMetricsInput): HostMetrics {
  const stepMs = input.range === 'hour' ? 10_000 : 300_000;
  const from = input.since ? Date.parse(input.since) : end - 360 * stepMs;
  const count = Math.max(0, Math.round((end - from) / stepMs));
  return {
    now: {
      at: new Date(end).toISOString(),
      cpuPermille: 10,
      cores: 4,
      memoryTotalBytes: 1,
      memoryUsedBytes: 0,
      containersMemoryBytes: null,
      uplink: [],
    },
    disks: {
      data: { totalBytes: 1, usedBytes: 0, freeBytes: 1, parts: null },
      system: { totalBytes: 1, usedBytes: 0, freeBytes: 1 },
      backup: null,
    },
    series: {
      range: input.range,
      stepS: stepMs / 1000,
      start: new Date(from).toISOString(),
      points: Array.from({ length: count }, (_, i) => point(Math.round((from + i * stepMs) / 10_000) % 1000)),
    },
    days: [],
    timeZone: 'UTC',
    measuringSince: '2026-01-01T00:00:00.000Z',
  };
}

function world(answer?: (input: HostMetricsInput) => HostMetricsOutput | Error) {
  let clock = START;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let ids = 0;
  const asked: HostMetricsInput[] = [];
  let spendAsked = 0;
  const pending: (() => void)[] = [];
  const poller = createHostPoller({
    range: 'hour',
    loadMetrics: (input) => {
      asked.push(input);
      return new Promise((resolve, reject) => {
        pending.push(() => {
          const a = answer ? answer(input) : { metrics: metricsAt(clock, input), reason: null };
          if (a instanceof Error) reject(a);
          else resolve(a);
        });
      });
    },
    loadSpend: async (): Promise<HostSpend> => {
      spendAsked += 1;
      return { daily: null, overview: null };
    },
    now: () => clock,
    setTimer: (fn, ms) => {
      ids += 1;
      timers.push({ at: clock + ms, fn, id: ids });
      return ids;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  /** Answers every open request. */
  const answerAll = async () => {
    while (pending.length) pending.shift()?.();
    await new Promise((r) => setTimeout(r, 0));
  };
  /** Moves the clock, firing timers that come due, answering what they ask. */
  const advance = async (ms: number) => {
    const until = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > until) break;
      timers.shift();
      clock = next.at;
      next.fn();
      await answerAll();
    }
    clock = until;
  };
  return {
    poller,
    asked,
    answerAll,
    advance,
    timers,
    spendAsked: () => spendAsked,
  };
}

describe('createHostPoller (BS-08)', () => {
  it('asks for nothing until it is active, then the whole range, then only what is new every 10 seconds', async () => {
    const w = world();
    expect(w.asked).toEqual([]);
    expect(w.poller.getState().loading).toBe(true);
    w.poller.setActive(true);
    await w.answerAll();
    expect(w.asked).toEqual([{ range: 'hour' }]);
    expect(w.poller.getState()).toMatchObject({ loading: false, reason: null });
    expect(w.poller.getState().metrics?.series.points).toHaveLength(360);
    await w.advance(10_000);
    expect(w.asked[1]).toEqual({ range: 'hour', since: '2026-10-11T19:00:00.000Z' });
    const s = w.poller.getState().metrics?.series;
    expect(s?.points).toHaveLength(360);
    expect(s?.start).toBe('2026-10-11T18:00:10.000Z');
    await w.advance(20_000);
    expect(w.asked).toHaveLength(4);
  });

  it('stops while not active and catches up when it is again', async () => {
    const w = world();
    w.poller.setActive(true);
    await w.answerAll();
    w.poller.setActive(false);
    expect(w.timers).toHaveLength(0);
    await w.advance(60_000);
    expect(w.asked).toHaveLength(1);
    w.poller.setActive(true);
    await w.answerAll();
    expect(w.asked[1]).toEqual({ range: 'hour', since: '2026-10-11T19:00:00.000Z' });
    expect(w.poller.getState().metrics?.series.start).toBe('2026-10-11T18:01:00.000Z');
  });

  it('fetches a new range whole, keeping the old one on screen until it is in, and drops a late answer', async () => {
    const w = world();
    w.poller.setActive(true);
    await w.answerAll();
    await w.advance(9_000);
    w.poller.setRange('day');
    expect(w.poller.getState()).toMatchObject({ range: 'day', loading: true });
    expect(w.poller.getState().metrics?.series.range).toBe('hour');
    expect(w.asked.at(-1)).toEqual({ range: 'day' });
    await w.answerAll();
    expect(w.poller.getState()).toMatchObject({ range: 'day', loading: false });
    expect(w.poller.getState().metrics?.series.range).toBe('day');
    expect(w.timers.filter((t) => t.at <= START + 9_000 + 10_000)).toHaveLength(1);
  });

  it('keeps the frame through two failed polls, then says the measurements can’t be read, and recovers', async () => {
    let failing = false;
    const w = world((input) =>
      failing ? new Error('timeout') : { metrics: metricsAt(START, input), reason: null },
    );
    w.poller.setActive(true);
    await w.answerAll();
    failing = true;
    await w.advance(20_000);
    expect(w.poller.getState().metrics).not.toBeNull();
    await w.advance(10_000);
    expect(w.poller.getState()).toMatchObject({ metrics: null, reason: 'unavailable' });
    failing = false;
    await w.advance(10_000);
    expect(w.asked.at(-1)).toEqual({ range: 'hour' });
    expect(w.poller.getState().reason).toBeNull();
  });

  it('on a self-hosted server asks nothing of the box, and reads spend on open and every 5 minutes', async () => {
    let asked = 0;
    let clock = START;
    const timers: { at: number; fn: () => void }[] = [];
    const poller = createHostPoller({
      loadMetrics: null,
      loadSpend: async () => {
        asked += 1;
        return { daily: null, overview: null };
      },
      now: () => clock,
      setTimer: (fn, ms) => timers.push({ at: clock + ms, fn }),
      clearTimer: () => {},
    });
    expect(poller.getState()).toMatchObject({ reason: 'not_managed', loading: false });
    poller.setActive(true);
    timers.shift()?.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toBe(1);
    expect(poller.getState().spendFailed).toBe(true);
    expect(timers[0]?.at).toBe(START + 300_000);
    clock = START + 300_000;
    timers.shift()?.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toBe(2);
  });
});
