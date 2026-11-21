/**
 * Subscription usage, the web side (contracts CT-153…CT-157; AP-340…AP-349): the copy and the pure pieces of Settings →
 * AI → Usage (SS-01; General's compact meter went with SS-03). Numbers, times and lines come from core (`formatUsagePct`,
 * `formatResetsIn`, `formatAsOf`, …) so the web, the phone and the assistant say the same.
 */
import {
  LIVE_PROVIDERS,
  type SubscriptionUsage,
  USAGE_CRITICAL_PCT,
  USAGE_WARNING_PCT,
  type UsageLevel,
  type UsageProvider,
  type UsageWindow,
  windowLevel,
} from '@whombat/core/domain';
import { formatUsagePct, USAGE_PROVIDER_LABELS } from '@whombat/core/text';

export const USAGE_TEXT = {
  lead: 'How much of your Claude and ChatGPT subscriptions’ 5-hour and 7-day limits is used. What your agent does for you counts against them.',
  note: `Read from Claude Code and ChatGPT every 15 minutes while you use them, hourly otherwise. Your agent tells you at ${formatUsagePct(USAGE_WARNING_PCT)} and ${formatUsagePct(USAGE_CRITICAL_PCT)}.`,
  mine: 'YOUR SUBSCRIPTIONS',
  loadFailed: 'Couldn’t load usage.',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  refreshIn: (seconds: number) => `Refresh in ${seconds} s`,
  refreshFailed: 'Couldn’t read your usage. Try again in a moment.',
  notSignedIn: (provider: UsageProvider) =>
    `You’re not signed in to ${USAGE_PROVIDER_LABELS[provider]} anymore.`,
  notConnected: 'Not connected',
  signIn: 'Sign in',
  signInHelp: 'Sign in with your own subscription under Accounts to see its limits here.',
  apiKey: 'API key',
  subscription: 'Subscription',
  notRead: 'Not read yet. Refresh to read it now.',
  noWindows: 'Its provider didn’t report any limits.',
} as const;

/**
 * Settings → AI in the assistant shell (less-is-more.md AP-1780, AP-1781): a subscription's plan in its sign-in row, how
 * usage is read (folded, AP-1751) and a stale snapshot's note.
 */
export const INLINE_USAGE_TEXT = {
  payAsYouGo: 'Pay as you go',
  /** The refresh control's name: “Refresh Claude usage”, while it waits “Refresh in 42 s (Claude)” (`refreshIn`). */
  refresh: (provider: string) => `Refresh ${provider} usage`,
  /** Under the AI clients, in the folded area (AP-1786). */
  howRead: (assistant: string) =>
    `Usage is read from Claude Code and ChatGPT every 15 minutes while you use them, hourly otherwise; ${assistant} tells you at ${formatUsagePct(USAGE_WARNING_PCT)} and ${formatUsagePct(USAGE_CRITICAL_PCT)}.`,
  /** A stale snapshot, after the row's state: “usage as of 10:32”. */
  asOf: (asOf: string) => `usage ${asOf}`,
} as const;

/** The plan a subscription's row names: “Max plan”, or null when the provider didn't say (“Subscription” says nothing new). */
export function planLabel(sub: Pick<SubscriptionUsage, 'kind' | 'plan'>): string | null {
  if (sub.kind === 'api_key') return INLINE_USAGE_TEXT.payAsYouGo;
  const plan = formatPlan(sub.plan);
  return plan ? `${plan} plan` : null;
}

/** The meter's color: `--ok`, `--warn`, `--bad`; `--mut` when the share is unknown. */
export type MeterTone = 'ok' | 'warn' | 'bad' | 'mut';

const TONES: Record<UsageLevel, MeterTone> = { ok: 'ok', warning: 'warn', critical: 'bad' };

export function meterTone(w: Pick<UsageWindow, 'usedPct' | 'status'>): MeterTone {
  const level = windowLevel(w);
  return level ? TONES[level] : 'mut';
}

/**
 * The word beside a window's share, so its state never rests on color alone: nothing below 80 %, “High” from 80 %,
 * “Near the limit” from 95 %, “Limit reached” when the provider refuses turns.
 */
export function windowStatusWord(w: Pick<UsageWindow, 'usedPct' | 'status'>): string | null {
  if (w.status === 'limited') return 'Limit reached';
  const level = windowLevel(w);
  if (level === 'critical') return 'Near the limit';
  if (level === 'warning') return 'High';
  return null;
}

/** The share a meter shows: the reported one, full when limited without a number, else empty. */
export function meterValue(w: Pick<UsageWindow, 'usedPct' | 'status'>): number {
  if (w.usedPct !== null) return Math.min(100, Math.max(0, w.usedPct));
  return w.status === 'limited' ? 100 : 0;
}

/** `62 %`, or `limit reached` when limited without a number. */
export function windowPctText(w: Pick<UsageWindow, 'usedPct' | 'status'>): string {
  if (w.usedPct === null && w.status === 'limited') return 'limit reached';
  return formatUsagePct(w.usedPct);
}

/** `Max`, `Pro`, `Plus`, `Max 5x` — the plan as the CLI names it, capitalized. */
export function formatPlan(plan: string | null): string | null {
  if (!plan) return null;
  const words = plan.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

/** What a subscription is: `Max plan`, `Subscription`, `API key`. */
export function kindText(sub: Pick<SubscriptionUsage, 'kind' | 'plan'>): string {
  if (sub.kind === 'api_key') return USAGE_TEXT.apiKey;
  const plan = formatPlan(sub.plan);
  return plan ? `${plan} plan` : USAGE_TEXT.subscription;
}

/** A card per provider the person can sign in to: their snapshot, or null when they haven't signed in to it. */
export function mineByProvider(
  mine: readonly SubscriptionUsage[],
): { provider: UsageProvider; usage: SubscriptionUsage | null }[] {
  return LIVE_PROVIDERS.map((provider) => ({
    provider,
    usage: mine.find((s) => s.provider === provider) ?? null,
  }));
}

/** Replaces a subscription's snapshot (same provider: the person's own, CT-1513) in a `usage.list` answer. */
export function withUsage<T extends { mine: SubscriptionUsage[] }>(list: T, usage: SubscriptionUsage): T {
  const same = (s: SubscriptionUsage) => s.provider === usage.provider;
  const mine = list.mine.some(same) ? list.mine.map((s) => (same(s) ? usage : s)) : [...list.mine, usage];
  return { ...list, mine };
}
