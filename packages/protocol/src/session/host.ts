/**
 * How the box is doing (CT-334; Whombat docs/decisions/box-status.md BS-01…BS-12): processor, memory, disk and network,
 * measured by the appliance's manager every `HOST_SAMPLE_INTERVAL_S` seconds and kept 35 days. The manager answers the
 * runtime's `POST /v1/host/metrics` (`@whombat/control-contracts/local`) with `HostMetrics`; the runtime hands the same
 * shape to the person through the session op `host.metrics` (Settings → This Whombat → “How it’s doing”).
 *
 * Bytes are bytes (the app shows them in decimal MB/GB). Network traffic is counted on the uplink (the interfaces of the
 * IPv4 default route). Since 3.0 (CT-1535; Whombat one-person.md OP-04, OP-16) there are no agents' computers: what the
 * agent's containers use is `containersMemoryBytes` and the disk part `containers`; their traffic has no bridge of its
 * own to count and is part of the uplink's.
 */
import { z } from 'zod';
import { Rfc3339 } from './backup.js';

/** How often the manager samples (seconds). */
export const HOST_SAMPLE_INTERVAL_S = 10;

/** The chart ranges, shortest first: “Last hour”, “24 hours”, “7 days”, “30 days”. */
export const HOST_METRICS_RANGES = ['hour', 'day', 'week', 'month'] as const;
export const HostMetricsRange = z.enum(HOST_METRICS_RANGES);
export type HostMetricsRange = z.infer<typeof HostMetricsRange>;

/** Seconds per point of each range. */
export const HOST_METRICS_STEP_S: Readonly<Record<HostMetricsRange, number>> = {
  hour: 10,
  day: 300,
  week: 1_800,
  month: 7_200,
};

/** Points per range (the range's length is points × step). */
export const HOST_METRICS_POINTS: Readonly<Record<HostMetricsRange, number>> = {
  hour: 360,
  day: 288,
  week: 336,
  month: 360,
};

/** Days of traffic totals in `HostMetrics.days`, today included. */
export const HOST_METRICS_DAYS = 30;

const Bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Tenths of a percent, 0–1000 (integers cross languages exactly): 124 is 12.4 %. */
const Permille = z.number().int().min(0).max(1_000);

/** An IANA time zone name (`Europe/Amsterdam`, `UTC`). */
export const TimeZoneName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_+./-]+$/);

/**
 * One point: the averages over its step (`cpuPermille`, `memoryUsedBytes`), the busiest sample in it (`cpuPeakPermille`) and the
 * bytes moved during it. Bits per second = bytes × 8 / step.
 */
export const HostPoint = z.object({
  /** Busy share of all cores. */
  cpuPermille: Permille,
  cpuPeakPermille: Permille,
  /** MemTotal − MemAvailable. */
  memoryUsedBytes: Bytes,
  /** Received on the uplink. */
  inBytes: Bytes,
  /** Sent on the uplink. */
  outBytes: Bytes,
});
export type HostPoint = z.infer<typeof HostPoint>;

/**
 * A range's points, oldest first: point `i` covers `[start + i·stepS, start + (i+1)·stepS)`. Only finished steps; null
 * where nothing was measured (the box was off, the manager restarting). With `since`, only the points starting at or
 * after it (a live view appends them).
 */
export const HostSeries = z.object({
  range: HostMetricsRange,
  start: Rfc3339,
  stepS: z.number().int().min(1).max(86_400),
  points: z.array(HostPoint.nullable()).max(400),
});
export type HostSeries = z.infer<typeof HostSeries>;

/**
 * What the data disk holds, largest first in the app. Absent parts weren't measurable (quota rescans). `containers`
 * (3.0, CT-1535): the container engine's storage (the agent's images, containers and their volumes, OP-16).
 */
export const HOST_DISK_PARTS = ['containers', 'whombat', 'work', 'database'] as const;
export const HostDiskPartKey = z.enum(HOST_DISK_PARTS);
export type HostDiskPartKey = z.infer<typeof HostDiskPartKey>;

export const HostDiskPart = z.object({ key: HostDiskPartKey, bytes: Bytes });
export type HostDiskPart = z.infer<typeof HostDiskPart>;

/** One filesystem as `statfs` sees it (`usedBytes` + `freeBytes` ≤ `totalBytes`: reserved blocks are neither). */
export const HostDisk = z.object({
  totalBytes: Bytes,
  usedBytes: Bytes,
  /** Free for use (`f_bavail`). */
  freeBytes: Bytes,
});
export type HostDisk = z.infer<typeof HostDisk>;

