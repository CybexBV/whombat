/**
 * Reports to the Whombat Team on the box (docs/decisions/team-reports.md): each call goes to control through the
 * manager, outside any transaction, and what control answered is kept through the commit pipeline (`commands.ts`).
 * The box keeps a copy of each report as the person last read it: the list shows the copies while control
 * can't be reached, and a report is unread while control's revision is past the one the person read. A new report
 * carries the box's version and update channel besides what the app said about itself. Each send carries one request
 * id for every try of it (the app's, or the draft's), so control takes the words once.
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
import type { z } from 'zod';
import { answerAfterApproval, grantedResult } from '../approvals/result';
import { approvalThread } from '../approvals/wake';
import { externalEffect } from '../commit/scope';
import { approvals, teamReportCopies, teamReportDrafts } from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import type { Services } from '../services';
import {
  doneTeamReportDraft,
  dropTeamReports,
  forgetTeamReport,
  keepTeamReport,
  loadDraft,
  sameTeamReportSummary,
  seeTeamReports,
} from './commands';
import {
  boxContext,
  controlFailure,
  controlUnreachable,
  managerSaysNoLink,
  refusalCode,
  TEAM_REPORT_WORDS,
  type TeamPort,
  type TeamUse,
  teamPortOf,
} from './control';
import { decodeTeamPayload, encodeTeamPayload, TeamPayloadError } from './payload';

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

/**
 * One call to control, recorded as an effect outside the database. `idempotent`: repeating it changes nothing at
 * control (a read, a withdrawal, or a send whose request id comes with the request, so a resend carries the same one).
 */
function atControl<T>(label: string, call: () => Promise<T>, idempotent: boolean): Promise<T> {
  return externalEffect(`team_reports.${label}`, call, { idempotent });
}

/** A new request id, for an app that didn't send its own: control does a request it has done already only once. */
function newRequestId(): string {
  return randomBytes(16).toString('base64url');
}

/** The request id of sending the assistant's draft, the same from its card and from the form, on every device. */
export function draftRequestId(draftId: string): string {
  return draftId.replace(/^trd_/, '');
}

/** The request id a send goes with, and whether it came with the request (so a resend carries it again). */
function requestIdOf(given: string | undefined): { requestId: string; given: boolean } {
  return given ? { requestId: given, given: true } : { requestId: newRequestId(), given: false };
}

/** The way to control for `use`, or the person's words for why there is none now. */
function portOrRefuse(services: Services, use: TeamUse): TeamPort {
  const port = teamPortOf(services, use);
  if (port) return port;
  // Link ended: what was sent stays readable, nothing new goes.
  if (use === 'send' && teamPortOf(services, 'read'))
    throw new ApiError('not_allowed', TEAM_REPORT_WORDS.sendNeedsLink);
  throw new ApiError('unavailable', TEAM_REPORT_WORDS.linkOff);
}

/** Control's answer, read as the contract says; a malformed one reads as control not taking the request. */
function decoded<S extends z.ZodType>(schema: S, payload: string): z.output<S> {
  try {
    return decodeTeamPayload(schema, payload);
  } catch (err) {
    if (err instanceof TeamPayloadError) throw new ApiError('unavailable', TEAM_REPORT_WORDS.refused);
    throw err;
  }
}

/** Why the list can't say whether the person may send, from a failed read of control's list. */
function listFailureReason(err: unknown): TeamReportsReason {
  if (managerSaysNoLink(err)) return 'link_off';
  switch (refusalCode(err)) {
    case 'link_off':
      return 'link_off';
    case 'not_invited':
      return 'not_invited';
    case 'team_reports_unavailable':
      return 'off';
    default:
      // Out of reach, or a refusal or answer the box doesn't know: never Link being off.
      return 'unreachable';
  }
}

/**
 * Whether control's list says nothing the copies don't: every report as its copy has it (or older), and with the whole
 * list no copy of a report control no longer has.
 */
