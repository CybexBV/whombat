/**
 * A report tracker's page: what Whombat itself keeps of it, so nothing is asked of the tracker. The fixes on their way
 * to the customers (a pull request open, merged, live on development), how many reports are open with how many came
 * this week, the reports per day, and the organizations that report most. Its machine card says which installation
 * the poller reads and when it last did. A tracker no automation listens to isn't read, so its page says so instead of
 * showing noughts.
 */
import type { ThingPageBar, ThingPageItem } from '@whombat/core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { CatalogConnectionRow } from '../../../connections/types';
import { trackerFixes, trackerItems } from '../../../db/schema/index';
import type { Services } from '../../../services';
import { pollerViews } from '../../../trackers/views';
import { clip, plural, span } from '../../words';
import { cachedRead } from '../read';
import type { KindModule, KindSeen } from '../registry';
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
} from '../slots';
import type { KindView } from '../types';

const DAY = 86_400_000;
/** Everything here is Whombat's own records: kept a minute. */
const KEEP_MS = 60_000;
/** The tracker's words for a report that needs nothing more. */
const CLOSED = new Set(['closed', 'duplicate', 'not_planned', 'confirmed']);
/** A fix on its way: not yet with every customer, not given up. */
const ON_ITS_WAY = ['open', 'merged', 'development'] as const;
const STAGE: Record<(typeof ON_ITS_WAY)[number], string> = {
  open: 'Pull request open',
  merged: 'Merged, not out yet',
  development: 'On development',
};

export interface TrackerReport {
  number: number;
  kind: string;
  title: string;
  organization: string | null;
  status: string;
  reportedAt: Date;
}

export interface TrackerFix {
  number: number;
  title: string | null;
  state: (typeof ON_ITS_WAY)[number];
  prUrl: string | null;
  since: Date;
}

export interface TrackerSnapshot {
  /** An automation listens to it, so its poller reads it. */
  listened: boolean;
  /** Reports of the last 30 days, and every open one. */
  reports: TrackerReport[];
  fixes: TrackerFix[];
  /** Fixes that reached the customers' installation in the last 30 days. */
  fixedMonth: number;
  poller: {
    checkedAt: Date | null;
    version: string | null;
    environment: string | null;
    problem: string | null;
  };
}

/** What Whombat keeps of the tracker. */
export async function trackerLoad(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
): Promise<TrackerSnapshot> {
  const month = new Date(now.getTime() - 30 * DAY);
  const [items, fixes, polled] = await Promise.all([
    services.db
      .select({
        number: trackerItems.number,
        kind: trackerItems.kind,
        title: trackerItems.title,
        organization: trackerItems.organization,
        status: trackerItems.status,
        seenStatus: trackerItems.seenStatus,
        reportedAt: trackerItems.reportedAt,
        mirroredAt: trackerItems.mirroredAt,
      })
      .from(trackerItems)
      .where(eq(trackerItems.connectionId, row.id))
      .orderBy(desc(trackerItems.number))
      .limit(500),
    services.db
      .select({
        number: trackerFixes.number,
        reportId: trackerFixes.reportId,
        state: trackerFixes.state,
        prUrl: trackerFixes.prUrl,
        mergedAt: trackerFixes.mergedAt,
        developmentAt: trackerFixes.developmentAt,
        productionAt: trackerFixes.productionAt,
      })
      .from(trackerFixes)
      .where(
        and(
          eq(trackerFixes.connectionId, row.id),
          inArray(trackerFixes.state, [...ON_ITS_WAY, 'live', 'confirmed']),
        ),
      )
      .orderBy(desc(trackerFixes.number))
      .limit(200),
    pollerViews(services.db, [row.id]),
  ]);
  const titles = new Map(items.map((i) => [i.number, i.title]));
  const reports = items
    .map((i) => ({
      number: i.number,
      kind: i.kind,
      title: i.title,
      organization: i.organization,
      status: i.seenStatus ?? i.status,
      reportedAt: i.reportedAt ?? i.mirroredAt,
    }))
    .filter((r) => r.reportedAt >= month || !CLOSED.has(r.status));
  const poller = polled.get(row.id);
  return {
    listened: polled.has(row.id) || items.length > 0,
    reports,
    fixes: fixes
      .filter((f): f is typeof f & { state: TrackerFix['state'] } =>
        (ON_ITS_WAY as readonly string[]).includes(f.state),
      )
      .map((f) => ({
        number: f.number,
        title: titles.get(f.number) ?? null,
        state: f.state,
        prUrl: f.prUrl,
        since: f.developmentAt ?? f.mergedAt ?? now,
      })),
    fixedMonth: fixes.filter((f) => f.productionAt && f.productionAt >= month).length,
    poller: {
      checkedAt: poller?.checkedAt ? new Date(poller.checkedAt) : null,
      version: poller?.version ?? null,
      environment: poller?.environment ?? null,
      problem: poller?.problem ?? null,
    },
  };
}

