/**
 * Reports to the Whombat Team in React (Whombat docs/decisions/team-reports.md): the person's list, one report (opening
 * it reads it), sending a new one, replying, It works / Still happening / Withdraw, and the assistant's draft for the
 * form. Asked only of a Whombat whose session speaks them (minor 11). Each answer is put in the cache where the list
 * and the report's page read it. Each send keeps one request id from the moment its form or box opens, for every try,
 * and takes a new one once it went: the team gets the words once however often the app tries. Works in React DOM and
 * React Native.
 */
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CreateTeamReportBody,
  TeamReport,
  TeamReportAction,
  TeamReportAnswer,
  TeamReportRow,
  TeamReportsList,
} from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { protocolAtLeast, TEAM_REPORTS_MINOR } from '@whombat/protocol/session';
import { useEffect, useRef } from 'react';
import { commitOutcomeText, hostErrorInfo } from '../hosts/errors';
import { ApiError } from '../http/errors';
import type { CommitResult } from '../http/types';
import { endpointKey, endpointScope } from '../query/keys';
import { newRequestId } from '../session/ids';
import { teamReportsShown, teamReportWords } from '../teamReports';
import { useSessionProtocol, useWhombat } from './context';
import { queryHook } from './queries';

const useListQuery = queryHook(api.teamReports.list);
const useReportQuery = queryHook(api.teamReports.get);
const useDraftQuery = queryHook(api.teamReports.draft);

/** The list stays fresh for a minute: every read of it makes the box ask the team's side. */
const LIST_FRESH_MS = 60_000;
/** The entry's own read is quieter still: it only decides whether a menu line shows. */
const ENTRY_FRESH_MS = 5 * 60_000;

const listKey = (burrow: string) => endpointKey(api.teamReports.list, { params: { burrow } });
const reportKey = (burrow: string, reportId: string) =>
  endpointKey(api.teamReports.get, { params: { burrow, reportId } });

/** Whether this Whombat's session speaks reports to the Whombat Team (session minor 10). */
export function useTeamReportsSupported(): boolean {
  return protocolAtLeast(useSessionProtocol(), TEAM_REPORTS_MINOR);
}

/**
 * The person's reports (`teamReports.list`) and whether the entry shows; nothing is asked of a Whombat that doesn't
 * speak them (`supported` false, `shown` false).
 */
export function useTeamReports(burrow: string | null | undefined) {
  const protocol = useSessionProtocol();
  const supported = protocolAtLeast(protocol, TEAM_REPORTS_MINOR);
  const query = useListQuery(supported && burrow ? { params: { burrow } } : null, {
    retry: false,
    staleTime: LIST_FRESH_MS,
  });
  return { supported, shown: teamReportsShown(protocol, query.data), ...query };
}

/**
 * Whether “Report a problem or idea” shows in the account menu and on About: the session speaks reports and the list
 * says the person may send one or has some. Read quietly (once in five minutes, not on focus).
 */
export function useTeamReportsEntry(burrow: string | null | undefined): boolean {
  const protocol = useSessionProtocol();
  const supported = protocolAtLeast(protocol, TEAM_REPORTS_MINOR);
  const query = useListQuery(supported && burrow ? { params: { burrow } } : null, {
    retry: false,
    staleTime: ENTRY_FRESH_MS,
    refetchOnWindowFocus: false,
  });
  return teamReportsShown(protocol, query.data);
}

/** A report's row as its whole answer says, read now. */
function rowOf(report: TeamReport): TeamReportRow {
  const { text: _t, expected: _e, context: _c, messages: _m, ...summary } = report;
  return { ...summary, unread: false };
}

/**
 * One send's request id: the same for every try of the same words (`what`), so a retry after a lost answer sends them
 * once; a new one when the words changed (the edited words must go, not the earlier answer come back) and once it went
 * (`next`).
 */
function useSendId() {
  const id = useRef<{ id: string; what: string } | null>(null);
  return {
    for: (what: string) => {
      if (id.current?.what !== what) id.current = { id: newRequestId(), what };
      return id.current.id;
    },
    next: () => {
      id.current = null;
    },
  };
}

/** A whole report as an answer brings it: on its page and as its row in the list. */
function putAnswer(qc: QueryClient, burrow: string, answer: TeamReportAnswer) {
  qc.setQueryData(reportKey(burrow, answer.report.id), answer);
  putRow(qc, burrow, answer.report);
}

/** The list with this report's row as the answer says (read now), added at the top when it is new. */
function putRow(qc: QueryClient, burrow: string, report: TeamReport) {
  qc.setQueryData<TeamReportsList>(listKey(burrow), (list) => {
    if (!list) return list;
    const row = rowOf(report);
    const at = list.reports.findIndex((r) => r.id === report.id);
    const reports = at < 0 ? [row, ...list.reports] : list.reports.map((r, i) => (i === at ? row : r));
    return { ...list, reports };
  });
}