export function teamListMatchesCopies(
  reports: readonly TeamReportList['reports'][number][],
  copies: readonly CopyRow[],
  complete: boolean,
): boolean {
  const byId = new Map(copies.map((c) => [c.reportId, c]));
  if (
    !reports.every((s) => {
      const had = byId.get(s.id);
      return !!had && sameTeamReportSummary(had, s);
    })
  )
    return false;
  if (!complete) return true;
  const listed = new Set(reports.map((s) => s.id));
  return copies.every((c) => listed.has(c.reportId));
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
  const port = teamPortOf(services, 'read');
  if (!port) return keptList(services, burrowId, 'link_off');
  let answer: Awaited<ReturnType<TeamPort['teamReportsList']>>;
  let reports: TeamReportList['reports'];
  try {
    answer = await atControl('list', () => port.teamReportsList(), true);
    reports = decodeTeamPayload(TeamReportList, answer.reports).reports;
  } catch (err) {
    services.log.debug(
      { status: (err as { status?: number }).status, err: err instanceof Error ? err.name : 'error' },
      'team reports: the list wasn’t read',
    );
    if (controlUnreachable(err) || err instanceof TeamPayloadError)
      return keptList(services, burrowId, 'unreachable');
    return keptList(services, burrowId, listFailureReason(err));
  }
  heard.set(services, { available: answer.available, at: services.clock().getTime() });
  const copies = await teamReportCopiesOf(services, burrowId);
  const before = new Map(copies.map((c) => [c.reportId, c]));
  const complete = reports.length < TEAM_REPORTS_LIST_MAX;
  // Nothing new: nothing to keep, nobody to tell.
  if (!teamListMatchesCopies(reports, copies, complete))
    await services.pipeline.commit(seeTeamReports, { reports, complete }, { burrowId, actorId });
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

/**
 * Keeps what control answered about a report; the person has read it now. An answer older than the copy (it crossed a
 * newer one) leaves the copy as it is, and the person sees the copy when it holds the whole report.
 */
async function keep(
  services: Services,
  burrowId: string,
  actorId: string,
  report: TeamReport,
  sent = false,
): Promise<TeamReport> {
  const kept = await services.pipeline.commit(
    keepTeamReport,
    { report, read: true, sent },
    { burrowId, actorId },
  );
  if (kept.status === 'ok' && (kept.result as { older?: boolean }).older)
    return (await keptReport(services, burrowId, report.id)) ?? report;
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
  const port = teamPortOf(services, 'read');
  if (!port) {
    const kept = await keptReport(services, burrowId, reportId);
    if (kept) return kept;
    throw new ApiError('unavailable', TEAM_REPORT_WORDS.linkOff);
  }
  let report: TeamReport;
  try {
    const answer = await atControl('get', () => port.teamReportsGet({ reportId }), true);
    report = decodeTeamPayload(TeamReport, answer.report);
  } catch (err) {
    if (refusalCode(err) === 'report_unknown') return gone(services, burrowId, actorId, reportId);
    if (controlUnreachable(err) || err instanceof TeamPayloadError) {
      const kept = await keptReport(services, burrowId, reportId);
      if (kept) return kept;
      if (err instanceof TeamPayloadError) throw new ApiError('unavailable', TEAM_REPORT_WORDS.refused);
    }
    throw controlFailure(err);
  }
  return keep(services, burrowId, actorId, report);
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
 * Sends the person's report to the team and keeps its copy (read: they wrote it). Made from the assistant's draft
 * (`draftId`), it goes with the draft's request id, so control answers the same report whether the card's yes or the
 * form sent it first, and the draft is done; a draft sent already is refused and nothing goes. Otherwise the app's
 * `requestId`: the same one again answers the same report.
 */
export async function createTeamReport(
  services: Services,
  burrowId: string,
  actorId: string,
  body: Pick<CreateTeamReportBody, 'kind' | 'text' | 'expected' | 'context' | 'draftId' | 'requestId'>,
): Promise<TeamReport> {
  const port = portOrRefuse(services, 'send');
  let request = requestIdOf(body.requestId);
  if (body.draftId) {
    const made = await loadDraft(services.db, burrowId, body.draftId);
    if (made.personId !== actorId) throw notFound('Draft');
    if (made.state === 'sent') throw conflict(TEAM_REPORT_WORDS.draftSent);
    request = { requestId: draftRequestId(made.id), given: true };
  }
  const draft = await teamReportDraftFor(services, body);
  const payload = encodeTeamPayload(draft);
  if (Buffer.byteLength(JSON.stringify(draft), 'utf8') > TEAM_PAYLOAD_REQUEST_MAX_BYTES)
    throw new ApiError('too_large', 'This report is too long. Shorten it and try again.');
  let made: TeamReport;
  try {
    const answer = await atControl(
      'create',
      () => port.teamReportsCreate({ requestId: request.requestId, payload }),
      request.given,
    );
    made = decoded(TeamReport, answer.report);
  } catch (err) {
    throw controlFailure(err);
  }
  const report = await keep(services, burrowId, actorId, made, true);
  if (body.draftId)
    await services.pipeline.commit(
      doneTeamReportDraft,
      { draftId: body.draftId, state: 'sent', reportId: report.id },
      { burrowId, actorId },
    );
  return report;
}

/** The person answers the team in one of their reports; `requestId` as with a new report. */
export async function replyToTeamReport(
  services: Services,
  burrowId: string,
  actorId: string,
  reportId: string,
  text: string,
  requestId?: string,
): Promise<TeamReport> {
  const port = portOrRefuse(services, 'send');
  const words = clean(text);
  if (!words) throw badRequest('Write your answer first.');
  const payload = encodeTeamPayload({ text: words });
  const request = requestIdOf(requestId);
  let report: TeamReport;
  try {
    const answer = await atControl(
      'reply',
      () => port.teamReportsReply({ requestId: request.requestId, reportId, payload }),
      request.given,
    );
    report = decoded(TeamReport, answer.report);
  } catch (err) {
    if (refusalCode(err) === 'report_unknown') return gone(services, burrowId, actorId, reportId);
    throw controlFailure(err);
  }
  return keep(services, burrowId, actorId, report);
}

/**
 * The fix works, the problem still happens, or the person takes the report back (deleted at control at once,
 * and its copy here); null after a withdrawal. Withdrawing works whenever control knows the box; the others need Link
 * on. `requestId` as with a new report: pressing It works again counts once.
 */
export async function actOnTeamReport(
  services: Services,
  burrowId: string,
  actorId: string,
  reportId: string,
  action: TeamReportAction,
  requestId?: string,
): Promise<TeamReport | null> {
  const withdraw = action === 'withdraw';
  const port = portOrRefuse(services, withdraw ? 'read' : 'send');
  const request = requestIdOf(requestId);
  let report: TeamReport | null;
  try {
    const answer = await atControl(
      'act',
      () => port.teamReportsAct({ requestId: request.requestId, reportId, action }),
      // Control answers a withdrawal it did before the same way.
      withdraw || request.given,
    );
    report = answer.report === null || withdraw ? null : decoded(TeamReport, answer.report);
  } catch (err) {
    // Taking back a report control no longer has: it is gone already.
    if (refusalCode(err) === 'report_unknown' && withdraw) report = null;
    else if (refusalCode(err) === 'report_unknown') return gone(services, burrowId, actorId, reportId);
    else throw controlFailure(err);
  }
  if (report === null) {
    await services.pipeline.commit(forgetTeamReport, { reportId, withdrawn: true }, { burrowId, actorId });
    return null;
  }
  return keep(services, burrowId, actorId, report);
}

/**
 * Every copy goes, in every burrow (and with `drafts`, the assistant's drafts not sent yet): a backup restored onto new
 * hardware starts without the earlier box's reports, and a box taken out of Link keeps none, as control keeps none of
 * it any more.
 */
export async function forgetAllTeamReports(
  services: Services,
  options: { drafts: boolean },
): Promise<number> {
  const withCopies = await services.db
    .selectDistinct({ burrowId: teamReportCopies.burrowId })
    .from(teamReportCopies);
  const withDrafts = options.drafts
    ? await services.db
        .selectDistinct({ burrowId: teamReportDrafts.burrowId })
        .from(teamReportDrafts)
        .where(eq(teamReportDrafts.state, 'waiting'))
    : [];
  const burrowIds = new Set([...withCopies, ...withDrafts].map((r) => r.burrowId));
  let gone = 0;
  for (const burrowId of burrowIds) {
    const person = await thePerson(services.db, burrowId);
    if (!person) continue;
    const res = await services.pipeline.commit(
      dropTeamReports,
      { drafts: options.drafts },
      { burrowId, actorId: person.id },
    );
    if (res.status === 'ok') gone += (res.result as { copies: number }).copies;
  }
  return gone;
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
 * After the person's yes to the assistant's card: the draft goes to the team as the person's report (with the draft's
 * request id, so a second try, or the form's send of it, sends nothing twice), and the assistant is woken with its
 * number, or why not.
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
    const report = await createTeamReport(services, burrowId, draft.personId, {
      kind: draft.kind as TeamReportDraft['kind'],
      text: draft.text,
      expected: draft.expected,
      context: {},
      draftId: draft.id,
    });
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