/** The page from what Whombat keeps (pure). */
export function trackerView(s: TrackerSnapshot, now: Date, timeZone: string): KindView {
  const t = now.getTime();
  const open = s.reports.filter((r) => !CLOSED.has(r.status));
  const week = s.reports.filter((r) => r.reportedAt.getTime() > t - 7 * DAY);
  const weekBefore = s.reports.filter(
    (r) => r.reportedAt.getTime() > t - 14 * DAY && r.reportedAt.getTime() <= t - 7 * DAY,
  );

  const fixRows: ThingPageItem[] = s.fixes.slice(0, 8).map((f) => ({
    id: `fix-${f.number}`,
    title: clip(f.title ? `#${f.number} ${f.title}` : `Report #${f.number}`, 160),
    detail: STAGE[f.state],
    icon: f.state === 'open' ? 'clock' : 'update',
    right: `${span(t - f.since.getTime())} ago`.slice(0, 40),
    ...(f.prUrl ? { url: f.prUrl } : {}),
  }));
  const live = fixRows.length
    ? liveList({
        id: 'fixes',
        title: 'Fixes on their way',
        meta: plural(s.fixes.length, 'fix', 'fixes'),
        items: fixRows,
      })
    : undefined;

  const items = [
    countLine({
      id: 'open',
      title: 'Open reports',
      icon: 'warn',
      value: String(open.length),
      note: week.length ? `+${week.length} this week` : 'None new this week',
    }),
    countLine({
      id: 'bugs',
      title: 'Bugs',
      icon: 'log',
      detail: 'Open',
      value: String(open.filter((r) => r.kind === 'bug').length),
    }),
    countLine({
      id: 'features',
      title: 'Feature requests',
      icon: 'info',
      detail: 'Open',
      value: String(open.filter((r) => r.kind === 'feature').length),
    }),
    countLine({
      id: 'fixed',
      title: 'Fixed',
      icon: 'update',
      detail: 'Out to customers, last 30 days',
      value: String(s.fixedMonth),
    }),
  ];
  const counts = inventory({ id: 'reports', title: 'Reports', items });

  const days = lastDays(now, timeZone);
  const perDay = countByDay(
    week.map((r) => r.reportedAt),
    days.keys,
    timeZone,
  );
  const perDayTrend = trend({
    id: 'week',
    title: 'Reports',
    meta: 'Per day',
    days,
    values: perDay,
    label: 'Reports',
    figure: { value: String(week.length), rest: 'this week' },
    change: weekChange(week.length, weekBefore.length),
    color: 'blue',
  });

  const byOrg = new Map<string, number>();
  for (const r of s.reports.filter((x) => x.reportedAt.getTime() > t - 30 * DAY && x.organization))
    byOrg.set(r.organization as string, (byOrg.get(r.organization as string) ?? 0) + 1);
  const orgs = [...byOrg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const who =
    orgs.length >= 2
      ? (people({
          title: 'Who reports most',
          meta: 'Last 30 days',
          items: orgs.map(([name, n]) => ({ name, n })),
          unit: ['report'],
        }) ?? undefined)
      : undefined;

  const machine: ThingPageBar[] = [
    ...(s.poller.version
      ? [
          {
            id: 'version',
            label: 'Reads',
            value: clip(
              [
                s.poller.environment === 'development'
                  ? 'Development'
                  : s.poller.environment
                    ? 'Production'
                    : null,
                s.poller.version,
              ]
                .filter(Boolean)
                .join(' · '),
              40,
            ),
          },
        ]
      : []),
    ...(s.poller.checkedAt
      ? [{ id: 'checked', label: 'Checked', value: `${span(t - s.poller.checkedAt.getTime())} ago` }]
      : []),
  ];

  return {
    ...(s.listened
      ? slotPanels({ live, inventory: counts, trend: perDayTrend, people: who, machine })
      : slotPanels({ machine })),
    kpis: [],
    notices: [],
    tabs: [],
    facts: [],
    actions: [],
    readAt: now,
    suggestions: ['Reports per week', 'Open bugs'],
    verdict: s.listened
      ? open.length
        ? `${plural(open.length, 'report')} open, ${plural(week.length, 'new one', 'new ones')} this week.`
        : 'No reports are open.'
      : 'Whombat reads its reports once an automation listens to it.',
  };
}

const keyOf = (row: CatalogConnectionRow) => `tracker:${row.id}`;

function snapshot(services: Services, row: CatalogConnectionRow, now: Date) {
  return cachedRead(services, keyOf(row), row, () => trackerLoad(services, row, now), KEEP_MS);
}

/** The card: how many are open and new this week. */
export function trackerSeen(s: TrackerSnapshot, now: Date): KindSeen {
  if (!s.listened)
    return { glance: { facts: [], line: 'Not read: no automation listens' }, points: {}, notices: [] };
  const open = s.reports.filter((r) => !CLOSED.has(r.status)).length;
  const week = s.reports.filter((r) => r.reportedAt.getTime() > now.getTime() - 7 * DAY).length;
  return {
    glance: {
      facts: [
        { label: 'Open', value: String(open) },
        { label: 'This week', value: String(week) },
      ],
      line: `${plural(open, 'report')} open · ${week} new this week`,
    },
    points: {},
    notices: [],
  };
}

export const TRACKER_KIND: KindModule = {
  page: async ({ services, row, now, timeZone }) =>
    trackerView(await snapshot(services, row, now), now, timeZone),
  seen: async (services, row, now) => trackerSeen(await snapshot(services, row, now), now),
  checks: [],
};
