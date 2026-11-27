/**
 * Usage: the Spend report (`spend.overview`) as people read it, the same on the web and the phone
 * (docs/decisions/final-settings-vault-files-usage.md). It leads with what it cost and how many times the assistant
 * worked in the chosen window, says honestly how many of those times reported a cost (“Cost reported for 4 of 5”),
 * names the window and when the report was prepared, and keeps the rest under More: that the report combines every
 * provider, how much text was read and written, missing reports and the plans that used the most. No runtime words:
 * a finished turn is “a time {assistant} worked”, and tokens are “pieces of text”. Pure.
 */
import {
  formatTokenCount,
  SPEND_WINDOW_DAYS,
  SPEND_WINDOWS,
  type SpendOverview,
  type SpendTotals,
  type SpendWindow,
  spendTokens,
} from '@whombat/core/domain';
import { formatLocaleNumber, formatLocaleOf, resolveLanguage } from '@whombat/core/i18n';
import { formatClock, formatDate } from '@whombat/core/text';
import { agentWords } from './agentName';
import { clientTranslator } from './i18n/catalog';

export { SPEND_WINDOWS as USAGE_WINDOWS };
export type UsageWindow = SpendWindow;

export function usageText(locale?: string | null) {
  const tr = clientTranslator(locale);
  return {
    title: tr.t('usage.title'),
    intro: (agent: string) => tr.t('usage.intro', { Name: agentWords(agent, locale).Name }),
    windowsLabel: tr.t('usage.windowsLabel'),
    windows: {
      today: tr.t('usage.window.today'),
      week: tr.t('usage.window.week'),
      month: tr.t('usage.window.month'),
    } satisfies Record<SpendWindow, string>,
    cost: tr.t('usage.cost'),
    unit: 'USD',
    worked: (agent: string) => tr.t('usage.worked', { Name: agentWords(agent, locale).Name }),
    noCost: tr.t('usage.noCost'),
    definition: tr.t('usage.definition'),
    loading: tr.t('usage.loading'),
    emptyTitle: tr.t('usage.emptyTitle'),
    emptyLine: tr.t('usage.emptyLine'),
    failedTitle: tr.t('usage.failedTitle'),
    failedLine: tr.t('usage.failedLine'),
    retry: tr.t('usage.retry'),
    more: tr.t('usage.more'),
    coverageTitle: tr.t('usage.coverageTitle'),
    coverageLines: [tr.t('usage.coverageLine1'), tr.t('usage.coverageLine2')] as const,
    textTitle: tr.t('usage.textTitle'),
    textLine: (agent: string) => tr.t('usage.textLine', { Name: agentWords(agent, locale).Name }),
    plansTitle: tr.t('usage.plansTitle'),
    plansLine: tr.t('usage.plansLine'),
  };
}

export const USAGE_TEXT = usageText();

