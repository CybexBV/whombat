/**
 * Search filters (contracts CT-180; docs/decisions/essentials-messages.md AP-448): who said it (`from`, a handle), where
 * (`in`, a conversation), and when (`after` / `before`, calendar days, inclusive, in the viewer's zone). The date menu
 * offers Any time, Today, Last 7 days, Last 30 days and Custom dates; the URL holds only the four values.
 */
import { ConversationId, dayKey, Handle, IsoDate, type Principal } from '@whombat/core';

export interface SearchFilterValues {
  from?: string;
  in?: string;
  after?: string;
  before?: string;
}

/** The filters from an address, each dropped when malformed (so an old or hand-edited link still opens). */
export function parseSearchFilters(raw: Record<string, unknown>): SearchFilterValues {
  const pick = <T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, value: unknown) => {
    const r = schema.safeParse(value);
    return r.success ? (r.data as T) : undefined;
  };
  const out: SearchFilterValues = {
    from: pick<string>(Handle, raw.from),
    in: pick<string>(ConversationId, raw.in),
    after: pick<string>(IsoDate, raw.after),
    before: pick<string>(IsoDate, raw.before),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as SearchFilterValues;
}

export function hasSearchFilters(f: SearchFilterValues): boolean {
  return !!(f.from || f.in || f.after || f.before);
}

export type DatePreset = 'any' | 'today' | 'week' | 'month' | 'custom';

export const DATE_PRESETS: readonly DatePreset[] = ['any', 'today', 'week', 'month', 'custom'];

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  any: 'Any time',
  today: 'Today',
  week: 'Last 7 days',
  month: 'Last 30 days',
  custom: 'Custom dates',
};

/** `2026-09-23` plus `n` days (negative goes back), by the calendar. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + n));
  return date.toISOString().slice(0, 10);
}

/** Today in the viewer's zone. */
export function todayIn(timeZone: string, now: number = Date.now()): string {
  return dayKey(now, timeZone);
}

/** The range a preset stands for (custom keeps what is set). */
export function presetRange(
  preset: DatePreset,
  today: string,
  current: Pick<SearchFilterValues, 'after' | 'before'> = {},
): Pick<SearchFilterValues, 'after' | 'before'> {
  switch (preset) {
    case 'any':
      return { after: undefined, before: undefined };
    case 'today':
      return { after: today, before: undefined };
    case 'week':
      return { after: addDays(today, -6), before: undefined };
    case 'month':
      return { after: addDays(today, -29), before: undefined };
    case 'custom':
      return { after: current.after ?? addDays(today, -6), before: current.before ?? today };
  }
}

/** Which preset the address's dates are (custom when they match none). */
export function presetOf(f: Pick<SearchFilterValues, 'after' | 'before'>, today: string): DatePreset {
  if (!f.after && !f.before) return 'any';
  if (!f.before && f.after === today) return 'today';
  if (!f.before && f.after === addDays(today, -6)) return 'week';
  if (!f.before && f.after === addDays(today, -29)) return 'month';
  return 'custom';
}

export interface FilterOption {
  value: string;
  label: string;
}

/** “From”: you, then the agent (never a system actor, one-agent.md AP-4925). */
export function fromOptions(principals: readonly Principal[]): FilterOption[] {
  const people = principals.filter((p) => p.kind === 'person');
  const agent = principals.filter((p) => p.kind === 'agent');
  return [...people, ...agent].map((p) => ({ value: p.handle, label: p.name }));
}

/** “In” (less-is-more.md AP-1808): the person's chats with the agent, by title. */
export function chatInOptions(
  chats: readonly { id: string; title: string; archivedAt?: string | null }[],
): FilterOption[] {
  return chats.filter((c) => !c.archivedAt).map((c) => ({ value: c.id, label: c.title }));
}
