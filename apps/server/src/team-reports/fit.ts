/**
 * A whole report in one answer (docs/decisions/team-reports.md): an answer travels in one session CONTROL message of at
 * most 64 KiB, but a report may hold 200 messages of 6 000 characters. The answer keeps the report's own words and the
 * newest messages that fit a budget well inside that message, and says how many of the oldest it left out
 * (`earlier`); the box's copy keeps the whole report. The list fits the same budget: 100 rows of long titles in
 * three-byte letters would not, so long titles are cut shorter first.
 */

import type { TeamReportsList } from '@whombat/core';
import { TEAM_REPORT_CLOSED, type TeamReport } from '@whombat/core/domain';
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

/** The lengths titles are cut to, one after the other, until the list fits. */
const TITLE_STEPS = [120, 80, 48] as const;

/** At most `max` characters of a title (whole characters), with an ellipsis where it was cut. */
function cutTitle(title: string, max: number): string {
  const chars = Array.from(title);
  if (chars.length <= max) return title;
  return `${chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}

/**
 * The list as one answer carries it, within `maxBytes` of UTF-8 JSON: long titles cut shorter first (each report's page
 * has its whole title), and only when that isn't enough, the oldest closed reports and then the oldest of the rest left
 * out of this answer.
 */
export function fitTeamReportsList(
  list: TeamReportsList,
  maxBytes = TEAM_REPORT_ANSWER_MAX_BYTES,
): TeamReportsList {
  if (bytes(list) <= maxBytes) return list;
  let reports = list.reports;
  for (const max of TITLE_STEPS) {
    reports = reports.map((r) => ({ ...r, title: cutTitle(r.title, max) }));
    if (bytes({ ...list, reports }) <= maxBytes) return { ...list, reports };
  }
  const rows = [...reports];
  const leaveOut = (which: (r: TeamReportsList['reports'][number]) => boolean) => {
    // Newest first: the oldest are at the end.
    for (let i = rows.length - 1; i >= 0 && bytes({ ...list, reports: rows }) > maxBytes; i -= 1) {
      const row = rows[i];
      if (row && which(row)) rows.splice(i, 1);
    }
  };
  leaveOut((r) => TEAM_REPORT_CLOSED.has(r.status));
  leaveOut(() => true);
  return { ...list, reports: rows };
}
