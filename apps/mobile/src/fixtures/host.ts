/**
 * How the box is doing, as the approved mockup draws it (Whombat box-status.md BS-10; app box-status-android.md
 * AP-1155): 21:40 on Sunday 11 October 2026 in Amsterdam, four cores mostly idle with five runs during the day (the
 * busiest 86 % at 14:25), 2.2 GB received today, a disk 40 of 87 GB full and 14 days of traffic with the mock's
 * numbers. For the tests and screenshots; pure and deterministic.
 */
import {
  HOST_METRICS_POINTS,
  HOST_METRICS_STEP_S,
  type HostMetrics,
  type HostMetricsRange,
  type HostPoint,
} from '@whombat/protocol/session';

const GB = 1_000_000_000;
/** 21:40 in Amsterdam (summer time, UTC+2). */
export const HOST_FIXTURE_END = Date.parse('2026-10-11T19:40:00.000Z');
export const HOST_FIXTURE_ZONE = 'Europe/Amsterdam';
const ZONE_OFFSET_MIN = 120;

/** The mock's runs: the minute of the day (Amsterdam), how wide in minutes, how busy at the top (percent). */
const RUNS: readonly [number, number, number][] = [
  [9 * 60 + 10, 30, 38],
  [11 * 60 + 45, 15, 22],
  [14 * 60 + 25, 35, 82],
  [16 * 60 + 5, 20, 30],
  [19 * 60 + 30, 15, 18],
];

/** A deterministic 0–1 wobble for a moment (the mock's seeded noise, without state). */
function wobble(ms: number, salt: number): number {
  const s = Math.sin((ms / 60_000) * 12.9898 + salt * 78.233) * 43_758.5453;
  return s - Math.floor(s);
}

/** The runs' load at a moment, in percent before noise. */
function load(ms: number, shift = 0): number {
  const minute = (((ms / 60_000 + ZONE_OFFSET_MIN) % 1440) + 1440) % 1440;
  return RUNS.reduce((sum, [c, w, h]) => sum + h * Math.exp(-((minute - c - shift) ** 2) / (2 * w * w)), 0);
}

function point(ms: number, stepS: number, fixed?: number): HostPoint {
  const cpu = fixed ?? Math.min(100, 2 + wobble(ms, 1) * 2.5 + load(ms) * (0.9 + wobble(ms, 2) * 0.1));
  const peak = Math.min(100, cpu + wobble(ms, 3) * 2);
  const downMbit = 0.05 + wobble(ms, 4) * 0.3 + load(ms, -15) * 0.6 * (0.5 + wobble(ms, 5));
  const upMbit = 0.02 + wobble(ms, 6) * 0.1 + load(ms, 10) * 0.05 * (0.5 + wobble(ms, 7));
  const bytes = (mbit: number) => Math.round((mbit * 1_000_000 * stepS) / 8);
  return {
    cpuPermille: Math.round(cpu * 10),
    cpuPeakPermille: Math.round(peak * 10),
    memoryUsedBytes: Math.round(1.8 * GB),
    inBytes: bytes(downMbit),
    outBytes: bytes(upMbit),
  };
}

/** The mock's last 14 days in GB, today last; the 16 days before them are quieter. */
const RECEIVED = [1.4, 0.8, 3.1, 4.6, 2.2, 0.7, 0.6, 1.9, 2.8, 4.1, 3.3, 1.2, 0.9, 2.2];
const SENT = [0.09, 0.05, 0.21, 0.38, 0.12, 0.04, 0.03, 0.11, 0.17, 0.29, 0.2, 0.07, 0.05, 0.041];

/** `YYYY-MM-DD` of the day `back` days before the fixture's today. */
const dayOf = (back: number) => new Date(Date.UTC(2026, 9, 11 - back)).toISOString().slice(0, 10);

/** `host.metrics` for a range, ending at the fixture's now (or `end`, a later poll). */
export function hostMetricsFixture(range: HostMetricsRange, end = HOST_FIXTURE_END): HostMetrics {
  const stepS = HOST_METRICS_STEP_S[range];
  const count = HOST_METRICS_POINTS[range];
  const start = end - count * stepS * 1000;
  const points = Array.from({ length: count }, (_, i) =>
    point(start + (i + 0.5) * stepS * 1000, stepS, i === count - 1 ? 4 : undefined),
  );
  return {
    now: {
      at: new Date(end).toISOString(),
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
        usedBytes: 40 * GB,
        freeBytes: 46 * GB,
        parts: [
          { key: 'containers', bytes: 22.9 * GB },
          { key: 'whombat', bytes: 9.6 * GB },
          { key: 'work', bytes: 7.5 * GB },
          { key: 'database', bytes: 0 },
        ],
      },
      system: { totalBytes: 20 * GB, usedBytes: 6.1 * GB, freeBytes: 13 * GB },
      backup: null,
    },
    series: { range, stepS, start: new Date(start).toISOString(), points },
    days: Array.from({ length: 30 }, (_, i) => {
      const back = 29 - i;
      const k = 13 - back;
      const received = k >= 0 ? (RECEIVED[k] ?? 0) : 0.5 + wobble(back * 86_400_000, 8) * 2;
      const sent = k >= 0 ? (SENT[k] ?? 0) : received * 0.06;
      return {
        date: dayOf(back),
        inBytes: Math.round(received * GB),
        outBytes: Math.round(sent * GB),
      };
    }),
    timeZone: HOST_FIXTURE_ZONE,
    measuringSince: '2026-09-01T00:00:00.000Z',
  };
}
