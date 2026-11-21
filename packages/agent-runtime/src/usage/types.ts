/**
 * A subscription's usage windows as the providers report them (docs/decisions/ui-improvements.md UI-R02…): Claude Code's
 * `get_usage` control request and each turn's `rate_limit_event`, and ChatGPT's plan windows as Hermes reads them
 * (hermes-native.md HN-03). The shapes are contracts 0.23.0's (`UsageWindow`, the probe's `ProbeUsage`, CT-153…
 * CT-155); this adds the readers' small helpers. Pure.
 */
import {
  type ProbeUsage,
  USAGE_WINDOW_LABELS,
  USAGE_WINDOWS_MAX,
  type UsageProvider,
  type UsageStatus,
  type UsageWindow,
  type UsageWindowKind,
  UsageWindowKind as UsageWindowKinds,
  usagePct,
  usageStatus,
} from '@whombat/core';

export type { UsageProvider, UsageStatus, UsageWindow, UsageWindowKind };

/** One reading of a subscription (a probe, or what a turn saw): contracts' `ProbeUsage`. */
export type UsageObservation = ProbeUsage;

export const USAGE_WINDOW_KINDS = UsageWindowKinds.options;

type NamedKind = Exclude<UsageWindowKind, 'other'>;

export const WINDOW_MINUTES: Record<NamedKind, number> = {
  five_hour: 300,
  seven_day: 10_080,
  seven_day_opus: 10_080,
  seven_day_sonnet: 10_080,
};

/** Most windows one reading keeps (the contract's bound). */
export const MAX_USAGE_WINDOWS = USAGE_WINDOWS_MAX;

/** A share the provider gave (0–1 `fraction` or 0–100 `percent`) as 0–100; null for anything but a number. */
export function percent(value: unknown, scale: 'fraction' | 'percent' = 'percent'): number | null {
  return typeof value === 'number' ? usagePct(value, scale) : null;
}

/**
 * A window's status from its share, unless the provider said more: `limited` when it refused a turn, `warning` when
 * it warned (Claude's `allowed_warning`) below 80 %.
 */
export function statusOf(usedPct: number | null, said?: UsageStatus | null): UsageStatus {
  const status = usageStatus(usedPct, said === 'limited');
  return status === 'ok' && said === 'warning' ? 'warning' : status;
}

/** Unix seconds or an ISO string → ISO; null for anything else. */
export function isoOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0)
    return new Date(value * 1000).toISOString();
  if (typeof value === 'string' && value) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  return null;
}

/** A window of one of the named kinds. */
export function namedWindow(
  kind: NamedKind,
  usedPct: number | null,
  resetsAt: string | null,
  said?: UsageStatus | null,
): UsageWindow {
  return {
    kind,
    label: USAGE_WINDOW_LABELS[kind],
    usedPct,
    resetsAt,
    status: statusOf(usedPct, said),
    windowMinutes: WINDOW_MINUTES[kind],
  };
}

/** “5-hour”, “7-day”, “90-minute”: a window's length as a label. */
export function minutesLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

/**
 * A newer reading over an older one of the same subscription: windows the newer one names replace the older ones
 * (by kind and label), the others stay (a turn's `rate_limit_event` names one window);
 * the plan stays when the newer one didn't say.
 */
export function mergeObservation(older: UsageObservation | null, newer: UsageObservation): UsageObservation {
  if (!older || older.provider !== newer.provider || newer.kind === 'api_key') return newer;
  const key = (w: UsageWindow) => `${w.kind}:${w.label}`;
  const fresh = new Set(newer.windows.map(key));
  const windows = [...newer.windows, ...older.windows.filter((w) => !fresh.has(key(w)))]
    .sort((a, b) => USAGE_WINDOW_KINDS.indexOf(a.kind) - USAGE_WINDOW_KINDS.indexOf(b.kind))
    .slice(0, MAX_USAGE_WINDOWS);
  return { ...newer, plan: newer.plan ?? older.plan, windows };
}
