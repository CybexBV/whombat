/**
 * Levels and tones of servers' numbers (ported from Rackoon's `web/src/lib/thresholds.ts`): the single source for every
 * dot, bar and coloured figure on the server pages, Home's Servers card and Android. A level is data; `hostTone` turns
 * it into a token tone (`ok`, `warn`, `bad`) the screens colour with.
 */
import type { HostServerStatus } from '@whombat/core/domain';

export type HostLevel = 'good' | 'warning' | 'serious';
export type HostTone = 'ok' | 'warn' | 'bad' | 'mut';

/** The limit when a sensor has none (the hosts service's default). */
export const DEFAULT_TEMP_LIMIT_C = 85;
/** “Warm” starts at 85 % of a sensor's limit (Rackoon's rule; the server page's dashed line). */
export const WARM_SHARE = 0.85;

/** A sensor: good below 85 % of its limit, warning from there, serious at the limit. */
export function sensorLevel(
  tempC: number | null | undefined,
  limitC: number | null | undefined,
): HostLevel | null {
  if (tempC == null || !Number.isFinite(tempC)) return null;
  const limit = limitC ?? DEFAULT_TEMP_LIMIT_C;
  if (tempC >= limit) return 'serious';
  if (tempC * 100 >= limit * WARM_SHARE * 100) return 'warning';
  return 'good';
}

/** Where “warm” starts for a limit (85 % of it, rounded down: 85 → 72). */
export function warmFrom(limitC: number | null | undefined): number {
  return Math.floor((limitC ?? DEFAULT_TEMP_LIMIT_C) * WARM_SHARE);
}

/** Disk, filesystem or storage use: below 80 good, 80–89 warning, 90 and up serious. */
export function diskUsedLevel(pct: number | null | undefined): HostLevel | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct >= 90) return 'serious';
  if (pct >= 80) return 'warning';
  return 'good';
}

/** SSD wear: below 75 good, 75–89 warning, 90 and up serious. */
export function wearLevel(pct: number | null | undefined): HostLevel | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct >= 90) return 'serious';
  if (pct >= 75) return 'warning';
  return 'good';
}

/** Memory given to guests against the host's: below 80 good, 80–89 warning, 90 and up serious. */
export function memoryAssignedLevel(pct: number | null | undefined): HostLevel | null {
  return diskUsedLevel(pct);
}

/** vCPU overcommit: good up to 1.5 : 1, warning above (the hosts service's `hypervisor.overcommit` rule). */
export function overcommitLevel(ratio: number | null | undefined): HostLevel | null {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  return ratio > 1.5 ? 'warning' : 'good';
}

/** A level as a tone (no data: muted). */
export function hostTone(level: HostLevel | null): HostTone {
  return level === 'serious' ? 'bad' : level === 'warning' ? 'warn' : level === 'good' ? 'ok' : 'mut';
}

/** A server's status as a tone (pending and offline are muted and bad). */
export function serverTone(status: HostServerStatus): HostTone {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'warn':
      return 'warn';
    case 'bad':
    case 'offline':
      return 'bad';
    default:
      return 'mut';
  }
}
