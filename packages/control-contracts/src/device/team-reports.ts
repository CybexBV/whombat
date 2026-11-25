/**
 * Reports to the Whombat Team (Whombat docs/decisions/team-reports.md): the person's box passes the apps' reports,
 * replies and answers on to control, which keeps them for the team, and reads back the person's reports and the team's
 * answers. Unlike every other device op these carry what the person wrote: the form tells them the Whombat Team reads it
 * (a decision of 2026-11-25, an exception to control's “never content”). The words travel as base64url JSON
 * (`TeamPayload`), checked on both ends with `@whombat/core`'s team report shapes, so the manager forwards them without
 * reading them. Cross-language.
 */
import { TeamReportAction, TeamReportId, TeamReportsUnavailable, TeamRequestId } from '@whombat/core/domain';
import { z } from 'zod';

/** The largest payload in a request: what the person wrote, well inside a device request's 64 KiB. */
export const TEAM_PAYLOAD_REQUEST_MAX_BYTES = 40_960;
/** The largest payload in an answer: a whole report with its longest conversation. */
export const TEAM_PAYLOAD_ANSWER_MAX_BYTES = 4 * 1024 * 1024;

/** base64url of `bytes` bytes. */
const b64Length = (bytes: number) => Math.ceil((bytes * 4) / 3);

/** UTF-8 JSON of one of `@whombat/core`'s team report shapes, base64url without padding. */
const payload = (maxBytes: number) =>
  z
    .string()
    .min(2)
    .max(b64Length(maxBytes))
    .regex(/^[A-Za-z0-9_-]+$/);

/** A request's payload (a `TeamReportDraft` or a `TeamReportReply`). */
export const TeamRequestPayload = payload(TEAM_PAYLOAD_REQUEST_MAX_BYTES);
/** An answer's payload (a `TeamReport` or a `TeamReportList`). */
export const TeamAnswerPayload = payload(TEAM_PAYLOAD_ANSWER_MAX_BYTES);

/** A whole report in an answer (`TeamReport`, base64url JSON). */
const ReportAnswer = z.object({ report: TeamAnswerPayload });

/**
 * Why control refused a team report op, besides the general device refusals: control's `details.code`, which the manager
 * puts first in its message.
 */
export const TeamReportRefusalCode = z.enum([
  /** The team switched new reports off for a while. */
  'team_reports_unavailable',
  /** The box's Link account isn't on the invitation list. */
  'not_invited',
  /** Sending needs Link on or in grace (reading and withdrawing don't). */
  'link_off',
  /** The account has as many open reports as it may: a new one waits until one is closed. */
  'too_many_open',
  /** No such report of this box's Link account. */
  'report_unknown',
  /** The report can't take this now (a reply to a closed report, “It works” before a fix, a full conversation). */
  'report_closed',
  /** The payload isn't one of the shapes, or its words break the limits. */
  'validation_failed',
  /** Too many reports or replies today. */
  'rate_limited',
]);
export type TeamReportRefusalCode = z.infer<typeof TeamReportRefusalCode>;

export const TEAM_REPORTS_DEVICE_OPS = {
  /**
   * Whether the person may send reports now, and their reports (`TeamReportList`), newest first. Answered in every Link
   * state but `off`: `available` is false and `reason` says why (`not_invited`: not in the pilot; `off`: the team
   * switched reports off for a while; `link_off`: Link isn't on or in grace). The list is there whenever control keeps
   * reports of the box's Link account, also while sending is off.
   */
  'team.reports.list': {
    body: z.strictObject({}),
    response: z.object({
      available: z.boolean(),
      reason: TeamReportsUnavailable.nullable(),
      reports: TeamAnswerPayload,
    }),
  },
  /** One report of the box's Link account with its whole conversation. Refuses another's or a deleted one (`report_unknown`). */
  'team.reports.get': {
    body: z.strictObject({ reportId: TeamReportId }),
    response: ReportAnswer,
  },
  /**
   * A new report (`payload` a `TeamReportDraft`). Control numbers it, keeps it for the team and answers it as it keeps
   * it; the same `requestId` again answers the same report. Refuses while sending is off (`team_reports_unavailable`,
   * `not_invited`, `link_off`), with too many open reports (`too_many_open`), past the day's limits (`rate_limited`) and
   * a payload that isn't a draft (`validation_failed`).
   */
  'team.reports.create': {
    body: z.strictObject({ requestId: TeamRequestId, payload: TeamRequestPayload }),
    response: ReportAnswer,
  },
  /**
   * The person's reply on one of their reports (`payload` a `TeamReportReply`); the same `requestId` again adds nothing.
   * A reply to a report that waited for the person's answer puts it back to the team. Refuses a closed report
   * (`report_closed`; “Still happening” opens it again).
   */
  'team.reports.reply': {
    body: z.strictObject({ requestId: TeamRequestId, reportId: TeamReportId, payload: TeamRequestPayload }),
    response: ReportAnswer,
  },
  /**
   * The person says the fix works (`works`: the report is confirmed), that it still happens (`still_happening`: open
   * again for the team), or takes the report back (`withdraw`: control deletes it and tells the team, and answers
   * `report` null, also to a withdrawal it did before). `works` and `still_happening` only once the team offered a fix
   * or closed it (`report_closed`); the same `requestId` again changes nothing. Withdrawing works in every Link state
   * control answers; the others need Link on or in grace (`link_off`).
   */
  'team.reports.act': {
    body: z.strictObject({ requestId: TeamRequestId, reportId: TeamReportId, action: TeamReportAction }),
    response: z.object({ report: TeamAnswerPayload.nullable() }),
  },
} as const;
