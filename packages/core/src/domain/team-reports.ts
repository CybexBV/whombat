/**
 * Reports to the Whombat Team (Whombat docs/decisions/team-reports.md): a Whombat Link person tells the team behind
 * Whombat about a problem or an idea from inside Whombat, and follows the answer there. Control keeps the reports
 * (readable: the form says so) and the team answers them from its own Whombat; the person's box passes the apps'
 * requests on with the `team.reports.*` device ops. These are the parts the box, the apps and control share: the
 * vocabulary (the tracker's, so the team's tracker automations read them as they are), the limits, the shapes and the
 * words a person reads. Pure. The device ops carry these shapes as base64url JSON (`TeamPayload` in
 * `@whombat/control-contracts`), so the free text never has to fit the cross-language string patterns.
 */
import { z } from 'zod';

/** A report's id at control (`tr_` and 20 url-safe characters); its `number` is what people say (“#12”). */
export const TeamReportId = z.string().regex(/^tr_[A-Za-z0-9_-]{20}$/);
export type TeamReportId = z.infer<typeof TeamReportId>;

/** The box's id for one request, the same for every try of it: control does a request it already did only once. */
export const TeamRequestId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
export type TeamRequestId = z.infer<typeof TeamRequestId>;

/** A problem with Whombat (`bug`) or something the person would like it to do (`idea`). */
export const TeamReportKind = z.enum(['bug', 'idea']);
export type TeamReportKind = z.infer<typeof TeamReportKind>;

/** The tracker vocabulary (`TRACKER_STATUS_LABELS`), so the team's tracker automations read reports as they are. */
export const TeamReportStatus = z.enum([
  'new',
  'investigating',
  'needs_information',
  'planned',
  'in_progress',
  'awaiting_release',
  'available',
  'confirmed',
  'closed',
  'not_planned',
  'duplicate',
]);
export type TeamReportStatus = z.infer<typeof TeamReportStatus>;

/** What the person can do on a report besides writing: say the fix works, say it still happens, or take it back. */
export const TeamReportAction = z.enum(['works', 'still_happening', 'withdraw']);
export type TeamReportAction = z.infer<typeof TeamReportAction>;

/** Why the person can't send a report now; null when they can. */
export const TeamReportsUnavailable = z.enum(['not_invited', 'off', 'link_off']);
export type TeamReportsUnavailable = z.infer<typeof TeamReportsUnavailable>;

/** Where the report was written: the web app, or the phone app on Android or iOS. */
export const TeamReportClient = z.enum(['web', 'android', 'ios']);
export type TeamReportClient = z.infer<typeof TeamReportClient>;

/** The longest description, in characters (and at most 4 bytes each: the device op stays under its 64 KiB). */
export const TEAM_REPORT_TEXT_MAX = 6000;
/** The longest “What did you expect?”. */
export const TEAM_REPORT_EXPECTED_MAX = 1500;
/** The longest reply in a report's conversation. */
export const TEAM_REPORT_REPLY_MAX = 6000;
/** The most messages a report's conversation keeps; a report at the limit takes no more replies. */
export const TEAM_REPORT_MESSAGES_MAX = 200;
/** The most reports one list answer holds (newest first). */
export const TEAM_REPORTS_LIST_MAX = 100;
/** The longest title (the team's, or the start of the description until the team names it). */
export const TEAM_REPORT_TITLE_MAX = 200;

/** Control characters other than a tab and line breaks: words a person or the team wrote never carry them. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: they are what it refuses
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Text the person or the team wrote: no control characters but line breaks and tabs. */
const text = (max: number, min = 0) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((s) => !CONTROL.test(s), { message: 'Expected text without control characters' });

/** Seconds since 1970 (integer JSON, as every device op). */
const Seconds = z.number().int().min(0).max(4_102_444_800);

/** What the box and the app say about where the report was written; every part may be missing. */
export const TeamReportContext = z.strictObject({
  /** The box's runtime version (`0.304.0`). */
  runtimeVersion: z
    .string()
    .regex(/^[0-9A-Za-z.+-]{1,64}$/)
    .optional(),
  /** The box's update channel: Beta is `development`. */
  channel: z.enum(['development', 'production']).optional(),
  client: TeamReportClient.optional(),
  /** The app's own version (`3.158.0`). */
  appVersion: z
    .string()
    .regex(/^[0-9A-Za-z.+-]{1,64}$/)
    .optional(),
  /** The device and system in a few words (“iPhone · iOS 26.1”, “Firefox 146 · Linux”). */
  device: text(120, 1).optional(),
  /** The person's language (BCP 47, `nl`, `en-GB`): the team answers in it. */
  language: z
    .string()
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/)
    .optional(),
});
export type TeamReportContext = z.infer<typeof TeamReportContext>;

/**
 * A new report as the box sends it (`team.reports.create`): what the person wrote, and where. The box fills the
 * runtime's part of `context`, the app its own.
 */
