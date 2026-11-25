/**
 * A whole report in one answer (docs/decisions/team-reports.md): an answer travels in one session CONTROL message of at
 * most 64 KiB, but a report may hold 200 messages of 6 000 characters. The answer keeps the report's own words and the
 * newest messages that fit a budget well inside that message, and says how many of the oldest it left out
 * (`earlier`); when not even the newest fits whole, its words are cut to fit, so the latest answer always shows. The
 * box's copy keeps the whole report. The list fits the same budget: 100 rows of long titles in three-byte letters would
 * not, so long titles are cut shorter first.
 */

import type { TeamReportsList } from '@whombat/core';
import { TEAM_REPORT_CLOSED, type TeamReport, type TeamReportMessage } from '@whombat/core/domain';
import { SESSION_MAX_CONTROL_BYTES } from '@whombat/protocol';

/** The most bytes of UTF-8 JSON an answer with a whole report takes: three quarters of a CONTROL message. */
export const TEAM_REPORT_ANSWER_MAX_BYTES = Math.floor((SESSION_MAX_CONTROL_BYTES * 3) / 4);

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * The report as one answer carries it: everything but the oldest messages beyond `maxBytes` (counted as the UTF-8 JSON
 * of `{report, earlier}`), and how many of them it left out. When not even the newest message fits, it comes with its
 * words cut to fit (whole characters, an ellipsis where it was cut).
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
  const newest = all[all.length - 1];
  if (kept === 0 && newest) {
    const room = maxBytes - bytes({ report: { ...report, messages: [] }, earlier: all.length - 1 });
    const cut = cutMessage(newest, room);
    if (cut) return { report: { ...report, messages: [cut] }, earlier: all.length - 1 };
  }
  return { report: { ...report, messages: all.slice(all.length - kept) }, earlier: all.length - kept };
}

/** The message with as much of its text as fits `room` bytes of JSON, an ellipsis where it was cut; null if none does. */
function cutMessage(message: TeamReportMessage, room: number): TeamReportMessage | null {
  if (bytes(message) <= room) return message;
  const chars = Array.from(message.text);
  const withFirst = (n: number) => ({
    ...message,
    text: `${chars.slice(0, n).join('').trimEnd()}…`,
  });
  // The most characters that fit, found by halving: the JSON grows with every character kept.
  let lo = 0;
  let hi = chars.length - 1;
  if (bytes(withFirst(0)) > room) return null;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytes(withFirst(mid)) <= room) lo = mid;
    else hi = mid - 1;
  }
  return withFirst(lo);
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