/** “$0.37”, “$1,204.00”, “under $0.01”; null when nothing reported a cost. */
export function usageCost(usd: number | null, locale?: string | null): string | null {
  if (usd === null || !Number.isFinite(usd)) return null;
  if (usd > 0 && usd < 0.01) return clientTranslator(locale).t('usage.underCent');
  const num =
    resolveLanguage(locale) === 'en' && !locale
      ? usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : formatLocaleNumber(usd, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `$${num}`;
}

/** “Cost reported for 4 of 5”: how many of the window's times reported a cost. */
export function usageCoverage(t: Pick<SpendTotals, 'turns' | 'costTurns'>, locale?: string | null): string {
  return clientTranslator(locale).t('usage.coverage', { costTurns: t.costTurns, turns: t.turns });
}

/** The place's city, as people say it: “Europe/Amsterdam” → “Amsterdam”. */
export function zoneCity(timeZone: string): string {
  return (timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ');
}

const DAY = 86_400_000;

function shortDayMonth(d: Date, timeZone: string, locale?: string | null): string {
  if (!locale) return formatDate(d, timeZone, { year: 'never' });
  return new Intl.DateTimeFormat(formatLocaleOf(locale), { day: 'numeric', month: 'short', timeZone })
    .format(d)
    .replace(/\.$/, '');
}

function fullDayMonthYear(d: Date, timeZone: string, locale?: string | null): string {
  if (!locale) return formatDate(d, timeZone, { year: 'always' });
  return new Intl.DateTimeFormat(formatLocaleOf(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone,
  })
    .format(d)
    .replace(/\.$/, '');
}

/**
 * The window the numbers cover, ending when the report was prepared: “23 Sep 00:00–11:22 · Europe/Amsterdam” for
 * today, “16 Sep 11:22–23 Sep 11:22 · Europe/Amsterdam” for the last 7 days.
 */
export function usageWindowText(
  window: SpendWindow,
  generatedAt: string,
  timeZone: string,
  locale?: string | null,
): string {
  const end = new Date(generatedAt);
  const at = (d: Date) => `${shortDayMonth(d, timeZone, locale)} ${formatClock(d, timeZone)}`;
  const span =
    window === 'today'
      ? `${shortDayMonth(end, timeZone, locale)} 00:00–${formatClock(end, timeZone)}`
      : `${at(new Date(end.getTime() - SPEND_WINDOW_DAYS[window] * DAY))}–${at(end)}`;
  return `${span} · ${timeZone}`;
}

/** “Prepared 23 Sep 2026 at 11:22 Amsterdam. Estimates cover the times that reported a cost.” */
export function usagePreparedText(generatedAt: string, timeZone: string, locale?: string | null): string {
  const d = new Date(generatedAt);
  return clientTranslator(locale).t('usage.prepared', {
    date: fullDayMonthYear(d, timeZone, locale),
    clock: formatClock(d, timeZone),
    city: zoneCity(timeZone),
  });
}

/** One window of the report, ready to draw. */
export interface UsageWindowView {
  window: SpendWindow;
  /** The chooser's label. */
  label: string;
  /** Nothing finished in the window: the empty state, never a $0 or a 0. */
  empty: boolean;
  /** “$0.37”, or null when no time reported a cost. */
  cost: string | null;
  /** “Cost reported for 4 of 5”. */
  coverage: string;
  /** How many times the assistant worked. */
  times: number;
  /** “23 Sep 00:00–11:22 · Europe/Amsterdam”. */
  span: string;
  /** More → Text read and written: “92.6k pieces of text”. */
  text: string;
  /** More: “All 5 times sent a usage report”, “1 time sent no usage report”. */
  reports: string;
  /** What a screen reader says for the two numbers together. */
  spoken: string;
}

export interface UsageView {
  title: string;
  intro: string;
  worked: string;
  prepared: string;
  windows: Record<SpendWindow, UsageWindowView>;
  /** More → Recorded by plan: “Invoice PDF export · 3.3M pieces of text”. */
  plans: string[];
}

function windowView(
  window: SpendWindow,
  t: SpendTotals,
  generatedAt: string,
  timeZone: string,
  agent: string,
  locale?: string | null,
): UsageWindowView {
  const tr = clientTranslator(locale);
  const text = usageText(locale);
  const cost = usageCost(t.costUsd, locale);
  const coverage = usageCoverage(t, locale);
  const times = tr.tp('usage.times', t.turns);
  return {
    window,
    label: text.windows[window],
    empty: t.turns === 0,
    cost,
    coverage,
    times: t.turns,
    span: usageWindowText(window, generatedAt, timeZone, locale),
    text: tr.t('usage.piecesOfText', { tokens: formatTokenCount(spendTokens(t)) }),
    reports:
      t.unreportedTurns === 0
        ? t.turns === 1
          ? tr.t('usage.reportOne')
          : tr.tp('usage.reportAll', t.turns)
        : tr.tp('usage.reportMissing', t.unreportedTurns),
    spoken: tr.t('usage.spoken', {
      window: text.windows[window],
      cost: cost ? tr.t('usage.aboutCost', { cost }) : text.noCost,
      coverage,
      Name: agentWords(agent, locale).Name,
      times,
    }),
  };
}

/** The report as the page draws it, the assistant by its name. */
export function usageView(data: SpendOverview, agent: string, locale?: string | null): UsageView {
  const tr = clientTranslator(locale);
  const text = usageText(locale);
  const windows = Object.fromEntries(
    SPEND_WINDOWS.map((w) => [
      w,
      windowView(w, data.totals[w], data.generatedAt, data.timeZone, agent, locale),
    ]),
  ) as Record<SpendWindow, UsageWindowView>;
  return {
    title: text.title,
    intro: text.intro(agent),
    worked: text.worked(agent),
    prepared: usagePreparedText(data.generatedAt, data.timeZone, locale),
    windows,
    plans: data.plans.map((p) =>
      tr.t('usage.planLine', { title: p.title, tokens: formatTokenCount(p.usedTokens) }),
    ),
  };
}
