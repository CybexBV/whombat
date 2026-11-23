/**
 * Website feedback's page in slots, from the reports this Whombat keeps (no call anywhere):
 *
 * - **Live** “New reports”: the newest that nobody looked at yet, with the site and who sent it.
 * - **Inventory** “Reports”: this week's against last week's, still open, fixed in the last 30 days, the sites.
 * - **Trend** reports per day, **People** “Who reports most” in the last 30 days (two or more people).
 *
 * A reporter is named by the name they gave, never by their email. A report counts as fixed when it was set resolved:
 * reports keep no time of that, so the last change to a resolved report stands for it.
 */
import { FEEDBACK_THING_ID, type ThingPageItem, type ThingSummary } from '@whombat/core';
import { reporterSummaryOf } from '@whombat/core/feedback/reporters';
import { and, asc, count, desc, eq, gte, notInArray } from 'drizzle-orm';
import type { ConnectionViewer } from '../../connections/store';
import { feedbackIntegrations, feedbackReports } from '../../db/schema/index';
import type { Services } from '../../services';
import {
  countByDay,
  countLine,
  inventory,
  lastDays,
  liveList,
  people,
  slotPanels,
  trend,
  weekChange,
} from '../kinds/slots';
import { ago } from '../kinds/storage/shared';
import type { KindView } from '../kinds/types';
import { clip, plural, thousands } from '../words';

const DAY = 86_400_000;
/** Rows in New reports. */
const NEW_ROWS = 6;
/** Reports read for the newest and the counts by day and person (the last 30 days at most). */
const REPORTS_MAX = 2000;

