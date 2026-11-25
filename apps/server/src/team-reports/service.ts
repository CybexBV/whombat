/**
 * Reports to the Whombat Team on the box (docs/decisions/team-reports.md): each call goes to control through the
 * manager, outside any transaction, and what control answered is kept through the commit pipeline (`commands.ts`).
 * The box keeps a copy of each report as the person last read it: the list shows the copies while control
 * can't be reached, and a report is unread while control's revision is past the one the person read. A new report
 * carries the box's version and update channel besides what the app said about itself.
 */
import { randomBytes } from 'node:crypto';
import { TEAM_PAYLOAD_REQUEST_MAX_BYTES } from '@whombat/control-contracts/device';
import type {
  CreateTeamReportBody,
  TeamReportAction,
  TeamReportDraftView,
  TeamReportRow,
  TeamReportsList,
  TeamReportsReason,
} from '@whombat/core';
import {
  TEAM_REPORTS_LIST_MAX,
  TeamReport,
  type TeamReportContext,
  TeamReportDraft,
  TeamReportList,
  type TeamReportStatus,
} from '@whombat/core/domain';
import { and, desc, eq, lt } from 'drizzle-orm';
import { answerAfterApproval, grantedResult } from '../approvals/result';
import { approvalThread } from '../approvals/wake';
import { externalEffect } from '../commit/scope';
import { approvals, teamReportCopies, teamReportDrafts } from '../db/schema/index';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors';
import type { Services } from '../services';
import { doneTeamReportDraft, forgetTeamReport, keepTeamReport, loadDraft, seeTeamReports } from './commands';
import {
  boxContext,
  controlFailure,
  controlUnreachable,
  refusalCode,
  TEAM_REPORT_WORDS,
  type TeamPort,
  teamPortOf,
} from './control';
import { decodeTeamPayload, encodeTeamPayload } from './payload';

type CopyRow = typeof teamReportCopies.$inferSelect;

/** What the box last heard from control about whether the person may send, per runtime. */
const heard = new WeakMap<Services, { available: boolean; at: number }>();

/** Whether the person could send a report when control was last asked; null when it wasn't asked yet. */
export function lastAvailability(services: Services): { available: boolean; at: number } | null {
  return heard.get(services) ?? null;
}

/** A report is unread while control's revision is past the one the person read. */
export function teamReportUnread(revision: number, readRevision: number | null | undefined): boolean {
  return revision > (readRevision ?? 0);
}

/** The box's copies of a burrow's reports, newest first. */
export async function teamReportCopiesOf(services: Services, burrowId: string): Promise<CopyRow[]> {
  return services.db
    .select()
    .from(teamReportCopies)
    .where(eq(teamReportCopies.burrowId, burrowId))
    .orderBy(desc(teamReportCopies.createdAt), desc(teamReportCopies.number));
}

/** A copy as a row of the list. */
function rowOfCopy(c: CopyRow): TeamReportRow {
  return {
    id: c.reportId,
    number: c.number,
    kind: c.kind as TeamReportRow['kind'],
    title: c.title,
    status: c.status as TeamReportStatus,
    createdAt: Math.floor(c.createdAt.getTime() / 1000),
    updatedAt: Math.floor(c.updatedAt.getTime() / 1000),
    revision: c.revision,
    unread: teamReportUnread(c.revision, c.readRevision),
  };
}

/** The copies, as the list shows them when control isn't asked or can't be reached. */
async function keptList(
  services: Services,
  burrowId: string,
  reason: TeamReportsReason,
): Promise<TeamReportsList> {
  const copies = await teamReportCopiesOf(services, burrowId);
  return { available: false, reason, reports: copies.map(rowOfCopy), stale: copies.length > 0 };
}

/** One call to control, recorded as an effect outside the database; every team op is safe to repeat. */
function atControl<T>(label: string, call: () => Promise<T>): Promise<T> {
  return externalEffect(`team_reports.${label}`, call, { idempotent: true });
}

