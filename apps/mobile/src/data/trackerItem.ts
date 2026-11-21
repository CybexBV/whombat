/**
 * A run's tracker report on the phone (Whombat report-trackers.md TA-14, TA-15; contracts 0.69 `tracker.item` and
 * `tracker.update`, feature `automations.tracker`): what the customer sent and what was said since, read live from its
 * tracker above the run's steps, and the two sheets that answer it — a reply to the reporter, and a status. Pure, like
 * the other `data/` helpers; the words are the web's, the tracker named in its driver's (`trackerItemText`).
 * Everything the customer wrote stays plain text: the screen never renders it as Markdown or links. From 0.75
 * (`automations.tracker_replies`) it says where the report's fix is.
 */
import { ApiError, fixFollowUp, fixLine, trackerItemText } from '@whombat/client';
import {
  formatRecent,
  TRACKER_ASSESSMENT_LABELS,
  TRACKER_PRIORITY_LABELS,
  type TrackerItemView,
  TrackerUpdateStatus,
  type TrackerWords,
  trackerStatusLabel,
  UNKNOWN_TRACKER_WORDS,
} from '@whombat/core';

/* The report on the run page (TA-14) ----------------------------------------------------------------------------- */

/** The report's own words; the lines that name the tracker are `trackerItemText`'s. */
export const TRACKER_ITEM_TEXT = {
  section: 'TRACKER REPORT',
  reporter: 'REPORTER',
  filed: 'FILED',
  happened: 'WHAT HAPPENED',
  expected: 'WHAT THEY EXPECTED',
  screenshot: 'SCREENSHOT',
  conversation: 'CONVERSATION',
  fix: 'FIX',
  notGiven: 'Not given',
  nothingWritten: 'Nothing written.',
  noReplies: 'No replies yet.',
  bug: 'Bug report',
  feature: 'Feature request',
  reporterAuthor: 'The reporter',
  released: (component: string, version: string) => `Released in ${component} ${version}.`,
  tryAgain: 'Try again',
  reply: 'Reply to the reporter…',
  setStatus: 'Set status…',
  /** A send that waits for a person's yes (a key that asks), said in the sheet. */
  needsApproval: 'That needs a person to approve first.',
  /** The thumbnail's TalkBack label and hint: “The reporter’s screenshot, opens it larger”. */
  screenshotLabel: 'The reporter’s screenshot',
  screenshotHint: 'Opens it larger',
  close: 'Close',
} as const;

/** One message of the conversation in the tracker, oldest first. */
export interface TrackerMessageView {
  key: string;
  /** “The reporter” or the tracker's team (“Acme team”). */
  author: string;
  time: string;
  body: string;
  accessibilityLabel: string;
}

export interface TrackerItemModel {
  /** “#15 · The rollout never finishes”. */
  heading: string;
  /** “Acme Desk dev · HollowMere College · Production”: organization and environment left out when unknown. */
  place: string;
  /** The type first (“Bug report”), the status, the priority (“High priority”) and the assessment (“Likely bug”). */
  tags: string[];
  /** “Anna de Vries · anna@hollowmere.example”, the name or the email alone, or “Not given”. */
  reporter: string;
  filed: string;
  /** What happened; “Nothing written.” when the reporter wrote nothing. */
  description: string;
  /** What they expected; null when empty (the row is left out). */
  expected: string | null;
  /** The screenshot as an image data URL; null without one (the row is left out). */
  screenshot: string | null;
  messages: TrackerMessageView[];
  /** “Released in console 4.2.0.”, or null. */
  release: string | null;
  /**
   * Where its fix is (0.75), the web's words: “PR #52 merged · live on dev.desk.acme.example (Acme Desk 0.1.176) ·
   * waiting for production”, then what the customer said about it and Whombat's note, a line each; null without one.
   */
  fix: string | null;
  /** The sheets' context line: “Acme Desk dev #15 · The rollout never finishes”. */
  context: string;
  /** Under Reply and Set status: “Acme Desk emails the reporter what you send.” */
  emails: string;
  /** The sheets' notes, naming the tracker and its team. */
  replyNote: string;
  statusNote: string;
  /** The status in the tracker vocabulary (`awaiting_release`) and its words. */
  status: string;
  statusLabel: string;
  /** The viewer may reply and set its status (`can.update`). */
  canUpdate: boolean;
  /** What TalkBack reads for the heading block: heading, place and tags. */
  accessibilityLabel: string;
}

/** `on_hold` → “On hold”: a value the tracker names in its own words, capitalised (the web's `environmentLabel`). */
function words(value: string): string {
  const text = value.replace(/_/g, ' ').trim();
  return text ? `${text[0]?.toUpperCase()}${text.slice(1)}` : value;
}