/** A report as the page shows it: what it says, where, who sent it (their name only), when. */
export interface FeedbackRow {
  id: string;
  type: 'bug' | 'feature';
  status: 'new' | 'triaged' | 'in_progress' | 'resolved' | 'closed';
  description: string;
  site: string;
  reporterName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FeedbackInput {
  sites: string[];
  /** The newest new reports, newest first. */
  fresh: FeedbackRow[];
  /** How many are new. */
  newCount: number;
  /** How many aren't resolved or closed. */
  openCount: number;
  /** Reports of the last 30 days (for this week, last week, per day, who reports most). */
  recent: FeedbackRow[];
  now: Date;
  timeZone: string;
}

export type FeedbackView = Pick<KindView, 'panels' | 'slots' | 'notices' | 'verdict' | 'readAt' | 'refreshS'>;

/** “2 new reports”, “1 new report”. */
const newWords = (n: number) => plural(n, 'new report');

/** “The export button does nothing”, from the start of what the visitor wrote. */
function titleOf(r: FeedbackRow): string {
  return clip(reporterSummaryOf(r.description), 160) || (r.type === 'bug' ? 'A bug report' : 'An idea');
}

function reportItem(r: FeedbackRow, i: number, now: Date): ThingPageItem {
  const name = r.reporterName?.trim();
  return {
    id: `report-${i}`,
    title: titleOf(r),
    detail: clip([r.site, name].filter(Boolean).join(' · '), 300),
    icon: r.type === 'bug' ? 'warn' : 'info',
    at: r.createdAt.toISOString(),
    right: ago(r.createdAt, now),
  };
}

/** “+2 on last week”, “−1 on last week”, “Same as last week”. */
function onLastWeek(now: number, before: number): string {
  const d = now - before;
  return d === 0 ? 'Same as last week' : d > 0 ? `+${d} on last week` : `−${-d} on last week`;
}

/** Website feedback's Summary in slots and its head's parts. */
export function feedbackView(input: FeedbackInput): FeedbackView {
  const { now, timeZone } = input;
  const age = (r: FeedbackRow) => now.getTime() - r.createdAt.getTime();
  const thisWeek = input.recent.filter((r) => age(r) < 7 * DAY).length;
  const lastWeek = input.recent.filter((r) => age(r) >= 7 * DAY && age(r) < 14 * DAY).length;
  const fixed = input.recent.length
    ? input.recent.filter((r) => r.status === 'resolved' && now.getTime() - r.updatedAt.getTime() < 30 * DAY)
        .length
    : 0;

  const live = liveList({
    id: 'new',
    title: 'New reports',
    meta: `${thousands(input.newCount)} new`,
    items: input.fresh.slice(0, NEW_ROWS).map((r, i) => reportItem(r, i, now)),
    empty: 'No new reports.',
  });

  const counts = inventory({
    id: 'reports',
    title: 'Reports',
    items: [
      countLine({
        id: 'week',
        title: 'This week',
        icon: 'log',
        value: thousands(thisWeek),
        note: onLastWeek(thisWeek, lastWeek),
      }),
      countLine({ id: 'open', title: 'Open', icon: 'warn', value: thousands(input.openCount) }),
      countLine({
        id: 'fixed',
        title: 'Fixed',
        icon: 'update',
        detail: 'Last 30 days',
        value: thousands(fixed),
      }),
      countLine({
        id: 'sites',
        title: 'Sites',
        icon: 'network',
        ...(input.sites.length ? { detail: input.sites.join(', ') } : {}),
        value: thousands(input.sites.length),
      }),
    ],
  });

  const days = lastDays(now, timeZone);
  const values = countByDay(
    input.recent.map((r) => r.createdAt),
    days.keys,
    timeZone,
  );
  const week = values.reduce((a, b) => a + b, 0);
  const perDay =
    week || lastWeek
      ? trend({
          id: 'week',
          title: 'Reports',
          meta: 'Per day',
          days,
          values,
          label: 'Reports',
          figure: { value: thousands(week), rest: 'this week' },
          change: weekChange(week, lastWeek),
        })
      : null;

  const byName = new Map<string, number>();
  for (const r of input.recent) {
    const name = r.reporterName?.trim();
    if (name) byName.set(name, (byName.get(name) ?? 0) + 1);
  }
  const named = [...byName.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  const reporters =
    named.length >= 2
      ? people({
          title: 'Who reports most',
          meta: 'Last 30 days',
          items: named.slice(0, 5),
          unit: ['report'],
        })
      : null;

  const n = input.newCount;
  const verdict =
    n === 0
      ? input.openCount
        ? `No new reports, and ${plural(input.openCount, 'report')} still open.`
        : 'No new reports.'
      : n === 1
        ? '1 new report waits for a look.'
        : `${thousands(n)} new reports wait for a look.`;

  return {
    ...slotPanels({ live, inventory: counts, trend: perDay, people: reporters }),
    notices: [],
    verdict,
    readAt: now,
    refreshS: 60,
  };
}

/** Whether the viewer sees Website feedback here: it's on, the burrow has a site, and the viewer is the person. */
export async function feedbackShown(
  services: Services,
  viewer: Pick<ConnectionViewer, 'burrowId' | 'principal'>,
): Promise<boolean> {
  if (services.config.WHOMBAT_FEEDBACK === 'off' || viewer.principal.kind !== 'person') return false;
  const [row] = await services.db
    .select({ n: count() })
    .from(feedbackIntegrations)
    .where(eq(feedbackIntegrations.burrowId, viewer.burrowId));
  return (row?.n ?? 0) > 0;
}

/** What the page reads from the burrow's reports. */
export async function readFeedback(
  services: Services,
  burrowId: string,
  now: Date,
): Promise<Omit<FeedbackInput, 'now' | 'timeZone'>> {
  const db = services.db;
  const columns = {
    id: feedbackReports.id,
    type: feedbackReports.type,
    status: feedbackReports.status,
    description: feedbackReports.description,
    reporterName: feedbackReports.reporterName,
    integrationId: feedbackReports.integrationId,
    createdAt: feedbackReports.createdAt,
    updatedAt: feedbackReports.updatedAt,
  };
  const mine = eq(feedbackReports.burrowId, burrowId);
  const [integrations, fresh, [news], [open], recent] = await Promise.all([
    db
      .select({ id: feedbackIntegrations.id, settings: feedbackIntegrations.settings })
      .from(feedbackIntegrations)
      .where(eq(feedbackIntegrations.burrowId, burrowId))
      .orderBy(asc(feedbackIntegrations.createdAt)),
    db
      .select(columns)
      .from(feedbackReports)
      .where(and(mine, eq(feedbackReports.status, 'new')))
      .orderBy(desc(feedbackReports.createdAt))
      .limit(NEW_ROWS),
    db
      .select({ n: count() })
      .from(feedbackReports)
      .where(and(mine, eq(feedbackReports.status, 'new'))),
    db
      .select({ n: count() })
      .from(feedbackReports)
      .where(and(mine, notInArray(feedbackReports.status, ['resolved', 'closed']))),
    db
      .select(columns)
      .from(feedbackReports)
      .where(and(mine, gte(feedbackReports.createdAt, new Date(now.getTime() - 30 * DAY))))
      .orderBy(desc(feedbackReports.createdAt))
      .limit(REPORTS_MAX),
  ]);
  const site = new Map(integrations.map((i) => [i.id, clip(i.settings.name, 80)]));
  const row = (r: (typeof fresh)[number]): FeedbackRow => ({
    id: r.id,
    type: r.type,
    status: r.status,
    description: r.description,
    site: site.get(r.integrationId) ?? 'A site',
    reporterName: r.reporterName,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
  return {
    sites: integrations.map((i) => site.get(i.id) ?? ''),
    fresh: fresh.map(row),
    newCount: news?.n ?? 0,
    openCount: open?.n ?? 0,
    recent: recent.map(row),
  };
}

/** Website feedback as a thing on Home and in the sidebar: how many new reports, how many sites. */
export async function feedbackThing(
  services: Services,
  viewer: Pick<ConnectionViewer, 'burrowId' | 'principal'>,
): Promise<ThingSummary | null> {
  if (!(await feedbackShown(services, viewer))) return null;
  const [[sites], [news]] = await Promise.all([
    services.db
      .select({ n: count() })
      .from(feedbackIntegrations)
      .where(eq(feedbackIntegrations.burrowId, viewer.burrowId)),
    services.db
      .select({ n: count() })
      .from(feedbackReports)
      .where(and(eq(feedbackReports.burrowId, viewer.burrowId), eq(feedbackReports.status, 'new'))),
  ]);
  const n = news?.n ?? 0;
  const s = sites?.n ?? 0;
  return {
    id: FEEDBACK_THING_ID,
    kind: 'connection',
    catalogId: 'feedback',
    name: 'Website feedback',
    icon: 'feedback',
    status: 'ok',
    line: `${n ? newWords(n) : 'No new reports'} · ${plural(s, 'site')}`,
    facts: [{ label: 'New', value: thousands(n) }],
    href: `/things/${encodeURIComponent(FEEDBACK_THING_ID)}`,
  };
}