/** A new request id: control does a request it has done already only once. */
function newRequestId(): string {
  return randomBytes(16).toString('base64url');
}

/** The way to control, or the person's words for why there is none now. */
function portOrRefuse(services: Services): TeamPort {
  const port = teamPortOf(services);
  if (!port) throw new ApiError('unavailable', TEAM_REPORT_WORDS.linkOff);
  return port;
}

/**
 * The person's reports, newest first, with what is new to them, and whether they can send one now. Also
 * what keeps the box's copies in step and tells the person when the team needs them.
 */
export async function listTeamReports(
  services: Services,
  burrowId: string,
  actorId: string,
): Promise<TeamReportsList> {
  const port = teamPortOf(services);
  if (!port) return keptList(services, burrowId, 'link_off');
  let answer: Awaited<ReturnType<TeamPort['teamReportsList']>>;
  try {
    answer = await atControl('list', () => port.teamReportsList());
  } catch (err) {
    services.log.debug({ status: (err as { status?: number }).status }, 'team reports: the list wasn’t read');
    if (controlUnreachable(err)) return keptList(services, burrowId, 'unreachable');
    const failure = controlFailure(err);
    return keptList(services, burrowId, failure.code === 'unavailable' ? 'link_off' : 'unreachable');
  }
  const { reports } = decodeTeamPayload(TeamReportList, answer.reports);
  heard.set(services, { available: answer.available, at: services.clock().getTime() });
  const before = new Map((await teamReportCopiesOf(services, burrowId)).map((c) => [c.reportId, c]));
  await services.pipeline.commit(
    seeTeamReports,
    { reports, complete: reports.length < TEAM_REPORTS_LIST_MAX },
    { burrowId, actorId },
  );
  return {
    available: answer.available,
    reason: answer.reason,
    reports: reports.map((s) => ({
      ...s,
      unread: teamReportUnread(s.revision, before.get(s.id)?.readRevision),
    })),
    stale: false,
  };
}

/** The copy the box kept of one report, when it has the whole report. */
async function keptReport(
  services: Services,
  burrowId: string,
  reportId: string,
): Promise<TeamReport | null> {
  const [copy] = await services.db
    .select({ report: teamReportCopies.report })
    .from(teamReportCopies)
    .where(and(eq(teamReportCopies.burrowId, burrowId), eq(teamReportCopies.reportId, reportId)));
  const parsed = TeamReport.safeParse(copy?.report);
  return parsed.success ? parsed.data : null;
}

/** Keeps what control answered about a report; the person has read it now. */
async function keep(
  services: Services,
  burrowId: string,
  actorId: string,
  payload: string,
  sent = false,
): Promise<TeamReport> {
  const report = decodeTeamPayload(TeamReport, payload);
  await services.pipeline.commit(keepTeamReport, { report, read: true, sent }, { burrowId, actorId });
  return report;
}

/** A report control doesn't know (any more): its copy goes, and the person is told it isn't there. */
async function gone(services: Services, burrowId: string, actorId: string, reportId: string): Promise<never> {
  await services.pipeline.commit(forgetTeamReport, { reportId, withdrawn: false }, { burrowId, actorId });
  throw notFound('Report');
}

/** One report with its whole conversation; the person has read it now. The kept copy while control can't be reached. */
export async function getTeamReport(
  services: Services,
  burrowId: string,
  actorId: string,
  reportId: string,
): Promise<TeamReport> {
  const port = teamPortOf(services);
  if (!port) {
    const kept = await keptReport(services, burrowId, reportId);
    if (kept) return kept;
    throw new ApiError('unavailable', TEAM_REPORT_WORDS.linkOff);
  }
  try {
    const answer = await atControl('get', () => port.teamReportsGet({ reportId }));
    return await keep(services, burrowId, actorId, answer.report);
  } catch (err) {
    if (refusalCode(err) === 'report_unknown') return gone(services, burrowId, actorId, reportId);
    if (controlUnreachable(err)) {
      const kept = await keptReport(services, burrowId, reportId);
      if (kept) return kept;
    }
    throw controlFailure(err);
  }
}

