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
  type TrackerItemView,
  TrackerUpdateStatus,
  type TrackerWords,
  trackerAssessmentLabels,
  trackerPriorityLabels,
  trackerStatusLabels,
  UNKNOWN_TRACKER_WORDS,
  unknownTrackerWords,
} from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';

/* The report on the run page (TA-14) ----------------------------------------------------------------------------- */

/** The report's own words; the lines that name the tracker are `trackerItemText`'s. */
export function trackerReportText(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    section: t('data.trackerItem.section'),
    reporter: t('data.trackerItem.reporter'),
    filed: t('data.trackerItem.filed'),
    happened: t('data.trackerItem.happened'),
    expected: t('data.trackerItem.expected'),
    screenshot: t('data.trackerItem.screenshot'),
    conversation: t('data.trackerItem.conversation'),
    fix: t('data.trackerItem.fix'),
    notGiven: t('data.trackerItem.notGiven'),
    nothingWritten: t('data.trackerItem.nothingWritten'),
    noReplies: t('data.trackerItem.noReplies'),
    bug: t('data.trackerItem.bug'),
    feature: t('data.trackerItem.feature'),
    reporterAuthor: t('data.trackerItem.reporterAuthor'),
    released: (component: string, version: string) => t('data.trackerItem.released', { component, version }),
    tryAgain: t('data.trackerItem.tryAgain'),
    reply: t('data.trackerItem.replyAction'),
    setStatus: t('data.trackerItem.setStatusAction'),
    /** A send that waits for a person's yes (a key that asks), said in the sheet. */
    needsApproval: t('data.trackerItem.needsApproval'),
    /** The thumbnail's TalkBack label and hint: “The reporter’s screenshot, opens it larger”. */
    screenshotLabel: t('data.trackerItem.screenshotLabel'),
    screenshotHint: t('data.trackerItem.screenshotHint'),
    close: t('data.trackerItem.close'),
  };
}

export const TRACKER_ITEM_TEXT = trackerReportText();

/** “In progress”, in the locale; a status this version doesn't know in the tracker's own words (`on_hold` → “On hold”). */
export function trackerStatusText(status: string, locale?: string): string {
  return (trackerStatusLabels(locale) as Readonly<Record<string, string>>)[status] ?? words(status);
}

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
  locale?: string,
): TrackerItemModel {
  const text = trackerItemText(report.words, locale);
  const own = trackerReportText(locale);
  const priorities: Readonly<Record<string, string>> = trackerPriorityLabels(locale);
  const assessments: Readonly<Record<string, string>> = trackerAssessmentLabels(locale);
  const title = report.title.trim();
  const heading = title ? `#${report.number} · ${title}` : `#${report.number}`;
  const place = [report.connection, report.organization?.trim() || null, environmentWords(report.environment)]
    .filter(Boolean)
    .join(' · ');
  const tags = [
    report.type === 'bug' ? own.bug : own.feature,
    trackerStatusText(report.status, locale),
    ...(report.priority
      ? [
          mobileTranslator(locale).t('data.trackerItem.priority', {
            priority: priorities[report.priority] ?? words(report.priority),
          }),
        ]
      : []),
    ...(report.assessment ? [assessments[report.assessment] ?? words(report.assessment)] : []),
  ];
  const name = report.reporter.name?.trim() || null;
  const email = report.reporter.email?.trim() || null;
  const reporter = name && email ? `${name} · ${email}` : (name ?? email ?? own.notGiven);
  const messages = report.messages
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.at.localeCompare(b.m.at) || a.i - b.i)
    .map(({ m, i }) => {
      const author = m.author === 'team' ? text.teamAuthor : own.reporterAuthor;
      const time = formatRecent(m.at, now, timeZone, locale);
      return { key: `${i}`, author, time, body: m.body, accessibilityLabel: `${author}, ${time}: ${m.body}` };
    });
  return {
    heading,
    place,
    tags,
    reporter,
    filed: formatRecent(report.createdAt, now, timeZone, locale),
    description: report.description.trim() ? report.description : own.nothingWritten,
    expected: report.expected.trim() ? report.expected : null,
    screenshot: screenshotOf(report.screenshot),
    messages,
    release: report.release ? own.released(report.release.component, report.release.version) : null,
    fix: report.fix
      ? [
          fixLine(report.fix, report.words, locale),
          fixFollowUp(report.fix, locale),
          report.fix.note?.trim() || null,
        ]
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
    statusLabel: trackerStatusText(report.status, locale),
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
export function trackerItemErrorText(
  error: unknown,
  words: TrackerWords = UNKNOWN_TRACKER_WORDS,
  locale?: string,
): string {
  const message = serverMessage(error);
  const text = trackerItemText(words === UNKNOWN_TRACKER_WORDS ? unknownTrackerWords(locale) : words, locale);
  return message ? text.failedWith(message) : text.failed;
}

/* Answering it (TA-15) ------------------------------------------------------------------------------------------- */

/** The statuses a person sets, in the contract's order: Investigating … Not planned. */
export const TRACKER_UPDATE_STATUSES: readonly TrackerUpdateStatus[] = TrackerUpdateStatus.options;

export function trackerReplyText(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    title: t('data.trackerItem.replyTitle'),
    reply: t('data.trackerItem.replyLabel'),
    placeholder: t('data.trackerItem.replyPlaceholder'),
    alsoStatus: t('data.trackerItem.alsoStatus'),
    leave: (label: string) => t('data.trackerItem.leave', { label }),
    cancel: t('data.common.cancel'),
    send: t('data.trackerItem.send'),
    empty: t('data.trackerItem.empty'),
    sent: t('data.trackerItem.sent'),
    sentAndSet: (label: string) => t('data.trackerItem.sentAndSet', { label }),
  };
}

