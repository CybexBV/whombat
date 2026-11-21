/**
 * How the box is doing in fixture mode (Whombat box-status.md BS-01…BS-12; app docs/decisions/box-status.md AP-1147).
 * `spend.daily` is served always, from the shared world's 30 days of turns, so it matches `spend.overview`. With the
 * box (`VITE_FIXTURE_HOST=1`, option `host`) there is also a manager to ask: `host.metrics` answers like the approved
 * mock — a 4-core box with 16 GB, busy around 09:10, 11:45, 14:25 (most, near 90 %), 16:05 and 19:30 each day, the
 * download following it; 40 of 87 GB used, mostly the agent's containers; 2.2 GB in and 41 MB out today — and spend is
 * the mock's fortnight (3.4M tokens today in four turns, 94 % read from cache). The points are a pure
 * function of their time, so a live poll's new points always fit the ones before; the range ends at the real clock
 * (frozen at the seed's moment in the visual suite).
 */

import type { HostPower } from '@whombat/client/desk';
import type { SpendDaily, SpendDay, SpendOverview } from '@whombat/core/domain';
import { dayKey } from '@whombat/core/text';
import { type FixtureTurn, SEED_NOW, SEED_TIME_ZONE, SPEND_TURNS, spendOverview } from '@whombat/fixtures';
import type { HostMetrics, HostMetricsInput, HostMetricsOutput, HostPoint } from '@whombat/protocol/session';
import { HOST_METRICS_POINTS, HOST_METRICS_STEP_S } from '@whombat/protocol/session';

const GB = 1_000_000_000;
const DAY = 86_400_000;
const TZ = SEED_TIME_ZONE;
/** The burrow's clock is Amsterdam's: summer time (UTC+2) in the fixture world's weeks. */
const OFFSET_MIN = 120;

