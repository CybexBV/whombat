/**
 * Subscription usage (CT-153…CT-156; Whombat docs/decisions/ui-improvements.md): how much of a person's Claude or
 * Codex subscription's 5-hour and 7-day limits is used, read through the unmodified CLIs in their own flow (Claude
 * Code's `get_usage` control request and each turn's `rate_limit_event`; Codex's `account/rateLimits/read` and
 * `account/rateLimits/updated`), never from their credential files (SUB-03). The runtime keeps the latest snapshot per
 * subscription (per provider), not a history. API-key sign-ins have no windows (pay as you go).
 */
import { z } from 'zod';
import { Timestamp } from './common.js';

/** The providers whose usage Whombat reads (the sign-in providers that run turns). */
export const UsageProvider = z.enum(['claude', 'codex']);
export type UsageProvider = z.infer<typeof UsageProvider>;

/**
 * A usage window. Claude reports `five_hour`, `seven_day`, `seven_day_opus` and `seven_day_sonnet`; Codex reports a
 * primary and a secondary window by length (`windowMinutes` 300 → `five_hour`, 10 080 → `seven_day`, else `other`).
 * Clients drop a window kind they don't know (tolerant decoding).
 */
export const UsageWindowKind = z.enum([
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'other',
]);
export type UsageWindowKind = z.infer<typeof UsageWindowKind>;

/** `ok` below 80 %, `warning` from 80 %, `limited` when the provider refuses turns until `resetsAt`. */
export const UsageStatus = z.enum(['ok', 'warning', 'limited']);
export type UsageStatus = z.infer<typeof UsageStatus>;

/** Most windows in one snapshot. */
export const USAGE_WINDOWS_MAX = 8;

