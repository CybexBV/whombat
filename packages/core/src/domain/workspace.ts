/**
 * What the connector tools read and write (docs/decisions/connectors.md "Tools"): mail, calendar events,
 * files, sheets and contacts, provider-neutral. `GoogleWorkspace` on the server maps Google's REST resources
 * onto these; the MCP tools return them.
 */
import { z } from 'zod';
import { Timestamp } from './common.js';

/** Bounded binary transfer for mail and files. Bytes are data, never prompt instructions. */
export const CONNECTOR_BINARY_MAX_BYTES = 10 * 1024 * 1024;
export const ConnectorBinary = z.object({
  name: z
    .string()
    .min(1)
    .max(500)
    .refine((s) => !/[\r\n\0]/.test(s), 'Use a single-line file name.'),
  mimeType: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\w.+-]+\/[\w.+-]+$/),
  contentBase64: z
    .string()
    .max(Math.ceil(CONNECTOR_BINARY_MAX_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
export type ConnectorBinary = z.infer<typeof ConnectorBinary>;

export const MailAttachmentDigest = z.object({
  name: z.string().max(500),
  mimeType: z.string().max(200),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type MailAttachmentDigest = z.infer<typeof MailAttachmentDigest>;

/** Longest text `mail_attachment_open` gives back (characters). */
export const ATTACHMENT_TEXT_CAP = 100_000;

/**
 * A mail attachment opened to be read (`mail_attachment_open`): a PDF's or a text file's words, or a picture sent beside
 * the answer for the model to look at. `shows: 'none'` when it has nothing to read, `reason` says why in a few words.
 */
export const OpenedAttachment = z.object({
  name: z.string().max(500),
  mimeType: z.string().max(200),
  /** Bytes. */
  size: z.number().int().nonnegative(),
  shows: z.enum(['text', 'picture', 'none']),
  text: z.string().max(ATTACHMENT_TEXT_CAP).nullable(),
  truncated: z.boolean(),
  /** A PDF's number of pages. */
  pages: z.number().int().nonnegative().optional(),
  reason: z.string().max(300).optional(),
});
export type OpenedAttachment = z.infer<typeof OpenedAttachment>;

/** An email address as given by an agent or a person (`a@b.com`). */
export const MailAddress = z.string().trim().toLowerCase().pipe(z.email()).describe('Email address');

/* Mail ------------------------------------------------------------------------------------------ */

/** Longest mail body `mail_read` returns (characters). */
export const MAIL_BODY_CAP = 50_000;

/** One message in search results. `from` / `to` as the provider shows them (`Mara Okafor <mara@…>`). */
export const MailSummary = z.object({
  id: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  from: z.string().max(500),
  to: z.array(z.string().max(500)),
  subject: z.string().max(1000),
  snippet: z.string().max(500),
  date: Timestamp,
  unread: z.boolean(),
  labels: z.array(z.string().max(200)),
  /** The conversation in the provider's web app (for a digest item's link). */
  webUrl: z.url().max(2048).optional(),
});
export type MailSummary = z.infer<typeof MailSummary>;

export const MailAttachment = z.object({
  id: z.string().max(2048).optional(),
  name: z.string().max(500),
  mimeType: z.string().max(200),
  /** Bytes. */
  size: z.number().int().nonnegative(),
});
export type MailAttachment = z.infer<typeof MailAttachment>;

/** A message as `mail_read` returns it: text body (HTML converted), capped at `MAIL_BODY_CAP`. */
export const MailMessage = MailSummary.extend({
  cc: z.array(z.string().max(500)),
  body: z.string().max(MAIL_BODY_CAP),
  bodyTruncated: z.boolean(),
  attachments: z.array(MailAttachment),
});
export type MailMessage = z.infer<typeof MailMessage>;

/** A message to draft or send. */
export const MailDraftInput = z.object({
  attachments: z
    .array(ConnectorBinary)
    .max(10)
    .optional()
    .refine(
      (items) =>
        !items ||
        items.reduce((n, a) => n + a.contentBase64.length, 0) <=
          Math.ceil(CONNECTOR_BINARY_MAX_BYTES / 3) * 4,
      'Attachments exceed 10 MB.',
    ),
  to: z.array(MailAddress).max(100).default([]),
  cc: z.array(MailAddress).max(100).default([]),
  bcc: z.array(MailAddress).max(100).default([]),
  subject: z.string().max(998).default(''),
  /** Plain text. */
  body: z.string().max(200_000).default(''),
  /** Threads the draft as a reply to this message. */
  replyToMessageId: z.string().min(1).max(200).optional(),
});
export type MailDraftInput = z.infer<typeof MailDraftInput>;

/**
 * Gmail's own labels `mail_organize` never adds or removes (connectors.md IN-15): Trash and Spam delete mail
 * (`mail_trash` does that, under its own key), Sent, Drafts and Chat are Gmail's bookkeeping. Read and archive have
 * their own flags.
 */
export const RESERVED_MAIL_LABELS = ['TRASH', 'SPAM', 'DRAFT', 'SENT', 'CHAT'] as const;

export function isReservedMailLabel(name: string): boolean {
  return (RESERVED_MAIL_LABELS as readonly string[]).includes(name.trim().toUpperCase());
}

export const RESERVED_MAIL_LABEL_TEXT =
  'Trash, Spam, Sent, Drafts and Chat are Gmail’s own: labels can’t move mail there.';

/** A label to add or remove by id or name; never one of Gmail's reserved ones. */
export const MailLabelName = z
  .string()
  .min(1)
  .max(200)
  .refine((name) => !isReservedMailLabel(name), RESERVED_MAIL_LABEL_TEXT);

/* Calendar -------------------------------------------------------------------------------------- */

/** An instant with offset (`2026-09-24T10:00:00+02:00`) or, for all-day events, a date (`2026-09-24`). */
export const EventTime = z.union([Timestamp, z.iso.date()]).describe('ISO date-time with offset, or a date');

/** An all-day `EventTime` (a date, no time). */
export function isAllDayTime(time: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(time);
}

/** Start and end are both dates or both date-times (IN-24): Google refuses a mix. */
export function eventTimesMatch(v: { start?: string; end?: string }): boolean {
  return v.start === undefined || v.end === undefined || isAllDayTime(v.start) === isAllDayTime(v.end);
}

export const EVENT_TIMES_MISMATCH_TEXT =
  'Give start and end both as dates (an all-day event) or both as date-times.';

/** A listing's window: `from` before `to` when both are given (IN-25). */
export function eventRangeValid(v: { from?: string; to?: string }): boolean {
  return v.from === undefined || v.to === undefined || Date.parse(v.from) < Date.parse(v.to);
}

/** How far back a listing with only a past `to` looks. */
export const EVENTS_LOOKBACK_MS = 30 * 86_400_000;

/**
 * Where a listing starts (IN-25): `from`; without it, now (upcoming events), unless `to` is already past,
 * then the 30 days before `to` (a window that ends before it starts is an error at Google).
 */
export function eventsWindowStart(v: { from?: string; to?: string }, now: Date): string {
  if (v.from) return v.from;
  const to = v.to ? Date.parse(v.to) : Number.NaN;
  return Number.isFinite(to) && to <= now.getTime()
    ? new Date(to - EVENTS_LOOKBACK_MS).toISOString()
    : now.toISOString();
}
export type EventTime = z.infer<typeof EventTime>;

export const GuestResponse = z.enum(['needs_action', 'accepted', 'tentative', 'declined']);
export type GuestResponse = z.infer<typeof GuestResponse>;

export const EventGuest = z.object({
  email: z.string().max(320),
  name: z.string().max(200).nullable(),
  response: GuestResponse,
});
export type EventGuest = z.infer<typeof EventGuest>;

export const CalendarEvent = z.object({
  recurrence: z.array(z.string().max(500)).max(10).optional(),
  id: z.string().min(1).max(1024),
  calendarId: z.string().min(1).max(1024),
  summary: z.string().max(1000),
  description: z.string().max(20_000),
  location: z.string().max(1000),
  start: EventTime,
  end: EventTime,
  allDay: z.boolean(),
  guests: z.array(EventGuest),
  organizer: z.string().max(320).nullable(),
  /** The event in the provider's calendar UI. */
  webUrl: z.string().url().max(2048).nullable(),
  /** Video call link, when the event has one. */
  meetUrl: z.string().url().max(2048).nullable(),
  /** The event's iCalendar id: the same on every calendar that shows it (Whombat looks-ahead.md). Absent: not known. */
  uid: z.string().min(1).max(1024).optional(),
  /** One occurrence of a repeating event (Whombat looks-ahead.md). Absent: not known, or not one. */
  recurring: z.boolean().optional(),
  /** One changed occurrence of a repeating event (moved time/place or edited notes; Whombat looks-ahead.md). */
  recurringException: z.boolean().optional(),
  /**
   * The person's own answer to it: `accepted` when they organise it; absent when they aren't on its guest list (an
   * event on a calendar they share, like a family's).
   */
  response: GuestResponse.optional(),
  /** The organiser cancelled it (Microsoft 365 keeps a cancelled meeting until it is removed). Absent: no. */
  cancelled: z.boolean().optional(),
});
export type CalendarEvent = z.infer<typeof CalendarEvent>;

/** One of the calendars an account has (Whombat looks-ahead.md): the person's own, shared ones, subscriptions. */
export const CalendarInfo = z.object({
  id: z.string().min(1).max(1024),
  name: z.string().max(200),
  /** The account's main calendar. */
  primary: z.boolean(),
  /** The person may add events to it (owner or writer): their own and shared calendars, not holidays or birthdays. */
  writable: z.boolean(),
  /** Hidden in the provider's own calendar view. */
  hidden: z.boolean(),
});
export type CalendarInfo = z.infer<typeof CalendarInfo>;

/** An event to create (and, all fields optional, the change to an existing one). */
export const CalendarEventInput = z.object({
  recurrence: z
    .array(
      z
        .string()
        .max(500)
        .regex(/^(?:RRULE|RDATE|EXDATE):[^\r\n]+$/),
    )
    .max(10)
    .optional()
    .describe(
      'RFC 5545 recurrence lines, for example RRULE:FREQ=WEEKLY;COUNT=12. Include timeZone for recurring timed events.',
    ),
  summary: z.string().trim().min(1).max(1000),
  start: EventTime,
  end: EventTime,
  description: z.string().max(20_000).optional(),
  location: z.string().max(1000).optional(),
  /** Guests are emailed an invite: adding any makes the call ask the owner first (`calendar.invite`). */
  guests: z.array(MailAddress).max(200).default([]),
  /** IANA zone for date-times without one in the provider (defaults to the calendar's). */
  timeZone: z.string().max(80).optional(),
  /** Add a video call link. */
  addMeet: z.boolean().optional(),
});
export type CalendarEventInput = z.infer<typeof CalendarEventInput>;

export const CalendarEventPatch = CalendarEventInput.partial().extend({
  /** Replaces the guest list when given. */
  guests: z.array(MailAddress).max(200).optional(),
});
export type CalendarEventPatch = z.infer<typeof CalendarEventPatch>;

/* Files ----------------------------------------------------------------------------------------- */

/** Longest file content `files_read` returns (characters). */
export const FILE_CONTENT_CAP = 200_000;

export const FileKind = z.enum(['doc', 'sheet', 'slides', 'folder', 'pdf', 'text', 'image', 'other']);
export type FileKind = z.infer<typeof FileKind>;

export const DriveFile = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(1000),
  kind: FileKind,
  mimeType: z.string().max(200),
  modifiedAt: Timestamp.nullable(),
  owners: z.array(z.string().max(320)),
  /** Bytes; null for native documents. */
  size: z.number().int().nonnegative().nullable(),
  webUrl: z.string().url().max(2048).nullable(),
});
export type DriveFile = z.infer<typeof DriveFile>;

/** Docs as Markdown, Sheets as CSV of the first sheet, text as text, anything else metadata only (`none`). */
export const FileContentFormat = z.enum(['markdown', 'csv', 'text', 'none']);
export type FileContentFormat = z.infer<typeof FileContentFormat>;

export const FileContent = z.object({
  file: DriveFile,
  format: FileContentFormat,
  content: z.string().max(FILE_CONTENT_CAP).nullable(),
  truncated: z.boolean(),
});
export type FileContent = z.infer<typeof FileContent>;

export const ShareRole = z.enum(['reader', 'commenter', 'writer']);
export type ShareRole = z.infer<typeof ShareRole>;

/** One change to a document (`docs_edit`). */
export const DocEdit = z.discriminatedUnion('op', [
  z.object({ op: z.literal('append'), text: z.string().min(1).max(100_000) }),
  z.object({
    op: z.literal('replace'),
    find: z.string().min(1).max(5000),
    text: z.string().max(100_000),
  }),
]);
export type DocEdit = z.infer<typeof DocEdit>;

/** A1 notation: `Sheet1!A1:C10`, `B2`. */
export const A1Range = z.string().trim().min(1).max(200);

export const SheetCell = z.union([z.string().max(50_000), z.number(), z.boolean(), z.null()]);
export type SheetCell = z.infer<typeof SheetCell>;

/* Contacts -------------------------------------------------------------------------------------- */

export const ContactCard = z.object({
  name: z.string().max(500),
  emails: z.array(z.string().max(320)),
  phones: z.array(z.string().max(100)),
  organization: z.string().max(500).nullable(),
});
export type ContactCard = z.infer<typeof ContactCard>;
