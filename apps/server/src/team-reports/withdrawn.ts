/**
 * The reports the person took back in the last few minutes, per runtime (docs/decisions/team-reports.md): a read of
 * control that left before a withdrawal and answers after it still carries the report, and its copy must not come back.
 * The commands that keep copies skip these (`commands.ts`), inside their commit, so a read that answers late writes
 * nothing for them. Memory only: after a restart no read from before is still on its way.
 */
import type { Services } from '../services';

/** How long a withdrawal holds off late answers: far longer than a call to control may take. */
export const TEAM_REPORT_WITHDRAWN_HOLD_MS = 5 * 60_000;

const lately = new WeakMap<Services, Map<string, number>>();

const keyOf = (burrowId: string, reportId: string) => `${burrowId}:${reportId}`;

/** The person took this report back: late answers about it keep nothing for a while. */
export function noteTeamReportWithdrawn(services: Services, burrowId: string, reportId: string): void {
  const now = services.clock().getTime();
  const held = lately.get(services) ?? new Map<string, number>();
  for (const [key, at] of held) if (now - at > TEAM_REPORT_WITHDRAWN_HOLD_MS) held.delete(key);
  held.set(keyOf(burrowId, reportId), now);
  lately.set(services, held);
}

/** Whether the person took this report back a short while ago. */
export function teamReportWithdrawnLately(services: Services, burrowId: string, reportId: string): boolean {
  const at = lately.get(services)?.get(keyOf(burrowId, reportId));
  return at !== undefined && services.clock().getTime() - at <= TEAM_REPORT_WITHDRAWN_HOLD_MS;
}