export const HostDisks = z.object({
  /**
   * `/persist`: everything the Whombat keeps. `parts` never sum to more than `usedBytes` (the manager scales overlapping
   * quota counts down); the rest is the app's “Other”. Null while the quota numbers are being recounted.
   */
  data: HostDisk.extend({ parts: z.array(HostDiskPart).max(HOST_DISK_PARTS.length).nullable() }),
  /** `/`: the system (the Whombat's software). */
  system: HostDisk,
  /** The backup disk when one is set up and mounted; else null. */
  backup: HostDisk.nullable(),
});
export type HostDisks = z.infer<typeof HostDisks>;

/** Where the box's power comes from (0.100, CT-522): the mains, or its own battery. */
export const HOST_POWER_SOURCES = ['ac', 'battery'] as const;
export const HostPowerSource = z.enum(HOST_POWER_SOURCES);
export type HostPowerSource = z.infer<typeof HostPowerSource>;

/**
 * The battery of a machine that has one (0.100, CT-522; Whombat desk-display.md DK-10), read by the manager from
 * `/sys/class/power_supply`: on the mains (`ac`) or the battery, its charge, whether it is charging, about how many
 * minutes it lasts on battery (null when plugged in or not known), the charge limit the machine holds it at (null:
 * none) and since when it runs on battery (null on the mains; kept across samples).
 */
export const HostPower = z.object({
  source: HostPowerSource,
  percent: z.number().int().min(0).max(100),
  charging: z.boolean(),
  minutesLeft: z.number().int().min(0).max(100_000).nullable(),
  chargeLimit: z.number().int().min(0).max(100).nullable(),
  since: Rfc3339.nullable(),
});
export type HostPower = z.infer<typeof HostPower>;

/** Right now: the latest sample. */
export const HostNow = z.object({
  at: Rfc3339,
  cpuPermille: Permille,
  cores: z.number().int().min(1).max(4_096),
  memoryTotalBytes: Bytes,
  memoryUsedBytes: Bytes,
  /**
   * What the agent's containers use of `memoryUsedBytes` (the container engine's cgroup, OP-16; 3.0, CT-1535); null
   * when none run or it can't be read.
   */
  containersMemoryBytes: Bytes.nullable(),
  /** The uplink's interface names, for diagnostics (`enp5s0`). */
  uplink: z
    .array(
      z
        .string()
        .min(1)
        .max(15)
        .regex(/^[A-Za-z0-9_.:@-]+$/),
    )
    .max(8),
  /** The battery (0.100, CT-522); absent on machines without one. */
  power: HostPower.optional(),
  /**
   * The processor's temperature, whole °C (0.101, CT-542; Whombat desk-display.md DK-24): hwmon `k10temp`, `coretemp`
   * or `zenpower`, else a CPU thermal zone. Absent without a sensor (VMs).
   */
  cpuTempC: z.number().int().min(-50).max(150).optional(),
  /** Seconds since the machine started (`/proc/uptime`; 0.101, CT-542); absent when it couldn't be read. */
  uptimeS: z
    .number()
    .int()
    .min(0)
    .max(10 ** 10)
    .optional(),
});
export type HostNow = z.infer<typeof HostNow>;

/** Traffic in one calendar day of `HostMetrics.timeZone` (partial while measuring didn't cover it all). */
export const HostDay = z.object({
  /** `YYYY-MM-DD`. */
  date: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
  inBytes: Bytes,
  outBytes: Bytes,
});
export type HostDay = z.infer<typeof HostDay>;

export const HostMetrics = z.object({
  now: HostNow,
  disks: HostDisks,
  series: HostSeries,
  /** The last `HOST_METRICS_DAYS` days, oldest first, today last; every day present (zeros before measuring began). */
  days: z.array(HostDay).max(HOST_METRICS_DAYS),
  /** The IANA zone the days are counted in (the burrow's; `UTC` when the manager doesn't know the asked one). */
  timeZone: TimeZoneName,
  /** The oldest stored measurement; the charts are empty before it. */
  measuringSince: Rfc3339,
});
export type HostMetrics = z.infer<typeof HostMetrics>;

/* The session op `host.metrics` -------------------------------------------------------------------------- */

export const HostMetricsInput = z.object({
  range: HostMetricsRange,
  /** Only the points starting at or after this time (a live view's next poll); absent: the whole range. */
  since: Rfc3339.optional(),
});
export type HostMetricsInput = z.infer<typeof HostMetricsInput>;

/**
 * `metrics` null with a `reason`: `not_managed` — a self-hosted server, there is no manager to measure the box (the app
 * shows only Tokens); `unavailable` — the manager didn't answer or is too old (the app says it can't read them now).
 */
export const HostMetricsOutput = z.object({
  metrics: HostMetrics.nullable(),
  reason: z.enum(['not_managed', 'unavailable']).nullable(),
});
export type HostMetricsOutput = z.infer<typeof HostMetricsOutput>;