/**
 * A report taken back: gone from the list at once. Its page's answer is only marked old (not removed while the page is
 * still open, which would ask for it again): the next visit asks and hears it is gone.
 */
function dropReport(qc: QueryClient, burrow: string, reportId: string) {
  qc.setQueryData<TeamReportsList>(listKey(burrow), (list) =>
    list ? { ...list, reports: list.reports.filter((r) => r.id !== reportId) } : list,
  );
  void qc.invalidateQueries({ queryKey: reportKey(burrow, reportId), exact: true, refetchType: 'none' });
}

/** What a refusal or failure says in the person's words. */
export function teamReportErrorText(error: unknown, locale?: string | null): string {
  const words = teamReportWords(locale);
  if (error instanceof ApiError && error.status === 404) return words.notFound;
  const message = hostErrorInfo(error, locale).message;
  // The hosts' bare “That didn’t work.” says less than this page's own sentence.
  const bare = hostErrorInfo(null, locale).message;
  return message && message !== bare ? message : words.failed;
}

/** Whether a report's read failed because it isn't there (withdrawn, or gone 90 days after closing). */
export function teamReportMissing(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.code === 'not_found');
}

/**
 * One report with its conversation (`teamReports.get`): a long one with its newest messages, `earlier` counting those
 * left out. Opening it reads it: the box marks it read, so the list's row loses its dot and the Inbox is read again.
 */
export function useTeamReport(burrow: string, reportId: string | null | undefined) {
  const supported = useTeamReportsSupported();
  const qc = useQueryClient();
  const query = useReportQuery(supported && reportId ? { params: { burrow, reportId } } : null, {
    retry: false,
    staleTime: 0,
  });
  const report = query.data?.report;
  const read = query.dataUpdatedAt;
  useEffect(() => {
    if (!report || !read) return;
    putRow(qc, burrow, report);
    void qc.invalidateQueries({ queryKey: endpointScope('home.overview', { burrow }) });
  }, [qc, burrow, report, read]);
  return { supported, ...query, report, earlier: query.data?.earlier ?? 0 };
}

/** The assistant's draft for the form (`teamReports.draft`, its card's Edit); null id: none. */
export function useTeamReportDraft(burrow: string, draftId: string | null | undefined) {
  const supported = useTeamReportsSupported();
  return useDraftQuery(supported && draftId ? { params: { burrow, draftId } } : null, {
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
}

/** The data of an answer, or an error in the person's words. */
function okOrThrow<T>(result: CommitResult<T>): T {
  if (result.status === 'ok') return result.data;
  throw new Error(commitOutcomeText(result) ?? teamReportWords().failed);
}

/**
 * Send a new report (`teamReports.create`); the answer is the report, its page ready to open. The form's request id
 * goes with every try of the same words, a new one once they changed (one with `draftId` goes with the draft's own,
 * which the Whombat uses).
 */
export function useCreateTeamReport(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const sendId = useSendId();
  return useMutation<TeamReport, Error, Omit<CreateTeamReportBody, 'requestId'>>({
    mutationFn: async (body) => {
      const result = await client.request(api.teamReports.create, {
        params: { burrow },
        body: {
          ...body,
          requestId: sendId.for(
            JSON.stringify([body.kind, body.text, body.expected ?? '', body.draftId ?? '']),
          ),
        },
      });
      const answer = okOrThrow(result);
      sendId.next();
      putAnswer(qc, burrow, answer);
      return answer.report;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: listKey(burrow) }),
  });
}

/** Write to the Whombat Team in a report (`teamReports.reply`); one request id for every try of the same words. */
export function useReplyTeamReport(burrow: string, reportId: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const sendId = useSendId();
  return useMutation<TeamReport, Error, string>({
    mutationFn: async (text) => {
      const result = await client.request(api.teamReports.reply, {
        params: { burrow, reportId },
        body: { text, requestId: sendId.for(text) },
      });
      const answer = okOrThrow(result);
      sendId.next();
      putAnswer(qc, burrow, answer);
      return answer.report;
    },
  });
}

/**
 * It works, Still happening or Withdraw (`teamReports.act`). A withdrawn report is gone from the list and its page
 * (the answer is null). Pressing the same button again after a failure goes with the same request id, so it counts
 * once; another button gets its own.
 */
export function useActTeamReport(burrow: string, reportId: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const sendId = useSendId();
  return useMutation<TeamReport | null, Error, TeamReportAction>({
    mutationFn: async (action) => {
      const result = await client.request(api.teamReports.act, {
        params: { burrow, reportId },
        body: { action, requestId: sendId.for(action) },
      });
      const answer = okOrThrow(result);
      sendId.next();
      if (action === 'withdraw' || !answer.report) {
        dropReport(qc, burrow, reportId);
        return null;
      }
      putAnswer(qc, burrow, { report: answer.report, earlier: answer.earlier });
      return answer.report;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: listKey(burrow) }),
  });
}
