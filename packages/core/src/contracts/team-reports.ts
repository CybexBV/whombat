/**
 * Reports to the Whombat Team (Whombat docs/decisions/team-reports.md): the person's REST contract for telling the team
 * behind Whombat about a problem or an idea, and following the answers. The box passes each call on to control, which
 * keeps the reports for the team; it keeps a copy of what the person last read, so the list still shows while control
 * can't be reached and the apps know what is new. People only. Session ops too (`teamReports.*`).
 */
import { z } from 'zod';
import {
  TEAM_REPORT_EXPECTED_MAX,
  TEAM_REPORT_REPLY_MAX,
  TEAM_REPORT_TEXT_MAX,
  TeamReport,
  TeamReportAction,
  TeamReportClient,
  TeamReportId,
  TeamReportKind,
  TeamReportSummary,
} from '../domain/team-reports.js';
import { BurrowParam, endpoint } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });
const R = B.extend({ reportId: TeamReportId });

/** Why the person can't send a report now: the pilot, the team's switch, Link, or control out of reach. */
export const TeamReportsReason = z.enum(['not_invited', 'off', 'link_off', 'unreachable']);
export type TeamReportsReason = z.infer<typeof TeamReportsReason>;

/** A row of the person's list: the report and whether the team wrote or changed something they haven't read. */
export const TeamReportRow = TeamReportSummary.extend({ unread: z.boolean() });
export type TeamReportRow = z.infer<typeof TeamReportRow>;

export const TeamReportsList = z.object({
  /** Whether the form may be offered: Link on, the person invited, and the team's switch on. */
  available: z.boolean(),
  reason: TeamReportsReason.nullable(),
  reports: z.array(TeamReportRow),
  /** The list is the copy the box kept, because control couldn't be reached just now. */
  stale: z.boolean(),
});
export type TeamReportsList = z.infer<typeof TeamReportsList>;

/** What the app says about itself with a new report; the box adds its own version and channel. */
export const TeamReportClientContext = z.strictObject({
  client: TeamReportClient.optional(),
  appVersion: z
    .string()
    .regex(/^[0-9A-Za-z.+-]{1,64}$/)
    .optional(),
  device: z.string().min(1).max(120).optional(),
  language: z
    .string()
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/)
    .optional(),
});
export type TeamReportClientContext = z.infer<typeof TeamReportClientContext>;

export const CreateTeamReportBody = z.strictObject({
  kind: TeamReportKind,
  text: z.string().trim().min(1).max(TEAM_REPORT_TEXT_MAX),
  expected: z.string().trim().max(TEAM_REPORT_EXPECTED_MAX).default(''),
  context: TeamReportClientContext.default({}),
  /** The assistant's draft this report was made from (its card's Edit), so the draft is done once it is sent. */
  draftId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional(),
});
export type CreateTeamReportBody = z.infer<typeof CreateTeamReportBody>;

/** A report the assistant drafted for the person to send (its card's Edit opens the form with it). */
export const TeamReportDraftView = z.object({
  id: z.string(),
  kind: TeamReportKind,
  text: z.string(),
  expected: z.string(),
  /** Sent already, or no longer wanted. */
  done: z.boolean(),
});
export type TeamReportDraftView = z.infer<typeof TeamReportDraftView>;

export const teamReportEndpoints = {
  list: endpoint({
    id: 'teamReports.list',
    method: 'GET',
    path: '/burrows/:burrow/team-reports',
    summary:
      'The caller’s reports to the Whombat Team, newest first, with what is new to them, and whether they can send one now.',
    params: B,
    response: TeamReportsList,
  }),
  get: endpoint({
    id: 'teamReports.get',
    method: 'GET',
    path: '/burrows/:burrow/team-reports/:reportId',
    summary: 'One of the caller’s reports with its whole conversation; the caller has read it now.',
    params: R,
    response: z.object({ report: TeamReport }),
  }),
  create: endpoint({
    id: 'teamReports.create',
    method: 'POST',
    path: '/burrows/:burrow/team-reports',
    summary:
      'Send the Whombat Team a problem or an idea. The team reads it (with its AI assistant) and answers in the report.',
    params: B,
    body: CreateTeamReportBody,
    response: z.object({ report: TeamReport }),
    status: 201,
  }),
  reply: endpoint({
    id: 'teamReports.reply',
    method: 'POST',
    path: '/burrows/:burrow/team-reports/:reportId/replies',
    summary: 'Answer the Whombat Team in one of the caller’s reports.',
    params: R,
    body: z.strictObject({ text: z.string().trim().min(1).max(TEAM_REPORT_REPLY_MAX) }),
    response: z.object({ report: TeamReport }),
  }),
  act: endpoint({
    id: 'teamReports.act',
    method: 'POST',
    path: '/burrows/:burrow/team-reports/:reportId/act',
    summary:
      'Say a fix works, that the problem still happens, or take the report back (the team’s copy is deleted; null then).',
    params: R,
    body: z.strictObject({ action: TeamReportAction }),
    response: z.object({ report: TeamReport.nullable() }),
  }),
  draft: endpoint({
    id: 'teamReports.draft',
    method: 'GET',
    path: '/burrows/:burrow/team-report-drafts/:draftId',
    summary: 'A report the assistant drafted for the caller, to open in the form.',
    params: B.extend({ draftId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }),
    response: z.object({ draft: TeamReportDraftView }),
  }),
} as const;
