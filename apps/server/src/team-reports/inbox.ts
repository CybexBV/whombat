/**
 * The Inbox's items about reports to the Whombat Team (docs/decisions/team-reports.md): one per report that waits
 * for the person, a question from the team or a fix to try, in fixed words (never the team's), opening the report's page.
 * It goes once the report moves on (the person answered, said whether the fix works, or the team closed it). Shown only
 * while the box can reach the team, so the person can do what it asks.
 */
import type { NeedsYouItem } from '@whombat/core';
import type { TeamReportStatus } from '@whombat/core/domain';
import { and, eq, inArray } from 'drizzle-orm';
import { teamReportCopies } from '../db/schema/index';
import { registerNeedsYouSource, type SourceCtx } from '../home/registry';
import { iso } from '../lib/time';
import { loadPrincipalRow } from '../read/principals';
import { TEAM_REPORT_NOTICE_WORDS, teamReportHref } from './commands';
import { teamPortOf } from './control';

const WAITING: TeamReportStatus[] = ['needs_information', 'available'];

/** The item for one report that waits for the person (pure). */
export function teamReportItem(row: {
  reportId: string;
  number: number;
  status: 'needs_information' | 'available';
  updatedAt: Date;
}): NeedsYouItem {
  const words = TEAM_REPORT_NOTICE_WORDS[row.status];
  const href = teamReportHref(row.reportId);
  return {
    id: `team-report:${row.reportId}:${row.status}`,
    ref: { kind: 'team_report', id: row.reportId },
    kind: 'alert',
    severity: 'info',
    nature: 'you',
    title: words.title,
    body: words.body(row.number),
    at: iso(row.updatedAt),
    actions: [{ id: 'open', label: TEAM_REPORT_NOTICE_WORDS.open, style: 'primary', kind: 'open', href }],
    href,
  };
}

/** Registers the source (idempotent; the managed runtime does at its start). */
export function registerTeamReportsSource(): void {
  registerNeedsYouSource('team-reports', async (ctx: SourceCtx): Promise<NeedsYouItem[]> => {
    if (ctx.services && !teamPortOf(ctx.services)) return [];
    const person = ctx.reads?.person ?? (await loadPrincipalRow(ctx.db, ctx.personId));
    if (person?.kind !== 'person') return [];
    const rows = await ctx.db
      .select({
        reportId: teamReportCopies.reportId,
        number: teamReportCopies.number,
        status: teamReportCopies.status,
        updatedAt: teamReportCopies.updatedAt,
      })
      .from(teamReportCopies)
      .where(and(eq(teamReportCopies.burrowId, ctx.burrowId), inArray(teamReportCopies.status, WAITING)));
    return rows.map((r) => teamReportItem({ ...r, status: r.status as 'needs_information' | 'available' }));
  });
}
