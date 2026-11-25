/**
 * The addresses of reports to the Whombat Team (Whombat team-reports.md): `/reports` (`?draft=` goes on to the form),
 * `/reports/new?draft=<id>` (the assistant's draft from its card's Edit) and `/reports/<reportId>?sent=1` (just sent).
 */
import { TeamReportId } from '@whombat/core';

type Raw = Record<string, unknown>;

const DRAFT = /^[A-Za-z0-9_-]{8,64}$/;

export interface TeamReportFormSearch {
  draft?: string;
}

/** `?draft=<id>`, when it is a draft's id. */
export function validateTeamReportFormSearch(raw: Raw): TeamReportFormSearch {
  const draft = typeof raw.draft === 'string' && DRAFT.test(raw.draft) ? raw.draft : undefined;
  return draft ? { draft } : {};
}

export interface TeamReportSearch {
  /** Just sent: the page says so once. */
  sent?: 1;
}

export function validateTeamReportSearch(raw: Raw): TeamReportSearch {
  return raw.sent === 1 || raw.sent === '1' || raw.sent === true ? { sent: 1 } : {};
}

/** Whether a path segment is a report's id (`tr_` and 20 url-safe characters). */
export function isTeamReportId(value: string): boolean {
  return TeamReportId.safeParse(value).success;
}
