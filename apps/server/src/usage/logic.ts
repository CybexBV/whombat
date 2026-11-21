/**
 * Subscription usage, the pure part (docs/decisions/ui-improvements.md UI-R09…UI-R12): when a subscription is due for
 * a probe, how a reading becomes the stored snapshot, and which alerts it is due. No I/O.
 */
import {
  dueUsageAlert,
  nextUsageProbeAt,
  type ProbeUsage,
  sortUsageWindows,
  type TurnRateLimits,
  USAGE_ACTIVE_WITHIN_MS,
  USAGE_ERROR_MAX,
  USAGE_PLAN_MAX,
  USAGE_PROBE_ACTIVE_MS,
  USAGE_PROBE_IDLE_MS,
  USAGE_REFRESH_MIN_INTERVAL_MS,
  USAGE_WINDOWS_MAX,
  type UsageAlertLevel,
  type UsageCredentialKind,
  type UsageProvider,
  type UsageSource,
  type UsageWindow,
} from '@whombat/core';

/** What the table keeps per subscription (the columns the logic reads and writes). */
export interface UsageRow {
  accountId: string;
  provider: UsageProvider;
  kind: UsageCredentialKind;
  plan: string | null;
  windows: UsageWindow[];
  observedAt: Date | null;
  source: UsageSource | null;
  error: string | null;
  probedAt: Date | null;
  refreshedAt: Date | null;
  usedAt: Date | null;
  alerts: string[];
}

export function emptyRow(accountId: string, provider: UsageProvider): UsageRow {
  return {
    accountId,
    provider,
    kind: 'subscription',
    plan: null,
    windows: [],
    observedAt: null,
    source: null,
    error: null,
    probedAt: null,
    refreshedAt: null,
    usedAt: null,
    alerts: [],
  };
}

/** Whether the subscription was used within the last 24 hours (probed every 15 minutes then, else hourly). */
export function recentlyUsed(row: Pick<UsageRow, 'usedAt'>, now: Date): boolean {
  return row.usedAt !== null && now.getTime() - row.usedAt.getTime() <= USAGE_ACTIVE_WITHIN_MS;
}

/**
 * When the next scheduled probe is due (UI-R10): core's `nextUsageProbeAt` from the last reading, and never sooner
 * than the same spacing after the last attempt (a probe that keeps failing is not retried every minute).
 */
export function probeDueAt(row: Pick<UsageRow, 'observedAt' | 'probedAt' | 'usedAt'>, now: Date): Date {
  const byReading = nextUsageProbeAt(row.observedAt, row.usedAt, now);
  if (!row.probedAt) return byReading;
  const spacing = recentlyUsed(row, now) ? USAGE_PROBE_ACTIVE_MS : USAGE_PROBE_IDLE_MS;
  const byAttempt = new Date(row.probedAt.getTime() + spacing);
  return byAttempt > byReading ? byAttempt : byReading;
}

/** Seconds until a person may ask for this subscription again (0: now). */
export function refreshWaitSeconds(row: Pick<UsageRow, 'refreshedAt'> | null, now: Date): number {
  if (!row?.refreshedAt) return 0;
  const left = row.refreshedAt.getTime() + USAGE_REFRESH_MIN_INTERVAL_MS - now.getTime();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/**
 * A window as stored: its reset time on the whole minute (Claude's probe says `15:00:00.368`, its turns `15:00:00`;
 * the same window must have one `resetsAt`, or its alerts would repeat), and a label within bounds.
 */
export function normalizeWindow(w: UsageWindow): UsageWindow {
  const resetsAt =
    w.resetsAt === null ? null : new Date(Math.round(Date.parse(w.resetsAt) / 60_000) * 60_000).toISOString();
  return { ...w, resetsAt, label: w.label.slice(0, 80) };
}

/**
 * The snapshot after a reading (UI-R09). A probe that read usage replaces it (windows, plan, kind); a probe that
 * couldn't keeps the last good windows and says why (`error`); a turn's reading replaces the windows it names and keeps
 * the rest and the plan (the turns' events are sparse).
 */
export function applyReading(
  row: UsageRow,
  reading: ProbeUsage | TurnRateLimits,
  source: UsageSource,
  now: Date,
): UsageRow {
  const windows = reading.windows.map(normalizeWindow);
  if (source === 'probe') {
    const probe = reading as ProbeUsage;
    const next: UsageRow = { ...row, probedAt: now };
    if (probe.error && probe.windows.length === 0 && probe.kind === 'subscription')
      return { ...next, error: probe.error.slice(0, USAGE_ERROR_MAX) };
    return {
      ...next,
      kind: probe.kind,
      plan: probe.plan?.slice(0, USAGE_PLAN_MAX) ?? (probe.kind === 'api_key' ? null : row.plan),
      windows: sortUsageWindows(windows).slice(0, USAGE_WINDOWS_MAX),
      observedAt: new Date(probe.observedAt),
      source: 'probe',
      error: probe.error?.slice(0, USAGE_ERROR_MAX) ?? null,
    };
  }
  const key = (w: UsageWindow) => `${w.kind}:${w.label}`;
  const named = new Set(windows.map(key));
  const kept = row.kind === 'subscription' ? row.windows.filter((w) => !named.has(key(w))) : [];
  return {
    ...row,
    kind: 'subscription',
    plan: reading.plan?.slice(0, USAGE_PLAN_MAX) ?? row.plan,
    windows: sortUsageWindows([...windows, ...kept]).slice(0, USAGE_WINDOWS_MAX),
    observedAt: new Date(reading.observedAt),
    source: 'turn',
    error: null,
    usedAt: now,
  };
}

/** Most alert keys a row remembers (a key per window, level and reset: a handful per week). */
export const ALERT_KEYS_MAX = 64;

export interface DueAlert {
  level: UsageAlertLevel;
  window: UsageWindow;
}

/**
 * The alerts a snapshot is due (UI-R11): per window its highest level (80 %, 95 %, the limit hit) when it wasn't
 * posted yet for that window's reset, and the keys to remember. Core's `dueUsageAlert` keys by subscription, window,
 * reset time and level; a window after its reset has another reset time and alerts again.
 */
export function dueAlerts(row: UsageRow): { alerts: DueAlert[]; keys: string[] } {
  if (row.kind !== 'subscription') return { alerts: [], keys: row.alerts };
  const sent = new Set(row.alerts);
  const alerts: DueAlert[] = [];
  const marked: string[] = [];
  for (const window of row.windows) {
    const due = dueUsageAlert({ provider: row.provider }, window, (k) => sent.has(k));
    if (!due) continue;
    alerts.push({ level: due.level, window });
    for (const k of due.markSent) if (!sent.has(k)) marked.push(k);
  }
  return { alerts, keys: [...row.alerts, ...marked].slice(-ALERT_KEYS_MAX) };
}

/** Where a subscription's alert goes (UI-R12): the person's Chat in the burrow they were last active in. */
export interface AlertPlace {
  /** The person's principal in the burrow the message goes to. */
  personId: string;
  burrowId: string;
  accountId: string;
}
