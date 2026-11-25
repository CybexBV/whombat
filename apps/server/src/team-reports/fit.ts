/**
 * A whole report in one answer (docs/decisions/team-reports.md): an answer travels in one session CONTROL message of at
 * most 64 KiB, but a report may hold 200 messages of 6 000 characters. The answer keeps the report's own words and the
 * newest messages that fit a budget well inside that message, and says how many of the oldest it left out
 * (`earlier`); the box's copy keeps the whole report.
 */

import type { TeamReport } from '@whombat/core/domain';
import { SESSION_MAX_CONTROL_BYTES } from '@whombat/protocol';

/** The most bytes of UTF-8 JSON an answer with a whole report takes: three quarters of a CONTROL message. */
export const TEAM_REPORT_ANSWER_MAX_BYTES = Math.floor((SESSION_MAX_CONTROL_BYTES * 3) / 4);

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * The report as one answer carries it: everything but the oldest messages beyond `maxBytes` (counted as the UTF-8 JSON
 * of `{report, earlier}`), and how many of them it left out.
 */
export function fitTeamReport(
  report: TeamReport,
  maxBytes = TEAM_REPORT_ANSWER_MAX_BYTES,
): { report: TeamReport; earlier: number } {
  const all = report.messages;
  // The answer without any message, with the largest `earlier` it could say.
  let used = bytes({ report: { ...report, messages: [] }, earlier: all.length });
  let kept = 0;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    // Each message adds its JSON and a comma.
    const next = bytes(all[i]) + (kept > 0 ? 1 : 0);
    if (used + next > maxBytes) break;
    used += next;
    kept += 1;
  }
  if (kept === all.length) return { report, earlier: 0 };
  return { report: { ...report, messages: all.slice(all.length - kept) }, earlier: all.length - kept };
}