export const TeamReportDraft = z.strictObject({
  kind: TeamReportKind,
  text: text(TEAM_REPORT_TEXT_MAX, 1),
  expected: text(TEAM_REPORT_EXPECTED_MAX),
  context: TeamReportContext,
});
export type TeamReportDraft = z.infer<typeof TeamReportDraft>;

/** A reply in a report's conversation as the box sends it (`team.reports.reply`). */
export const TeamReportReply = z.strictObject({ text: text(TEAM_REPORT_REPLY_MAX, 1) });
export type TeamReportReply = z.infer<typeof TeamReportReply>;

/**
 * One entry of a report's conversation, oldest first: the person's words (`reporter`) or the team's (`team`). A status
 * change the team made comes as an entry with `status` set (and words when it said something with it).
 */
export const TeamReportMessage = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  author: z.enum(['reporter', 'team']),
  text: text(Math.max(TEAM_REPORT_REPLY_MAX, TEAM_REPORT_TEXT_MAX)),
  at: Seconds,
  /** The status the report took with this entry, when it changed. */
  status: TeamReportStatus.optional(),
});
export type TeamReportMessage = z.infer<typeof TeamReportMessage>;

/** A report in a list: enough to show its row and know whether something changed. */
export const TeamReportSummary = z.object({
  id: TeamReportId,
  number: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  kind: TeamReportKind,
  title: text(TEAM_REPORT_TITLE_MAX, 1),
  status: TeamReportStatus,
  createdAt: Seconds,
  updatedAt: Seconds,
  /** Counts the team's changes (a reply, a status): the box compares it with what the person last read. */
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type TeamReportSummary = z.infer<typeof TeamReportSummary>;

/** A whole report: what the person sent and the conversation since. */
export const TeamReport = TeamReportSummary.extend({
  text: text(TEAM_REPORT_TEXT_MAX, 1),
  expected: text(TEAM_REPORT_EXPECTED_MAX),
  context: TeamReportContext,
  messages: z.array(TeamReportMessage).max(TEAM_REPORT_MESSAGES_MAX),
});
export type TeamReport = z.infer<typeof TeamReport>;

/** The person's reports as `team.reports.list` carries them, newest first. */
export const TeamReportList = z.object({ reports: z.array(TeamReportSummary).max(TEAM_REPORTS_LIST_MAX) });
export type TeamReportList = z.infer<typeof TeamReportList>;

/** Closed reports: the conversation is over until the person says it still happens. */
export const TEAM_REPORT_CLOSED: ReadonlySet<TeamReportStatus> = new Set([
  'confirmed',
  'closed',
  'not_planned',
  'duplicate',
]);

/** Whether a report is still open (the box keeps asking about it while one is). */
export function teamReportOpen(status: TeamReportStatus): boolean {
  return !TEAM_REPORT_CLOSED.has(status);
}

/** Whether the report waits for the person: a question from the team, or a fix to try. */
export function teamReportNeedsYou(status: TeamReportStatus): boolean {
  return status === 'needs_information' || status === 'available';
}

/** The person's words for a status. */
export const TEAM_REPORT_STATUS_WORDS: Readonly<Record<TeamReportStatus, string>> = {
  new: 'Received',
  investigating: 'Looking into it',
  needs_information: 'Needs your reply',
  planned: 'Planned',
  in_progress: 'Being fixed',
  awaiting_release: 'Fixed, coming in an update',
  available: 'Fix available',
  confirmed: 'Works now',
  closed: 'Closed',
  not_planned: 'Not planned',
  duplicate: 'Already reported',
};

/** The four steps a report goes through, as the track on its page shows them. */
export const TEAM_REPORT_STAGES = ['Received', 'Looking into it', 'Being fixed', 'Fixed'] as const;

/** Which of the four steps a status is at (0–3); a report that ended without a fix stays where it got to. */
export function teamReportStage(status: TeamReportStatus): 0 | 1 | 2 | 3 {
  switch (status) {
    case 'new':
      return 0;
    case 'investigating':
    case 'needs_information':
    case 'planned':
    case 'not_planned':
    case 'duplicate':
    case 'closed':
      return 1;
    case 'in_progress':
      return 2;
    case 'awaiting_release':
    case 'available':
    case 'confirmed':
      return 3;
  }
}

/** Whether the person may say the fix works or still happens: once a fix is available to them, or a fix was closed. */
export function teamReportCanConfirm(status: TeamReportStatus): boolean {
  return status === 'available' || status === 'closed';
}

/** A report's title until the team names it: the description's first line, cut at a word. */
export function teamReportExcerptTitle(description: string): string {
  const line = (description.split(/\r?\n/).find((l) => l.trim()) ?? '').trim().replace(/\s+/g, ' ');
  if (line.length <= 80) return line || 'Report';
  const cut = line.slice(0, 80);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
