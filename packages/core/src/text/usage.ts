/**
 * Subscription usage copy (CT-156): meters, “resets in 2 h 10 min”, “as of 14:32”, and what a person's assistant says
 * when a window crosses 80 % or 95 % or its limit was hit. Times are the reader's clock in their time zone (24-hour,
 * like the rest of the product). A percentage is the number, a no-break space and `%` (“85 %”).
 */
import type {
  SubscriptionUsage,
  UsageAlertLevel,
  UsageProvider,
  UsageWindow,
  UsageWindowKind,
} from '../domain/usage.js';
import { sortUsageWindows, USAGE_WINDOW_LABELS } from '../domain/usage.js';
import { coreTranslator } from '../i18n/catalog.js';
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
export function formatUsageSpan(ms: number, locale?: string | null): string {
  const tr = coreTranslator(locale);
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return tr.t('usage.minutes', { m: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const m = minutes % 60;
    return m === 0 ? tr.t('usage.hours', { h: hours }) : tr.t('usage.hoursMinutes', { h: hours, m });
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h === 0 ? tr.t('usage.days', { d: days }) : tr.t('usage.daysHours', { d: days, h });
}

/** `resets in 2 h 10 min`; `resets now` once the time has passed; `` when unknown. */
export function formatResetsIn(resetsAt: DateInput | null, now: DateInput, locale?: string | null): string {
  if (resetsAt === null) return '';
  const tr = coreTranslator(locale);
  const ms = toDate(resetsAt).getTime() - toDate(now).getTime();
  return ms <= 0 ? tr.t('usage.resetsNow') : tr.t('usage.resetsIn', { span: formatUsageSpan(ms, locale) });
}

/** `16:00` today, `Thu 09:00` within the week, else `3 Oct` — when a window resets, in the reader's zone. */
export function formatResetTime(
  resetsAt: DateInput,
  now: DateInput,
  timeZone: string,
  locale?: string | null,
): string {
  const diff = -daysAgo(resetsAt, now, timeZone);
  if (diff <= 0) return formatClock(resetsAt, timeZone);
  if (diff < 7) return `${formatShortWeekday(resetsAt, timeZone, locale)} ${formatClock(resetsAt, timeZone)}`;
  return formatDate(resetsAt, timeZone, { now }, locale);
}

/** `as of 14:32` today, `as of 28 Sep, 14:32` before; `not read yet` when never observed. */
export function formatAsOf(
  observedAt: DateInput | null,
  now: DateInput,
  timeZone: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  if (observedAt === null) return tr.t('usage.notRead');
  const clock = formatClock(observedAt, timeZone);
  return daysAgo(observedAt, now, timeZone) === 0
    ? tr.t('usage.asOf', { clock })
    : tr.t('usage.asOfDate', { date: formatDate(observedAt, timeZone, { now }, locale), clock });
}

/** An API-key sign-in's line instead of meters, in a locale. */
export function usagePayAsYouGo(locale?: string | null): string {
  return coreTranslator(locale).t('usage.payAsYouGo');
}

/** An API-key sign-in's line instead of meters. */
export const USAGE_PAY_AS_YOU_GO = usagePayAsYouGo('en');

/** A usage window's name in a locale (`5-hour`, `5-uurs`). */
export function usageWindowLabel(kind: UsageWindowKind, locale?: string | null): string {
  return coreTranslator(locale).t(`usage.window.${kind}`);
}

/** The window's own label in the locale: a known English label maps to its translation, the provider's words stay. */
function localWindowLabel(label: string, locale?: string | null): string {
  if (coreTranslator(locale).language === 'en') return label;
  for (const [kind, english] of Object.entries(USAGE_WINDOW_LABELS)) {
    if (english === label) return usageWindowLabel(kind as UsageWindowKind, locale);
  }
  return label;
}

/** A window's line under its meter: `5-hour · 85 % · resets in 2 h 10 min`. */
export function formatUsageWindowLine(
  w: Pick<UsageWindow, 'label' | 'usedPct' | 'resetsAt' | 'status'>,
  now: DateInput,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const parts = [
    localWindowLabel(w.label, locale),
    w.status === 'limited' ? tr.t('usage.limitReached') : formatUsagePct(w.usedPct),
  ];
  const resets = formatResetsIn(w.resetsAt, now, locale);
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
  locale?: string | null;
}): string {
  const { level, provider, window: w, personName, forOwner, now, timeZone, locale } = input;
  const tr = coreTranslator(locale);
  const providerName = USAGE_PROVIDER_LABELS[provider];
  const what = forOwner
    ? tr.t('usage.yourSub', { provider: providerName })
    : tr.t('usage.theirSub', { person: personName, provider: providerName });
  const limit =
    w.kind === 'other' || USAGE_WINDOW_LABELS[w.kind] === 'Usage'
      ? tr.t('usage.itsUsageLimit')
      : tr.t('usage.itsLimit', { label: usageWindowLabel(w.kind, locale) });
  let resets = '';
  if (w.resetsAt !== null) {
    const at = formatResetTime(w.resetsAt, now, timeZone, locale);
    resets =
      /^\d/.test(at) && at.includes(':') ? tr.t('usage.resetsAt', { at }) : tr.t('usage.resetsOn', { at });
  }
  if (level === 'limited') {
    const wait = forOwner && w.resetsAt !== null ? tr.t('usage.waitUntil') : '';
    return tr.t('usage.hit', { what, limit, resets, wait });
  }
  const pct = formatUsagePct(w.usedPct ?? level);
  return tr.t('usage.at', { what, pct, limit, resets });
}

/** Plain summary of a snapshot for places without meters (notifications, the assistant's answers). */
export function usageSummaryText(
  sub: Pick<SubscriptionUsage, 'provider' | 'kind' | 'windows' | 'connected'>,
  now: DateInput,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const name = `${USAGE_PROVIDER_LABELS[sub.provider]}`;
  if (!sub.connected) return tr.t('usage.notSignedIn', { name });
  if (sub.kind === 'api_key') return `${name} · ${usagePayAsYouGo(locale)}`;
  if (sub.windows.length === 0) return tr.t('usage.noUsage', { name });
  return `${name} · ${sortUsageWindows(sub.windows)
    .map((w) => formatUsageWindowLine(w, now, locale))
    .join(' · ')}`;
}