/** `production` → “Production”, `development` → “Development”, anything else capitalised; null when unknown. */
export function environmentWords(environment: string | null): string | null {
  return environment?.trim() ? words(environment) : null;
}

/** The labelled rows read out as sentences: “REPORTER” → “Reporter”. */
export function spokenLabel(label: string): string {
  return `${label[0] ?? ''}${label.slice(1).toLowerCase()}`;
}

function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/** A screenshot the phone draws: a raster image as a data URL (`tracker.item` sends nothing else). */
export function screenshotOf(value: string | null): string | null {
  return value && /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(value) ? value : null;
}

export function trackerItemModel(
  report: TrackerItemView,
  can: { update: boolean },
  now: Date,
  timeZone: string,
): TrackerItemModel {
  const text = trackerItemText(report.words);
  const title = report.title.trim();
  const heading = title ? `#${report.number} · ${title}` : `#${report.number}`;
  const place = [report.connection, report.organization?.trim() || null, environmentWords(report.environment)]
    .filter(Boolean)
    .join(' · ');
  const tags = [
    report.type === 'bug' ? TRACKER_ITEM_TEXT.bug : TRACKER_ITEM_TEXT.feature,
    trackerStatusLabel(report.status),
    ...(report.priority
      ? [`${TRACKER_PRIORITY_LABELS[report.priority] ?? words(report.priority)} priority`]
      : []),
    ...(report.assessment ? [TRACKER_ASSESSMENT_LABELS[report.assessment] ?? words(report.assessment)] : []),
  ];
  const name = report.reporter.name?.trim() || null;
  const email = report.reporter.email?.trim() || null;
  const reporter = name && email ? `${name} · ${email}` : (name ?? email ?? TRACKER_ITEM_TEXT.notGiven);
  const messages = report.messages
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.at.localeCompare(b.m.at) || a.i - b.i)
    .map(({ m, i }) => {
      const author = m.author === 'team' ? text.teamAuthor : TRACKER_ITEM_TEXT.reporterAuthor;
      const time = formatRecent(m.at, now, timeZone);
      return { key: `${i}`, author, time, body: m.body, accessibilityLabel: `${author}, ${time}: ${m.body}` };
    });
  return {
    heading,
    place,
    tags,
    reporter,
    filed: formatRecent(report.createdAt, now, timeZone),
    description: report.description.trim() ? report.description : TRACKER_ITEM_TEXT.nothingWritten,
    expected: report.expected.trim() ? report.expected : null,
    screenshot: screenshotOf(report.screenshot),
    messages,
    release: report.release
      ? TRACKER_ITEM_TEXT.released(report.release.component, report.release.version)
      : null,
    fix: report.fix
      ? [fixLine(report.fix, report.words), fixFollowUp(report.fix), report.fix.note?.trim() || null]
          .filter(Boolean)
          .join('\n')
      : null,
    context: title
      ? `${report.connection} #${report.number} · ${title}`
      : `${report.connection} #${report.number}`,
    emails: text.emails,
    replyNote: text.replyNote,
    statusNote: text.statusNote,
    status: report.status,
    statusLabel: trackerStatusLabel(report.status),
    canUpdate: can.update,
    accessibilityLabel: [heading, place, tags.join(', ')].map(sentence).join(' '),
  };
}

/** The server's own words in a refusal, else null (a body that isn't the contract's error has none). */
export function serverMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as { error?: { message?: unknown } } | null;
  const message = body && typeof body === 'object' ? body.error?.message : undefined;
  return typeof message === 'string' && message.trim() ? message.trim() : null;
}

/**
 * Why the report didn't load: the server's words when it gave them, else to try again. `words`: the tracker's as the
 * automation keeps them (the report hasn't said its own).
 */
export function trackerItemErrorText(error: unknown, words: TrackerWords = UNKNOWN_TRACKER_WORDS): string {
  const message = serverMessage(error);
  const text = trackerItemText(words);
  return message ? text.failedWith(message) : text.failed;
}

/* Answering it (TA-15) ------------------------------------------------------------------------------------------- */

/** The statuses a person sets, in the contract's order: Investigating … Not planned. */
export const TRACKER_UPDATE_STATUSES: readonly TrackerUpdateStatus[] = TrackerUpdateStatus.options;

