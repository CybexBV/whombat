/**
 * The Summary of a connection Whombat has no kind for (Notion, a custom API), and of a kind whose read gave nothing,
 * in slots (docs/decisions/service-slots.md): Whombat can't see inside such a service, so it says how the service
 * answers Whombat's checks — “How it answers” (the share answered over the last 7 days, the typical answer time today
 * and its change on last week, and when Whombat last used it) and the typical answer time per day as a Trend. The machine's card is the page's, when
 * Whombat knows what it runs on. Pure.
 */
import type { CatalogConnectionRow } from '../connections/types';
import type { ConnectionGlance } from '../home/types';
import { countLine, dayKey, daysWith, inventory, lastDays, trend, weekChange } from './kinds/slots';
import type { KindView } from './kinds/types';
import { answerOf } from './panels';
import type { RawPoint } from './series';
import { plural, span } from './words';

const DAY = 86_400_000;

/** The middle of some answer times: what is typical, untouched by one slow answer. */
function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const ms = (n: number) => `${Math.round(n)} ms`;

/** “100 %”, and never 100 % while one check went unanswered (“99.7 %”). */
function share(answered: number, all: number): string {
  if (answered === all) return '100 %';
  const p = (answered / all) * 100;
  return p >= 95 ? `${(Math.floor(p * 10) / 10).toFixed(1)} %` : `${Math.round(p)} %`;
}

/**
 * The page's own slots for a connection without a kind: “How it answers” and “Answer time” from the response-time
 * points the health pass keeps (`rtt_ms`, null when a check failed). Each is left out without the readings it needs.
 */
export function genericSlots(
  row: Pick<CatalogConnectionRow, 'status' | 'glance'> & Partial<Pick<CatalogConnectionRow, 'lastUsedAt'>>,
  rtt: readonly RawPoint[],
  now: Date,
  timeZone: string,
): Pick<KindView, 'panels' | 'slots' | 'kpis'> {
  const t = now.getTime();
  const week = rtt.filter((p) => p.at.getTime() > t - 7 * DAY && p.at.getTime() <= t);
  const before = rtt.filter((p) => p.at.getTime() > t - 14 * DAY && p.at.getTime() <= t - 7 * DAY);
  const answers = (ps: readonly RawPoint[]) =>
    ps.filter((p) => p.value !== null && Number.isFinite(p.value)).map((p) => p.value as number);
  const answered = answers(week);
  const missed = week.length - answered.length;
  const today = dayKey(now, timeZone);
  const typicalToday = median(answers(week.filter((p) => dayKey(p.at, timeZone) === today)));
  const typicalWeek = median(answered);
  const typicalBefore = median(answers(before));
  // The last check's outcome says it too, so the line stays true while its notice is ignored.
  const last = answerOf(row.glance as ConnectionGlance | null);
  const lastCheck =
    row.status === 'needs_reauth'
      ? { note: 'Signed out', noteTone: 'bad' as const }
      : last === 'offline'
        ? { note: 'Not answering now', noteTone: 'bad' as const }
        : last === 'error'
          ? { note: 'Answers with errors', noteTone: 'warn' as const }
          : null;

  const items = [];
  if (week.length)
    items.push(
      countLine({
        id: 'answers',
        title: 'Answers',
        icon: 'network',
        detail: `${plural(week.length, 'check')} in 7 days`,
        value: share(answered.length, week.length),
        ...(lastCheck
          ? lastCheck
          : missed
            ? { note: `${missed} didn’t answer`, noteTone: 'warn' as const }
            : { note: 'All answered', noteTone: 'ok' as const }),
      }),
    );
  if (typicalToday !== null) {
    const change = typicalBefore !== null ? weekChange(typicalToday, typicalBefore) : null;
    items.push(
      countLine({
        id: 'answer-time',
        title: 'Answers in',
        icon: 'clock',
        detail: 'Typical today',
        value: ms(typicalToday),
        ...(change ? { note: `${change} on last week` } : {}),
      }),
    );
  }
  // What Whombat itself knows when the service shows nothing more: when it last used it for someone.
  if (row.lastUsedAt !== undefined)
    items.push(
      countLine({
        id: 'last-used',
        title: 'Last used',
        icon: 'plug',
        detail: 'By Whombat',
        value: row.lastUsedAt ? `${span(t - row.lastUsedAt.getTime())} ago` : 'Not yet',
      }),
    );
  const answersPanel = items.length
    ? inventory({ id: 'answers', title: 'With Whombat', meta: 'Its checks and use', items })
    : null;

  const days = lastDays(now, timeZone);
  const perDay = days.keys.map((k) => median(answers(week.filter((p) => dayKey(p.at, timeZone) === k))));
  const change =
    typicalWeek !== null && typicalBefore !== null ? weekChange(typicalWeek, typicalBefore) : null;
  const answerTime =
    typicalWeek !== null && daysWith(perDay) >= 2
      ? trend({
          id: 'week',
          title: 'Answer time',
          meta: 'Typical per day',
          days,
          values: perDay.map((v) => (v === null ? null : Math.round(v))),
          label: 'Answer time',
          unit: 'ms',
          figure: { value: ms(typicalWeek), rest: 'typical this week' },
          change,
          color: 'blue',
        })
      : null;

  return {
    kpis: [],
    panels: [answersPanel, answerTime].filter((p): p is NonNullable<typeof p> => !!p),
    slots: { machine: [] },
  };
}
