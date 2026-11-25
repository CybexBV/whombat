/**
 * Following the answers to reports to the Whombat Team (docs/decisions/team-reports.md): while the box has an
 * open report it asks control's list every 10 minutes, which marks what the team changed unread and tells the person
 * when the team asks something or a fix is ready (`team_report_seen`). Without an open report it asks now and then
 * whether the person may send one, so the assistant offers to report only where it can. The first look comes shortly
 * after start (once the box knows its Link state, at a moment of its own so boxes that start together don't ask
 * together), not ten minutes later. Old drafts go.
 */
import { TEAM_REPORT_CLOSED } from '@whombat/core/domain';
import { asc, notInArray } from 'drizzle-orm';
import { burrows, teamReportCopies } from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import type { Services } from '../services';
import { sweepTeamReportDrafts, TEAM_REPORT_DRAFT_KEEP_DAYS } from './commands';
import { teamPortOf } from './control';
import { lastAvailability, listTeamReports, oldDrafts } from './service';

export const TEAM_REPORTS_FOLLOW_MS = 10 * 60_000;
/** The first look after start: this long, plus up to `TEAM_REPORTS_FIRST_JITTER_MS` more. */
export const TEAM_REPORTS_FIRST_MS = 20_000;
export const TEAM_REPORTS_FIRST_JITTER_MS = 40_000;
/** How long what control said about sending holds while the box has no open report. */
export const TEAM_REPORTS_AVAILABILITY_MS = 6 * 60 * 60_000;

const rounds = new WeakMap<Services, () => void>();

/** How long the round waits: shortly after start for the first look, every ten minutes after it. */
export function teamReportsFollowPeriod(ran: boolean, random = Math.random()): number {
  return ran
    ? TEAM_REPORTS_FOLLOW_MS
    : TEAM_REPORTS_FIRST_MS + Math.floor(random * TEAM_REPORTS_FIRST_JITTER_MS);
}

export function startTeamReportsFollow(services: Services): void {
  if (rounds.has(services)) return;
  let ran = false;
  const first = teamReportsFollowPeriod(false);
  rounds.set(
    services,
    services.housekeeping.add(
      'team-reports.follow',
      () => (ran ? teamReportsFollowPeriod(true) : first),
      async () => {
        ran = true;
        await followTeamReports(services);
      },
      { first: 'period' },
    ),
  );
}

/** One round: old drafts go; each burrow with an open report asks control's list. */
export async function followTeamReports(services: Services, now = services.clock()): Promise<void> {
  if (services.maintenance.held || services.maintenance.paused) return;
  const old = await oldDrafts(services, new Date(now.getTime() - TEAM_REPORT_DRAFT_KEEP_DAYS * 86_400_000));
  const byBurrow = new Map<string, string[]>();
  for (const d of old) byBurrow.set(d.burrowId, [...(byBurrow.get(d.burrowId) ?? []), d.id]);
  for (const [burrowId, ids] of byBurrow) {
    const person = await thePerson(services.db, burrowId);
    if (person)
      await services.pipeline.commit(sweepTeamReportDrafts, { ids }, { burrowId, actorId: person.id });
  }

  if (!teamPortOf(services, 'read')) return;
  const open = await services.db
    .selectDistinct({ burrowId: teamReportCopies.burrowId })
    .from(teamReportCopies)
    .where(notInArray(teamReportCopies.status, [...TEAM_REPORT_CLOSED]));
  const due = open.map((o) => o.burrowId);
  const asked = lastAvailability(services);
  if (!due.length && (!asked || now.getTime() - asked.at >= TEAM_REPORTS_AVAILABILITY_MS)) {
    const [first] = await services.db
      .select({ id: burrows.id })
      .from(burrows)
      .orderBy(asc(burrows.createdAt), asc(burrows.id))
      .limit(1);
    if (first) due.push(first.id);
  }
  for (const burrowId of due) {
    const person = await thePerson(services.db, burrowId);
    if (!person) continue;
    try {
      await listTeamReports(services, burrowId, person.id);
    } catch (err) {
      services.log.warn({ err: err instanceof Error ? err.name : 'error' }, 'team reports: not followed');
    }
  }
}
