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
import { formatClock, formatDate, plural } from '@whombat/core/text';
import { agentWords } from './agentName';

export { SPEND_WINDOWS as USAGE_WINDOWS };
export type UsageWindow = SpendWindow;

export const USAGE_TEXT = {
  title: 'Usage',
  intro: (agent: string) => `What it cost and how much ${agentWords(agent).Name} worked.`,
  /** The window chooser's group name, for screen readers. */
  windowsLabel: 'Usage time window',
  windows: { today: 'Today', week: 'Last 7 days', month: 'Last 30 days' } satisfies Record<
    SpendWindow,
    string
  >,
  cost: 'Estimated cost',
  unit: 'USD',
  worked: (agent: string) => `Times ${agentWords(agent).Name} worked`,
  noCost: 'No cost reported',
  /** What one time is: never a count of finished tasks. */
  definition:
    'Each time is one go at answering or working for you. It can include several steps; it isn’t a count of completed tasks.',
  loading: 'Loading Usage…',
  emptyTitle: 'No usage reported for this window',
  emptyLine: 'No reports is different from no use. There is no cost or work total to show.',
  failedTitle: 'Couldn’t read Usage',
  failedLine: 'There’s no saved copy to show on this device yet.',
  retry: 'Try again',
  more: 'More',
  coverageTitle: 'Provider coverage',
  coverageLines: [
    'All providers reporting here are combined. This report doesn’t name them or split their use.',
    'It is different from the provider selected for your next reply.',
  ],
  textTitle: 'Text read and written',
  textLine: (agent: string) =>
    `Counted in the small pieces of text the AI providers measure what ${agentWords(agent).Name} reads and writes in. They measure text, not tasks or time.`,
  plansTitle: 'Recorded by plan',
  plansLine: 'What saved plans used in the last 30 days, separate from the chosen window. It is not a bill.',
} as const;

/** “$0.37”, “$1,204.00”, “under $0.01”; null when nothing reported a cost. */
export function usageCost(usd: number | null): string | null {
  if (usd === null || !Number.isFinite(usd)) return null;
  if (usd > 0 && usd < 0.01) return 'under $0.01';
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** “Cost reported for 4 of 5”: how many of the window's times reported a cost. */
export function usageCoverage(t: Pick<SpendTotals, 'turns' | 'costTurns'>): string {
  return `Cost reported for ${t.costTurns} of ${t.turns}`;
}

/** The place's city, as people say it: “Europe/Amsterdam” → “Amsterdam”. */
export function zoneCity(timeZone: string): string {
  return (timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ');
}

const DAY = 86_400_000;

/**
 * The window the numbers cover, ending when the report was prepared: “23 Sep 00:00–11:22 · Europe/Amsterdam” for
 * today, “16 Sep 11:22–23 Sep 11:22 · Europe/Amsterdam” for the last 7 days.
 */
export function usageWindowText(window: SpendWindow, generatedAt: string, timeZone: string): string {
  const end = new Date(generatedAt);
  const at = (d: Date) => `${formatDate(d, timeZone, { year: 'never' })} ${formatClock(d, timeZone)}`;
  const span =
    window === 'today'
      ? `${formatDate(end, timeZone, { year: 'never' })} 00:00–${formatClock(end, timeZone)}`
      : `${at(new Date(end.getTime() - SPEND_WINDOW_DAYS[window] * DAY))}–${at(end)}`;
  return `${span} · ${timeZone}`;
}

/** “Prepared 23 Sep 2026 at 11:22 Amsterdam. Estimates cover the times that reported a cost.” */
export function usagePreparedText(generatedAt: string, timeZone: string): string {
  const d = new Date(generatedAt);
  return `Prepared ${formatDate(d, timeZone, { year: 'always' })} at ${formatClock(d, timeZone)} ${zoneCity(timeZone)}. Estimates cover the times that reported a cost.`;
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
): UsageWindowView {
  const cost = usageCost(t.costUsd);
  const coverage = usageCoverage(t);
  const times = plural(t.turns, 'time');
  return {
    window,
    label: USAGE_TEXT.windows[window],
    empty: t.turns === 0,
    cost,
    coverage,
    times: t.turns,
    span: usageWindowText(window, generatedAt, timeZone),
    text: `${formatTokenCount(spendTokens(t))} pieces of text`,
    reports:
      t.unreportedTurns === 0
        ? t.turns === 1
          ? 'That time sent a usage report.'
          : `All ${times} sent a usage report.`
        : `${plural(t.unreportedTurns, 'time')} sent no usage report.`,
    spoken: `${USAGE_TEXT.windows[window]}: ${cost ? `about ${cost}` : USAGE_TEXT.noCost}, ${coverage}. ${agentWords(agent).Name} worked ${times}.`,
  };
}

/** The report as the page draws it, the assistant by its name. */
export function usageView(data: SpendOverview, agent: string): UsageView {
  const windows = Object.fromEntries(
    SPEND_WINDOWS.map((w) => [w, windowView(w, data.totals[w], data.generatedAt, data.timeZone, agent)]),
  ) as Record<SpendWindow, UsageWindowView>;
  return {
    title: USAGE_TEXT.title,
    intro: USAGE_TEXT.intro(agent),
    worked: USAGE_TEXT.worked(agent),
    prepared: usagePreparedText(data.generatedAt, data.timeZone),
    windows,
    plans: data.plans.map((p) => `${p.title} · ${formatTokenCount(p.usedTokens)} pieces of text`),
  };
}