export const UsageWindow = z.object({
  kind: UsageWindowKind,
  /** As people see it: `5-hour`, `7-day`, `7-day Opus` ({@link USAGE_WINDOW_LABELS}), or the provider's words. */
  label: z.string().min(1).max(80),
  /** Share of the window's limit used, 0–100; null when the provider said only whether it is limited. */
  usedPct: z.number().min(0).max(100).nullable(),
  /** When the window resets; null when unknown. */
  resetsAt: Timestamp.nullable(),
  status: UsageStatus,
  /** The window's length in minutes when the provider says (Codex `windowDurationMins`); absent or null otherwise. */
  windowMinutes: z.number().int().positive().max(527_040).nullable().optional(),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

/** A subscription sign-in has windows; an API key is pay as you go (no windows, “see Spend”). */
export const UsageCredentialKind = z.enum(['subscription', 'api_key']);
export type UsageCredentialKind = z.infer<typeof UsageCredentialKind>;

/** Where the snapshot came from: a probe (scheduled or asked for) or a turn's own rate-limit report. */
export const UsageSource = z.enum(['probe', 'turn']);
export type UsageSource = z.infer<typeof UsageSource>;

/** Longest `error` a snapshot carries. */
export const USAGE_ERROR_MAX = 300;
/** Longest plan name (`max`, `pro`, `plus`, `team`, `enterprise`, as the CLI says it). */
export const USAGE_PLAN_MAX = 64;

/**
 * The latest usage of the person's sign-in for one provider (since 3.0 without whose: there is one person, CT-1513).
 * `observedAt` and `source` are null until the first probe or turn; `error` says why the last probe
 * couldn't read usage (the windows then are the last good ones, if any).
 */
export const SubscriptionUsage = z.object({
  provider: UsageProvider,
  kind: UsageCredentialKind,
  /** Signed in to the provider (false: the snapshot is what was last seen, or empty). */
  connected: z.boolean(),
  plan: z.string().max(USAGE_PLAN_MAX).nullable(),
  windows: z.array(UsageWindow).max(USAGE_WINDOWS_MAX),
  observedAt: Timestamp.nullable(),
  source: UsageSource.nullable(),
  error: z.string().max(USAGE_ERROR_MAX).nullable(),
});
export type SubscriptionUsage = z.infer<typeof SubscriptionUsage>;

/* Thresholds and levels ------------------------------------------------------------------------------------------ */

/** A window is a warning from this share used. */
export const USAGE_WARNING_PCT = 80;
/** A window is critical from this share used. */
export const USAGE_CRITICAL_PCT = 95;
/** The shares the assistant tells people about, lowest first. */
export const USAGE_THRESHOLDS = [USAGE_WARNING_PCT, USAGE_CRITICAL_PCT] as const;
export type UsageThreshold = (typeof USAGE_THRESHOLDS)[number];

/** How full a window is, for a meter's color: below 80 %, from 80 %, from 95 %; null when unknown. */
export type UsageLevel = 'ok' | 'warning' | 'critical';

export function usageLevel(pct: number | null | undefined): UsageLevel | null {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return null;
  if (pct >= USAGE_CRITICAL_PCT) return 'critical';
  if (pct >= USAGE_WARNING_PCT) return 'warning';
  return 'ok';
}

/** A window's status from its share used and whether the provider refuses turns (`limited` wins). */
export function usageStatus(pct: number | null | undefined, limited = false): UsageStatus {
  if (limited || (typeof pct === 'number' && pct >= 100)) return 'limited';
  return usageLevel(pct) === null || usageLevel(pct) === 'ok' ? 'ok' : 'warning';
}

/** A window's level for a meter: `critical` when limited, else {@link usageLevel} of its share. */
export function windowLevel(w: Pick<UsageWindow, 'usedPct' | 'status'>): UsageLevel | null {
  if (w.status === 'limited') return 'critical';
  return usageLevel(w.usedPct);
}

/** A share clamped to 0–100 (a provider's 0–1 fraction times 100, or its percentage), or null when not a number. */
export function usagePct(
  value: number | null | undefined,
  scale: 'fraction' | 'percent' = 'percent',
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const pct = scale === 'fraction' ? value * 100 : value;
  return Math.min(100, Math.max(0, Math.round(pct * 10) / 10));
}

/** People's words for each window kind. */
export const USAGE_WINDOW_LABELS: Record<UsageWindowKind, string> = {
  five_hour: '5-hour',
  seven_day: '7-day',
  seven_day_opus: '7-day Opus',
  seven_day_sonnet: '7-day Sonnet',
  other: 'Usage',
};

/** The window kind of a window `minutes` long (Codex reports windows by length). */
export function usageWindowKindForMinutes(minutes: number | null | undefined): UsageWindowKind {
  if (minutes === 300) return 'five_hour';
  if (minutes === 10_080) return 'seven_day';
  return 'other';
}

/** Windows in the order people read them: 5-hour, 7-day, 7-day Opus, 7-day Sonnet, others. */
export function sortUsageWindows<W extends Pick<UsageWindow, 'kind'>>(windows: readonly W[]): W[] {
  const order = UsageWindowKind.options;
  return [...windows].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

/** The window a compact meter shows: the 5-hour one, else the fullest. */
export function primaryUsageWindow<W extends Pick<UsageWindow, 'kind' | 'usedPct'>>(
  windows: readonly W[],
): W | null {
  return (
    windows.find((w) => w.kind === 'five_hour') ??
    [...windows].sort((a, b) => (b.usedPct ?? -1) - (a.usedPct ?? -1))[0] ??
    null
  );
}

/* Probing -------------------------------------------------------------------------------------------------------- */

/** A subscription used within this long is probed every {@link USAGE_PROBE_ACTIVE_MS}, otherwise hourly. */
export const USAGE_ACTIVE_WITHIN_MS = 24 * 60 * 60 * 1000;
export const USAGE_PROBE_ACTIVE_MS = 15 * 60 * 1000;
export const USAGE_PROBE_IDLE_MS = 60 * 60 * 1000;
/** A person may ask for a refresh of one subscription at most once this often (`usage.refresh`). */
export const USAGE_REFRESH_MIN_INTERVAL_MS = 60 * 1000;
/** A snapshot older than this shows its time (“as of 14:32”). */
export const USAGE_STALE_AFTER_MS = 20 * 60 * 1000;

/**
 * When the next scheduled probe of a subscription is due: {@link USAGE_PROBE_ACTIVE_MS} after the last observation
 * while it was used in the last 24 hours, {@link USAGE_PROBE_IDLE_MS} otherwise; now when it was never observed.
 */
export function nextUsageProbeAt(observedAt: Date | null, lastUsedAt: Date | null, now: Date): Date {
  if (!observedAt) return now;
  const active = lastUsedAt !== null && now.getTime() - lastUsedAt.getTime() <= USAGE_ACTIVE_WITHIN_MS;
  return new Date(observedAt.getTime() + (active ? USAGE_PROBE_ACTIVE_MS : USAGE_PROBE_IDLE_MS));
}

/** Whether a snapshot observed at `observedAt` is old enough to show its time. */
export function isUsageStale(observedAt: Date | string | null, now: Date): boolean {
  if (observedAt === null) return true;
  return now.getTime() - new Date(observedAt).getTime() > USAGE_STALE_AFTER_MS;
}

/* Alerts --------------------------------------------------------------------------------------------------------- */

/** What the assistant says about a window: it crossed 80 % or 95 %, or the provider refused a turn (`limited`). */
export type UsageAlertLevel = UsageThreshold | 'limited';
/** Alert levels, lowest first: a higher one covers the lower ones for the same window. */
export const USAGE_ALERT_LEVELS: readonly UsageAlertLevel[] = [...USAGE_THRESHOLDS, 'limited'];

/** The highest alert level a window has reached, or null below 80 %. */
export function usageAlertLevel(w: Pick<UsageWindow, 'usedPct' | 'status'>): UsageAlertLevel | null {
  if (w.status === 'limited') return 'limited';
  const pct = w.usedPct;
  if (pct === null) return null;
  if (pct >= USAGE_CRITICAL_PCT) return USAGE_CRITICAL_PCT;
  if (pct >= USAGE_WARNING_PCT) return USAGE_WARNING_PCT;
  return null;
}

/**
 * The key that makes an alert once per window per level until the window resets:
 * `<provider>:<window>:<resetsAt | none>:<level>` (since 3.0 without the principal, CT-1513). The same window after its reset has another
 * `resetsAt`, so it alerts again.
 */
export function usageAlertKey(
  sub: Pick<SubscriptionUsage, 'provider'>,
  w: Pick<UsageWindow, 'kind' | 'resetsAt'>,
  level: UsageAlertLevel,
): string {
  const resets = w.resetsAt ? new Date(w.resetsAt).toISOString() : 'none';
  return `${sub.provider}:${w.kind}:${resets}:${level}`;
}

/**
 * The alert a window is due, or null: its highest level when that level's key wasn't sent yet. `markSent` holds that
 * key and the keys of the lower levels (a window that jumps from 70 % to 97 % says 95 % once, never 80 % after it).
 */
export function dueUsageAlert(
  sub: Pick<SubscriptionUsage, 'provider'>,
  w: Pick<UsageWindow, 'kind' | 'resetsAt' | 'usedPct' | 'status'>,
  wasSent: (key: string) => boolean,
): { level: UsageAlertLevel; key: string; markSent: string[] } | null {
  const level = usageAlertLevel(w);
  if (level === null) return null;
  const key = usageAlertKey(sub, w, level);
  if (wasSent(key)) return null;
  const upTo = USAGE_ALERT_LEVELS.slice(0, USAGE_ALERT_LEVELS.indexOf(level) + 1);
  return { level, key, markSent: upTo.map((l) => usageAlertKey(sub, w, l)) };
}