/** A number in [0, 1) that depends only on `n` (and `salt`). */
function noise(n: number, salt: number): number {
  let x = Math.imul(Math.floor(n) ^ (salt * 0x9e3779b1), 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4_294_967_296;
}

/** The day's busy spells (local minutes, width in minutes, height in percent), as the mock draws them. */
const SPELLS: readonly [number, number, number][] = [
  [9 * 60 + 10, 30, 38],
  [11 * 60 + 45, 15, 22],
  [14 * 60 + 25, 35, 72],
  [16 * 60 + 5, 20, 30],
  [19 * 60 + 30, 15, 18],
];

const bump = (x: number, centre: number, width: number, height: number) =>
  height * Math.exp(-((x - centre) ** 2) / (2 * width * width));

/** Local minutes since the day's start. */
function local(ms: number): { minute: number } {
  const m = ms / 60_000 + OFFSET_MIN;
  return { minute: ((m % 1440) + 1440) % 1440 };
}

/** Processor in percent over a step starting at `ms`: the mock's formula, each step a little different (`n`: its number). */
function cpuAt(ms: number, n: number): number {
  const { minute } = local(ms);
  const spells = SPELLS.reduce(
    (sum, [c, w, h], i) => sum + bump(minute, c, w, h * (0.8 + 0.4 * noise(n * 5 + i, 3))),
    0,
  );
  return Math.min(100, 2 + 2.5 * noise(n, 1) + spells);
}

/** Download and upload in Mbit/s over a step: the download a little before each busy spell, uploads small. */
function speedAt(ms: number, n: number): { down: number; up: number } {
  const { minute } = local(ms);
  const down = SPELLS.reduce(
    (sum, [c, w, h], i) => sum + bump(minute, c - 15, w / 2, h * 0.6 * (0.5 + noise(n * 7 + i, 5))),
    0.05 + 0.3 * noise(n, 2),
  );
  const up = SPELLS.reduce(
    (sum, [c, w, h], i) => sum + bump(minute, c + 10, w / 2, h * 0.05 * (0.5 + noise(n * 11 + i, 7))),
    0.02 + 0.1 * noise(n, 4),
  );
  return { down, up };
}

/** One step: the processor's average and its busiest sample, memory, and the bytes moved (BS-04). */
function pointAt(start: number, stepS: number): HostPoint {
  const n = Math.floor(start / (stepS * 1000));
  const mid = start + (stepS * 1000) / 2;
  const cpu = cpuAt(mid, n);
  const { down, up } = speedAt(mid, n);
  const inBytes = Math.round((down * 1_000_000 * stepS) / 8);
  return {
    cpuPermille: Math.round(cpu * 10),
    cpuPeakPermille: Math.min(1000, Math.round(cpu * (1 + 0.08 * noise(n, 6)) * 10)),
    memoryUsedBytes: Math.round(1.7 * GB + cpu * 0.02 * GB),
    inBytes,
    outBytes: Math.round((up * 1_000_000 * stepS) / 8),
  };
}

/** The mock's 14 days of traffic in GB, received and sent, today last; the 16 days before vary around them. */
const RECEIVED = [1.4, 0.8, 3.1, 4.6, 2.2, 0.7, 0.6, 1.9, 2.8, 4.1, 3.3, 1.2, 0.9, 2.2];
const SENT = [0.09, 0.05, 0.21, 0.38, 0.12, 0.04, 0.03, 0.11, 0.17, 0.29, 0.2, 0.07, 0.05, 0.041];

function days(now: number): HostMetrics['days'] {
  return Array.from({ length: 30 }, (_, i) => {
    const back = 29 - i;
    const date = dayKey(new Date(now - back * DAY), TZ);
    const k = i - 16;
    const received = k >= 0 ? (RECEIVED[k] ?? 0) : 0.6 + 3 * noise(i, 9);
    const sent = k >= 0 ? (SENT[k] ?? 0) : received * 0.06;
    return {
      date,
      inBytes: Math.round(received * GB),
      outBytes: Math.round(sent * GB),
    };
  });
}

/**
 * A desk machine's battery (desk-display-web.md AP-3021): plugged in and held at 80 %, or on battery for 27 minutes
 * with 64 % and about 3 h 10 min left, as the desk mockup's night.
 */
export function hostPowerFixture(kind: 'ac' | 'battery', now: number): HostPower {
  return kind === 'battery'
    ? {
        source: 'battery',
        percent: 64,
        charging: false,
        minutesLeft: 190,
        chargeLimit: 80,
        since: new Date(now - 27 * 60_000).toISOString(),
      }
    : { source: 'ac', percent: 80, charging: false, minutesLeft: null, chargeLimit: 80, since: null };
}

/**
 * `host.metrics` as the fixture box's manager answers it at `now` (only finished steps; `since`: from then on), with
 * the battery when the box has one (`power`).
 */
export function hostMetricsFixture(
  input: HostMetricsInput,
  now: number,
  power: HostPower | null = null,
): HostMetricsOutput {
  const stepS = HOST_METRICS_STEP_S[input.range];
  const step = stepS * 1000;
  const end = Math.floor(now / step) * step;
  const rangeStart = end - HOST_METRICS_POINTS[input.range] * step;
  const since = input.since ? Math.ceil(Date.parse(input.since) / step) * step : rangeStart;
  const start = Math.max(rangeStart, Math.min(since, end));
  const points = Array.from({ length: (end - start) / step }, (_, i) => pointAt(start + i * step, stepS));
  const latest = Math.floor(now / 10_000) * 10_000;
  return {
    reason: null,
    metrics: {
      now: {
        at: new Date(latest).toISOString(),
        cpuPermille: 40,
        cores: 4,
        memoryTotalBytes: 16 * GB,
        memoryUsedBytes: Math.round(1.8 * GB),
        containersMemoryBytes: Math.round(0.6 * GB),
        uplink: ['enp5s0'],
        ...(power ? { power } : {}),
      },
      disks: {
        data: {
          totalBytes: 87 * GB,
          usedBytes: 40 * GB,
          freeBytes: 46 * GB,
          parts: [
            { key: 'containers', bytes: Math.round(22.9 * GB) },
            { key: 'whombat', bytes: Math.round(9.6 * GB) },
            { key: 'work', bytes: Math.round(7.5 * GB) },
          ],
        },
        system: { totalBytes: 20 * GB, usedBytes: Math.round(6.1 * GB), freeBytes: Math.round(13.4 * GB) },
        backup: null,
      },
      series: { range: input.range, start: new Date(start).toISOString(), stepS, points },
      days: days(now),
      timeZone: TZ,
      measuringSince: new Date(now - 35 * DAY).toISOString(),
    },
  };
}

/* Spend ------------------------------------------------------------------------------------------------------------ */

/** `spend.daily` from turns: 30 calendar days of the burrow's zone up to the seed's today, every day present (BS-07). */
export function spendDailyFrom(turns: readonly FixtureTurn[]): SpendDaily {
  const dates = Array.from({ length: 30 }, (_, i) =>
    dayKey(new Date(SEED_NOW.getTime() - (29 - i) * DAY), TZ),
  );
  const byDate = new Map<string, SpendDay>(
    dates.map((date) => [
      date,
      { date, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]),
  );
  for (const t of turns) {
    const day = byDate.get(dayKey(t.finishedAt, TZ));
    if (!day) continue;
    day.turns += 1;
    if (!t.usage) continue;
    day.inputTokens += t.usage.inputTokens;
    day.outputTokens += t.usage.outputTokens;
    day.cacheReadTokens += t.usage.cacheReadTokens ?? 0;
    day.cacheWriteTokens += t.usage.cacheWriteTokens ?? 0;
  }
  return { generatedAt: SEED_NOW.toISOString(), timeZone: TZ, days: [...byDate.values()] };
}

/** The mock's fortnight of tokens (millions, as billed), today last, and today's turns. */
const TOKENS = [2.1, 1.4, 4.2, 5.8, 3.0, 0.4, 0.3, 2.6, 3.9, 6.1, 4.4, 1.1, 0.6, 3.4];
const TODAY = [2.1, 0.6, 0.4, 0.3];

/** A turn whose billed tokens (`spendTokens`) are about `millions`, 94 % of its input read from the cache. */
function turnOf(millions: number, finishedAt: number): FixtureTurn {
  const billed = millions * 1_000_000;
  const outputTokens = Math.round(billed * 0.03);
  // Billed = 6 % uncached input + 94 % cache reads at a tenth + output.
  const inputTokens = Math.round((billed - outputTokens) / 0.154);
  return {
    forId: null,
    finishedAt: new Date(finishedAt).toISOString(),
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens: Math.round(inputTokens * 0.94),
      cacheWriteTokens: 0,
    },
    planId: null,
  };
}

/** The box's spend world: the mock's columns, today's four turns (an hour before the seed's moment). */
export const HOST_SPEND_TURNS: readonly FixtureTurn[] = TOKENS.flatMap((m, i) => {
  const at = SEED_NOW.getTime() - (13 - i) * DAY - 3_600_000;
  if (i === TOKENS.length - 1) return TODAY.map((t, k) => turnOf(t, at - k * 600_000));
  return [turnOf(m * 0.6, at), turnOf(m * 0.4, at - 600_000)];
});

/** What the fixture world serves for `spend.daily` and, with the box, `spend.overview`. */
export function createHostFixtures({ box }: { box: boolean }): {
  daily: () => SpendDaily;
  overview: (() => SpendOverview) | null;
} {
  return {
    daily: () => spendDailyFrom(box ? HOST_SPEND_TURNS : SPEND_TURNS),
    overview: box ? () => spendOverview(HOST_SPEND_TURNS) : null,
  };
}