export const TRACKER_REPLY_TEXT = {
  title: 'Reply to the reporter',
  reply: 'REPLY',
  placeholder: 'What should the reporter hear from you?',
  alsoStatus: 'ALSO SET THE STATUS',
  leave: (label: string) => `Leave it at ${label}`,
  cancel: 'Cancel',
  send: 'Send reply',
  empty: 'Write a reply.',
  sent: 'Sent to the reporter.',
  sentAndSet: (label: string) => `Sent to the reporter, and set to ${label}.`,
} as const;

export const TRACKER_STATUS_TEXT = {
  title: 'Set the status',
  status: 'STATUS',
  reply: 'REPLY',
  hint: 'Optional. Not planned needs one: tell the reporter why.',
  cancel: 'Cancel',
  set: 'Set status',
  none: 'Choose a status.',
  already: (label: string) => `It’s ${label} already.`,
  notPlanned: 'Tell the reporter why when it isn’t planned: write a reply.',
  done: (label: string, replied: boolean) => `Set to ${label}.${replied ? ' Your reply was sent.' : ''}`,
} as const;

export interface TrackerStatusChoice {
  /** null: leave the status as it is (the reply sheet's first choice). */
  value: TrackerUpdateStatus | null;
  label: string;
}

/** The status sheet's choices: the seven statuses a person sets, in the contract's order. */
export function statusChoices(): TrackerStatusChoice[] {
  return TRACKER_UPDATE_STATUSES.map((value) => ({ value, label: trackerStatusLabel(value) }));
}

/** The reply sheet's ALSO SET THE STATUS: “Leave it at Investigating”, then the seven. */
export function replyStatusChoices(current: string): TrackerStatusChoice[] {
  return [{ value: null, label: TRACKER_REPLY_TEXT.leave(trackerStatusLabel(current)) }, ...statusChoices()];
}

/** The status sheet opens on the current status when a person could set it, else on none. */
export function initialStatus(current: string): TrackerUpdateStatus | null {
  const parsed = TrackerUpdateStatus.safeParse(current);
  return parsed.success ? parsed.data : null;
}

/** What stops a sheet from sending, and the field it belongs to. */
export interface TrackerProblem {
  field: 'message' | 'status';
  text: string;
}

/** The reply sheet: a reply is what it sends. */
export function replyProblem(message: string): TrackerProblem | null {
  return message.trim() ? null : { field: 'message', text: TRACKER_REPLY_TEXT.empty };
}

/**
 * The status sheet: a status chosen, not the one it has without a reply (nothing would change), and Not planned only
 * with a reply (the tracker's rule, the contract's words).
 */
export function statusProblem(
  current: string,
  status: TrackerUpdateStatus | null,
  message: string,
): TrackerProblem | null {
  const replied = message.trim() !== '';
  if (!status) return { field: 'status', text: TRACKER_STATUS_TEXT.none };
  if (status === 'not_planned' && !replied) return { field: 'message', text: TRACKER_STATUS_TEXT.notPlanned };
  if (status === current && !replied)
    return { field: 'status', text: TRACKER_STATUS_TEXT.already(trackerStatusLabel(status)) };
  return null;
}

/** What a sheet sends: the reply trimmed (left out when empty) and the status (left out when unchanged by choice). */
export interface TrackerSend {
  message?: string;
  status?: TrackerUpdateStatus;
}

export function trackerSend(message: string, status: TrackerUpdateStatus | null): TrackerSend {
  const text = message.trim();
  return { ...(text ? { message: text } : {}), ...(status ? { status } : {}) };
}

/** The request id of a send, and what it carried. */
export interface TrackerRequest {
  id: string;
  content: string;
}

/**
 * The `requestId` of a send (TA-15): one UUID per submission; sending the same reply and status again (a retry after a
 * lost answer or a refusal) reuses the previous one, so the tracker replays it and the reporter isn't emailed twice; changed
 * content gets a new one. After a success the caller forgets it (`previous` null), so the next send is new.
 */
export function trackerRequest(
  previous: TrackerRequest | null,
  send: TrackerSend,
  newId: () => string,
): TrackerRequest {
  const content = JSON.stringify([send.message ?? null, send.status ?? null]);
  return previous && previous.content === content ? previous : { id: newId(), content };
}

/** The toast once the reply went: “Sent to the reporter.”, with the status when one was set too. */
export function replyDoneText(send: TrackerSend): string {
  return send.status
    ? TRACKER_REPLY_TEXT.sentAndSet(trackerStatusLabel(send.status))
    : TRACKER_REPLY_TEXT.sent;
}

/** The toast once the status was set: “Set to In progress.”, “ Your reply was sent.” after it with a reply. */
export function statusDoneText(send: TrackerSend): string {
  return TRACKER_STATUS_TEXT.done(send.status ? trackerStatusLabel(send.status) : '', !!send.message);
}