/** Control characters other than tabs and line breaks: the contract refuses them, so they are left out. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: they are what it removes
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (s: string) => s.replace(CONTROL_CHARACTERS, '').trim();

/** The report as control takes it: the person's words, and where they were written. */
export async function teamReportDraftFor(
  services: Services,
  body: Pick<CreateTeamReportBody, 'kind' | 'text' | 'expected' | 'context'>,
): Promise<TeamReportDraft> {
  const app = body.context ?? {};
  const device = app.device ? clean(app.device) : '';
  const context: TeamReportContext = {
    ...(app.client ? { client: app.client } : {}),
    ...(app.appVersion ? { appVersion: app.appVersion } : {}),
    ...(device ? { device } : {}),
    ...(app.language ? { language: app.language } : {}),
    ...(await boxContext(services)),
  };
  const draft = TeamReportDraft.safeParse({
    kind: body.kind,
    text: clean(body.text),
    expected: clean(body.expected ?? ''),
    context,
  });
  if (!draft.success) throw badRequest('Write what happened in a few words.');
  return draft.data;
}

/**
 * Sends the person's report to the team and keeps its copy (read: they wrote it). A draft of the assistant's it came
 * from is done. `requestId`: the same one again answers the same report.
 */
export async function createTeamReport(
  services: Services,
  burrowId: string,
  actorId: string,
  body: Pick<CreateTeamReportBody, 'kind' | 'text' | 'expected' | 'context' | 'draftId'>,
  requestId = newRequestId(),
): Promise<TeamReport> {
  const port = portOrRefuse(services);
  const draft = await teamReportDraftFor(services, body);
  const payload = encodeTeamPayload(draft);
  if (Buffer.byteLength(JSON.stringify(draft), 'utf8') > TEAM_PAYLOAD_REQUEST_MAX_BYTES)
    throw new ApiError('too_large', 'This report is too long. Shorten it and try again.');
  let answer: Awaited<ReturnType<TeamPort['teamReportsCreate']>>;
  try {
    answer = await atControl('create', () => port.teamReportsCreate({ requestId, payload }));
  } catch (err) {
    throw controlFailure(err);
  }
  const report = await keep(services, burrowId, actorId, answer.report, true);
  if (body.draftId)
    await services.pipeline.commit(
      doneTeamReportDraft,
      { draftId: body.draftId, state: 'sent', reportId: report.id },
      { burrowId, actorId },
    );
  return report;
}

/** The person answers the team in one of their reports. */
export async function replyToTeamReport(
  services: Services,
  burrowId: string,
  actorId: string,
  reportId: string,
  text: string,
): Promise<TeamReport> {
  const port = portOrRefuse(services);
  const words = clean(text);
  if (!words) throw badRequest('Write your answer first.');
  const payload = encodeTeamPayload({ text: words });
  try {
    const answer = await atControl('reply', () =>
      port.teamReportsReply({ requestId: newRequestId(), reportId, payload }),
    );
    return await keep(services, burrowId, actorId, answer.report);
  } catch (err) {
    if (refusalCode(err) === 'report_unknown') return gone(services, burrowId, actorId, reportId);
    throw controlFailure(err);
  }
}

/**
 * The fix works, the problem still happens, or the person takes the report back (deleted at control at once,
 * and its copy here); null after a withdrawal.
 */
