/**
 * Reports to the Whombat Team for the assistant (Whombat docs/decisions/team-reports.md). Spread into `MCP_TOOLS`
 * (`./mcp`); `personal: true` (only in a turn for the person), listed only where the person can send reports or has
 * some. The assistant drafts a report; Whombat always asks the person on a card that shows exactly what goes, and only
 * their press sends it. It reads the person's reports as numbers, titles, statuses in words and dates: never the team's
 * words, which show only on the report's page.
 */
import { z } from 'zod';
import { Timestamp } from '../domain/common.js';
import { TEAM_REPORT_EXPECTED_MAX, TEAM_REPORT_TEXT_MAX, TeamReportKind } from '../domain/team-reports.js';
import { ApprovalId } from '../ids.js';
import type { McpTool } from './mcp.js';

export const ReportToWhombatTeamInput = z.object({
  kind: TeamReportKind.describe(
    'bug: something in Whombat doesn’t work; idea: something the person wishes it did',
  ),
  text: z
    .string()
    .trim()
    .min(1)
    .max(TEAM_REPORT_TEXT_MAX)
    .describe(
      'The report in the person’s voice, plain words: what happened or what they would like, where in Whombat, and what they did just before',
    ),
  expected: z
    .string()
    .trim()
    .max(TEAM_REPORT_EXPECTED_MAX)
    .optional()
    .describe('For a bug: what the person expected to happen instead'),
});
export type ReportToWhombatTeamInput = z.infer<typeof ReportToWhombatTeamInput>;

export const ReportToWhombatTeamOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending_approval'), approvalId: ApprovalId, message: z.string() }),
  z.object({
    status: z.literal('failed'),
    reason: z.enum(['not_here', 'unavailable']),
    message: z.string(),
  }),
]);
export type ReportToWhombatTeamOutput = z.infer<typeof ReportToWhombatTeamOutput>;

export const WhombatTeamReportsInput = z.object({});
export type WhombatTeamReportsInput = z.infer<typeof WhombatTeamReportsInput>;

/** One of the person's reports as the assistant reads it: no words of the team's but the title. */
export const WhombatTeamReportLine = z.object({
  number: z.number().int().positive(),
  kind: TeamReportKind,
  title: z.string(),
  /** The status in the person's words (`TEAM_REPORT_STATUS_WORDS`). */
  status: z.string(),
  /** The team changed something the person hasn't read yet. */
  unread: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type WhombatTeamReportLine = z.infer<typeof WhombatTeamReportLine>;

export const WhombatTeamReportsOutput = z.object({
  /** Whether the person can send a report now. */
  available: z.boolean(),
  reports: z.array(WhombatTeamReportLine),
  /** Why not, or that the list is the copy kept while Whombat’s servers can’t be reached; absent otherwise. */
  note: z.string().optional(),
});
export type WhombatTeamReportsOutput = z.infer<typeof WhombatTeamReportsOutput>;

export const TEAM_REPORT_MCP_TOOLS = {
  report_to_whombat_team: {
    name: 'report_to_whombat_team',
    title: 'Report to the Whombat Team',
    description:
      'Drafts a report to the Whombat Team, the people who make Whombat, when the person says something in Whombat doesn’t work or wishes it did something. Only about Whombat itself, never about other services, and only when the person wants the team told. Whombat shows the person exactly what would be sent on a card; nothing goes until they press Send, and they can edit it first. Write it in their voice, without passwords or private details. The team reads it with its AI assistant and answers in the report, which the person follows in Whombat.',
    input: ReportToWhombatTeamInput,
    output: ReportToWhombatTeamOutput,
    requiredKey: null,
    readOnly: false,
    personal: true,
  } satisfies McpTool<typeof ReportToWhombatTeamInput, typeof ReportToWhombatTeamOutput> & { personal: true },
  whombat_team_reports: {
    name: 'whombat_team_reports',
    title: 'The person’s reports to the Whombat Team',
    description:
      'The person’s reports to the Whombat Team, newest first: number, kind, title, status and dates, and whether the team changed something they haven’t read. The team’s answers aren’t here: the person reads them on the report’s page in Whombat.',
    input: WhombatTeamReportsInput,
    output: WhombatTeamReportsOutput,
    requiredKey: null,
    readOnly: true,
    personal: true,
  } satisfies McpTool<typeof WhombatTeamReportsInput, typeof WhombatTeamReportsOutput> & { personal: true },
} as const;
