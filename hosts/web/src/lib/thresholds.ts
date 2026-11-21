// Thresholds and status rules, PRODUCT-SPEC.md section 5. The single source
// for every status dot, bar color and label in the UI. Unit tested in
// thresholds.test.ts with the vectors from ACCEPTANCE.md section 7.

import { t } from './i18n';

/** Data levels. `serious` is a data color, never a third alert severity. */
export type Level = 'good' | 'warning' | 'serious';

/** Default limit when the API does not send `temp_limit_c` (CONTRACT). */
export const DEFAULT_TEMP_LIMIT_C = 85;

/**
 * Sensor temperature: good below 85% of the sensor's own limit, warning at or
 * above 85% of it, serious at or above the limit. Same rule on the fleet
 * card's Temp dot with the hottest sensor's limit.
 */
export function sensorLevel(tempC: number | null | undefined, limitC: number | null | undefined): Level | null {
  if (tempC == null || !Number.isFinite(tempC)) return null;
  const limit = limitC ?? DEFAULT_TEMP_LIMIT_C;
  if (tempC >= limit) return 'serious';
  // Compare scaled values so 72.25 vs 0.85 * 85 is exact.
  if (tempC * 100 >= limit * 85) return 'warning';
  return 'good';
}

/** Disk / filesystem / Proxmox storage used %: <80 good, 80-89 warning, >=90 serious. */
export function diskUsedLevel(pct: number | null | undefined): Level | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct >= 90) return 'serious';
  if (pct >= 80) return 'warning';
  return 'good';
}

/** SSD wear %: <75 good, 75-89 warning, >=90 serious. */
export function wearLevel(pct: number | null | undefined): Level | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct >= 90) return 'serious';
  if (pct >= 75) return 'warning';
  return 'good';
}

/** "Wear high" at 75% and above. */
export function wearLabel(pct: number | null | undefined): 'Healthy' | 'Wear high' {
  return pct != null && pct >= 75 ? 'Wear high' : 'Healthy';
}

/** Alert rule that a wear value fires (M8 default rules). */
export function wearAlertRule(pct: number | null | undefined): 'disk.wear_critical' | 'disk.wear_high' | null {
  if (pct == null) return null;
  if (pct >= 90) return 'disk.wear_critical';
  if (pct >= 75) return 'disk.wear_high';
  return null;
}

/** Wear is capped at 100 for display. */
export function displayWear(pct: number): number {
  return Math.min(100, Math.max(0, pct));
}

/** Memory assigned to guests / host RAM %: <80 good, 80-89 warning, >=90 serious. */
export function memoryAssignedLevel(pct: number | null | undefined): Level | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct >= 90) return 'serious';
  if (pct >= 80) return 'warning';
  return 'good';
}

/** vCPU overcommit (allocated / host threads): good up to 1.5 : 1, warning above. */
export function overcommitLevel(ratio: number | null | undefined): Level | null {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  // Same comparison as the hub's `hypervisor.overcommit` rule (strictly above 1.5).
  return ratio > 1.5 ? 'warning' : 'good';
}

/** The vCPU meter spans 0 to 2 : 1; returns the fill width in percent. */
export function vcpuMeterWidth(ratio: number): number {
  return Math.min(ratio / 2, 1) * 100;
}

/** Position of the 1 : 1 tick on the vCPU meter, in percent. */
export const VCPU_TICK_PCT = 50;

/** Heatmap bin upper bounds (exclusive); the last bin includes 100. */
export const HEAT_BOUNDS = [8, 20, 35, 50, 65, 80] as const;

/** CPU % -> heatmap bin 0..6; null (no data) -> null (blank cell). */
export function heatBin(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const i = HEAT_BOUNDS.findIndex((b) => v < b);
  return i === -1 ? 6 : i;
}

/** Heartbeat age at which a server counts as offline ("Agent unreachable"). */
export const OFFLINE_AFTER_S = 60;

/** Server status from heartbeat age and open warning alerts. */
export function serverStatus(heartbeatAgeS: number, hasOpenWarning: boolean): 'online' | 'warning' | 'offline' {
  if (heartbeatAgeS >= OFFLINE_AFTER_S) return 'offline';
  return hasOpenWarning ? 'warning' : 'online';
}

// ------------------------------------------------------------- colors

/** Status-dot color for a level (null = no data -> muted). */
export function levelDot(level: Level | null): string {
  switch (level) {
    case 'good':
      return 'var(--good)';
    case 'warning':
      return 'var(--warning)';
    case 'serious':
      return 'var(--serious)';
    default:
      return 'var(--muted)';
  }
}

/** Bar fill color: blue (the default single-series accent) when good. */
export function levelBar(level: Level | null, goodColor = 'var(--series-cpu)'): string {
  if (level === 'warning') return 'var(--warning)';
  if (level === 'serious') return 'var(--serious)';
  return goodColor;
}

export const STATUS_DOT: Record<'online' | 'warning' | 'offline', string> = {
  online: 'var(--good)',
  warning: 'var(--warning)',
  offline: 'var(--critical)',
};

export const STATUS_LABEL: Record<'online' | 'warning' | 'offline', string> = {
  online: t('Online'),
  warning: t('Warning'),
  offline: t('Offline'),
};