export async function actOnTeamReport(
  services: Services,
  burrowId: string,
  actorId: string,
  reportId: string,
  action: TeamReportAction,
): Promise<TeamReport | null> {
  const port = portOrRefuse(services);
  let answer: Awaited<ReturnType<TeamPort['teamReportsAct']>>;
  try {
    answer = await atControl('act', () =>
      port.teamReportsAct({ requestId: newRequestId(), reportId, action }),
    );
  } catch (err) {
    // Taking back a report control no longer has: it is gone already.
    if (refusalCode(err) === 'report_unknown' && action === 'withdraw') answer = { report: null };
    else if (refusalCode(err) === 'report_unknown') return gone(services, burrowId, actorId, reportId);
    else throw controlFailure(err);
  }
  if (answer.report === null || action === 'withdraw') {
    await services.pipeline.commit(forgetTeamReport, { reportId, withdrawn: true }, { burrowId, actorId });
    return null;
  }
  return keep(services, burrowId, actorId, answer.report);
}

/* The assistant's drafts ------------------------------------------------------------------------------------------- */

/** A draft as the form opens it; done once sent or declined. Only the person it is for sees it. */
export async function teamReportDraftView(
  services: Services,
  burrowId: string,
  personId: string,
  draftId: string,
): Promise<TeamReportDraftView> {
  const draft = await loadDraft(services.db, burrowId, draftId);
  if (draft.personId !== personId) throw notFound('Draft');
  let declined = false;
  if (draft.state === 'waiting' && draft.approvalId) {
    const [approval] = await services.db
      .select({ state: approvals.state })
      .from(approvals)
      .where(eq(approvals.id, draft.approvalId));
    declined = approval?.state === 'declined';
  }
  return {
    id: draft.id,
    kind: draft.kind as TeamReportDraftView['kind'],
    text: draft.text,
    expected: draft.expected,
    done: draft.state !== 'waiting' || declined,
  };
}

/**
 * After the person's yes to the assistant's card: the draft goes to the team as the person's report (the draft's id is
 * the request's, so a second try sends nothing twice), and the assistant is woken with its number, or why not.
 */
export async function sendDraftForAssistant(
  services: Services,
  burrowId: string,
  call: { draftId: string; agentId: string; approvalId: string | null; conversationId: string | null },
): Promise<void> {
  let result: ReturnType<typeof grantedResult>;
  let fallback: string;
  try {
    const draft = await loadDraft(services.db, burrowId, call.draftId);
    if (draft.state !== 'waiting') throw new ApiError('conflict', 'This report was sent already.');
    const report = await createTeamReport(
      services,
      burrowId,
      draft.personId,
      {
        kind: draft.kind as TeamReportDraft['kind'],
        text: draft.text,
        expected: draft.expected,
        context: {},
        draftId: draft.id,
      },
      draft.id.replace(/^trd_/, ''),
    );
    // For the assistant: the number only; the team's answer shows on the report's page.
    result = grantedResult(
      'done',
      `Sent to the Whombat Team as report #${report.number}. The person follows the answer under Reports.`,
    );
    fallback = `I sent it to the Whombat Team as report #${report.number}. Their answer shows under Reports.`;
  } catch (err) {
    const message = err instanceof ApiError ? err.message : TEAM_REPORT_WORDS.refused;
    result = grantedResult('failed', message);
    fallback = `I couldn’t send it to the Whombat Team. ${message}`;
  }
  if (!call.conversationId) return;
  const threadRootId = call.approvalId
    ? await approvalThread(services.db, call.approvalId, call.conversationId).catch(() => null)
    : null;
  await answerAfterApproval(services, {
    burrowId,
    agentId: call.agentId,
    approvalId: call.approvalId,
    postIn: call.conversationId,
    threadRootId,
    result,
    fallback,
  });
}

/** The person may read and act on the reports of this Whombat: people only. */
export function personOnly(kind: string): void {
  if (kind !== 'person') throw forbidden('Only you can see your reports to the Whombat Team.');
}

/** Drafts the box no longer needs. */
export async function oldDrafts(
  services: Services,
  before: Date,
): Promise<{ id: string; burrowId: string }[]> {
  return services.db
    .select({ id: teamReportDrafts.id, burrowId: teamReportDrafts.burrowId })
    .from(teamReportDrafts)
    .where(lt(teamReportDrafts.createdAt, before))
    .limit(500);
}