export const TRACKER_REPLY_TEXT = trackerReplyText();

export function trackerStatusSheetText(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    title: t('data.trackerItem.statusTitle'),
    status: t('data.trackerItem.statusLabel'),
    reply: t('data.trackerItem.replyLabel'),
    hint: t('data.trackerItem.statusHint'),
    cancel: t('data.common.cancel'),
    set: t('data.trackerItem.set'),
    none: t('data.trackerItem.none'),
    already: (label: string) => t('data.trackerItem.already', { label }),
    notPlanned: t('data.trackerItem.notPlanned'),
    done: (label: string, replied: boolean) =>
      replied ? t('data.trackerItem.doneReplied', { label }) : t('data.trackerItem.done', { label }),
  };
}

export const TRACKER_STATUS_TEXT = trackerStatusSheetText();

export interface TrackerStatusChoice {
  /** null: leave the status as it is (the reply sheet's first choice). */
  value: TrackerUpdateStatus | null;
  label: string;
}

/** The status sheet's choices: the seven statuses a person sets, in the contract's order. */
export function statusChoices(locale?: string): TrackerStatusChoice[] {
  return TRACKER_UPDATE_STATUSES.map((value) => ({ value, label: trackerStatusText(value, locale) }));
}

/** The reply sheet's ALSO SET THE STATUS: “Leave it at Investigating”, then the seven. */
export function replyStatusChoices(current: string, locale?: string): TrackerStatusChoice[] {
  return [
    { value: null, label: trackerReplyText(locale).leave(trackerStatusText(current, locale)) },
    ...statusChoices(locale),
  ];
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
export function replyProblem(message: string, locale?: string): TrackerProblem | null {
  return message.trim() ? null : { field: 'message', text: trackerReplyText(locale).empty };
}

/**
 * The status sheet: a status chosen, not the one it has without a reply (nothing would change), and Not planned only
 * with a reply (the tracker's rule, the contract's words).
 */
export function statusProblem(
  current: string,
  status: TrackerUpdateStatus | null,
  message: string,
  locale?: string,
): TrackerProblem | null {
  const replied = message.trim() !== '';
  const text = trackerStatusSheetText(locale);
  if (!status) return { field: 'status', text: text.none };
  if (status === 'not_planned' && !replied) return { field: 'message', text: text.notPlanned };
  if (status === current && !replied)
    return { field: 'status', text: text.already(trackerStatusText(status, locale)) };
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
export function replyDoneText(send: TrackerSend, locale?: string): string {
  const text = trackerReplyText(locale);
  return send.status ? text.sentAndSet(trackerStatusText(send.status, locale)) : text.sent;
}

/** The toast once the status was set: “Set to In progress.”, “ Your reply was sent.” after it with a reply. */
export function statusDoneText(send: TrackerSend, locale?: string): string {
  return trackerStatusSheetText(locale).done(
    send.status ? trackerStatusText(send.status, locale) : '',
    Boolean(send.message),
  );
}
