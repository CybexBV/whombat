/**
 * Subscription usage copy (CT-156): meters, “resets in 2 h 10 min”, “as of 14:32”, and what a person's assistant says
 * when a window crosses 80 % or 95 % or its limit was hit. Times are the reader's clock in their time zone (24-hour,
 * like the rest of the product). A percentage is the number, a no-break space and `%` (“85 %”).
 */
import type { SubscriptionUsage, UsageAlertLevel, UsageProvider, UsageWindow } from '../domain/usage.js';
import { sortUsageWindows, USAGE_WINDOW_LABELS } from '../domain/usage.js';
import { type DateInput, daysAgo, formatClock, formatDate, formatShortWeekday, toDate } from './time.js';

/** The no-break space between a number and `%`. */
export const NBSP = String.fromCharCode(0xa0);

/** People's name for each provider's subscription (`codex` is ChatGPT, CT-1450). */
export const USAGE_PROVIDER_LABELS: Record<UsageProvider, string> = { claude: 'Claude', codex: 'ChatGPT' };

/** `85 %` (rounded; a no-break space before `%`), `<1 %` for a trace, `—` when unknown. */
export function formatUsagePct(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '—';
  if (pct > 0 && pct < 1) return `<1${NBSP}%`;
  return `${Math.round(Math.min(100, Math.max(0, pct)))}${NBSP}%`;
}

/** `2 h 10 min`, `45 min`, `3 d 4 h`, `2 h` — a span in whole minutes, rounded up (never “0 min”). */
export function formatUsageSpan(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const m = minutes % 60;
    return m === 0 ? `${hours} h` : `${hours} h ${m} min`;
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h === 0 ? `${days} d` : `${days} d ${h} h`;
}

/** `resets in 2 h 10 min`; `resets now` once the time has passed; `` when unknown. */
export function formatResetsIn(resetsAt: DateInput | null, now: DateInput): string {
  if (resetsAt === null) return '';
  const ms = toDate(resetsAt).getTime() - toDate(now).getTime();
  return ms <= 0 ? 'resets now' : `resets in ${formatUsageSpan(ms)}`;
}

/** `16:00` today, `Thu 09:00` within the week, else `3 Oct` — when a window resets, in the reader's zone. */
export function formatResetTime(resetsAt: DateInput, now: DateInput, timeZone: string): string {
  const diff = -daysAgo(resetsAt, now, timeZone);
  if (diff <= 0) return formatClock(resetsAt, timeZone);
  if (diff < 7) return `${formatShortWeekday(resetsAt, timeZone)} ${formatClock(resetsAt, timeZone)}`;
  return formatDate(resetsAt, timeZone, { now });
}

/** `as of 14:32` today, `as of 28 Sep, 14:32` before; `not read yet` when never observed. */
export function formatAsOf(observedAt: DateInput | null, now: DateInput, timeZone: string): string {
  if (observedAt === null) return 'not read yet';
  const clock = formatClock(observedAt, timeZone);
  return daysAgo(observedAt, now, timeZone) === 0
    ? `as of ${clock}`
    : `as of ${formatDate(observedAt, timeZone, { now })}, ${clock}`;
}

/** An API-key sign-in's line instead of meters. */
export const USAGE_PAY_AS_YOU_GO = 'Pay as you go — see Spend';

/** A window's line under its meter: `5-hour · 85 % · resets in 2 h 10 min`. */
export function formatUsageWindowLine(
  w: Pick<UsageWindow, 'label' | 'usedPct' | 'resetsAt' | 'status'>,
  now: DateInput,
): string {
  const parts = [w.label, w.status === 'limited' ? 'limit reached' : formatUsagePct(w.usedPct)];
  const resets = formatResetsIn(w.resetsAt, now);
  if (resets) parts.push(resets);
  return parts.join(' · ');
}

/**
 * What a person's assistant posts in their DM when a window of a subscription crosses 80 % or 95 %, or its limit was
 * hit. `forOwner`: the assistant of the person the subscription belongs to (“Your Claude subscription …”); otherwise
 * an owner's or admin's assistant (“Jamie’s Claude subscription …”, with the person's short name).
 *
 * - `Your Claude subscription is at 85 % of its 5-hour limit, resets at 16:00.`
 * - `Jamie’s Claude subscription is at 96 % of its 7-day limit, resets Thu 09:00.`
 * - `Your ChatGPT subscription hit its 5-hour limit, resets at 16:00. Turns on it wait until then.`
 */
export function usageAlertText(input: {
  level: UsageAlertLevel;
  provider: UsageProvider;
  window: Pick<UsageWindow, 'kind' | 'usedPct' | 'resetsAt'>;
  /** The subscription owner's short name; unused when `forOwner`. */
  personName: string;
  forOwner: boolean;
  now: DateInput;
  timeZone: string;
}): string {
  const { level, provider, window: w, personName, forOwner, now, timeZone } = input;
  const whose = forOwner ? 'Your' : `${personName}’s`;
  const what = `${whose} ${USAGE_PROVIDER_LABELS[provider]} subscription`;
  const label = USAGE_WINDOW_LABELS[w.kind] === 'Usage' ? 'usage' : USAGE_WINDOW_LABELS[w.kind];
  const limit = label === 'usage' ? 'its usage limit' : `its ${label} limit`;
  let resets = '';
  if (w.resetsAt !== null) {
    const at = formatResetTime(w.resetsAt, now, timeZone);
    resets = /^\d/.test(at) && at.includes(':') ? `, resets at ${at}` : `, resets ${at}`;
  }
  if (level === 'limited') {
    const wait = forOwner ? ' Turns on it wait until then.' : '';
    return `${what} hit ${limit}${resets}.${w.resetsAt !== null ? wait : ''}`;
  }
  const pct = formatUsagePct(w.usedPct ?? level);
  return `${what} is at ${pct} of ${limit}${resets}.`;
}

/** Plain summary of a snapshot for places without meters (notifications, the assistant's answers). */
export function usageSummaryText(
  sub: Pick<SubscriptionUsage, 'provider' | 'kind' | 'windows' | 'connected'>,
  now: DateInput,
): string {
  const name = `${USAGE_PROVIDER_LABELS[sub.provider]}`;
  if (!sub.connected) return `${name} · not signed in`;
  if (sub.kind === 'api_key') return `${name} · ${USAGE_PAY_AS_YOU_GO}`;
  if (sub.windows.length === 0) return `${name} · no usage read yet`;
  return `${name} · ${sortUsageWindows(sub.windows)
    .map((w) => formatUsageWindowLine(w, now))
    .join(' · ')}`;
}
