/**
 * Reports to the Whombat Team (Whombat docs/decisions/team-reports.md), the same on the web and the phone: whether the
 * entry shows, the list's order and folds, a report's conversation in time order with its status changes, the
 * four-step track, what is sent with a new report, the assistant's draft card's Edit, and the words people read. Pure.
 */
import {
  type Approval,
  TEAM_REPORT_DRAFT_ACTION,
  TEAM_REPORT_STAGES,
  TEAM_REPORT_STATUS_WORDS,
  type TeamReport,
  type TeamReportClientContext,
  type TeamReportContext,
  type TeamReportKind,
  type TeamReportRow,
  type TeamReportStatus,
  type TeamReportsList,
  type TeamReportsReason,
  teamReportNeedsYou,
  teamReportOpen,
  teamReportStage,
} from '@whombat/core';
import { type ProtocolVersion, protocolAtLeast, TEAM_REPORTS_MINOR } from '@whombat/protocol/session';
import { formatDay, formatRelativeDay, formatTime } from './hosts/format';

/** Where a security problem goes instead: privately, on GitHub. */
export const TEAM_REPORT_SECURITY_URL = 'https://github.com/CybexBV/whombat/security/advisories/new';

export const TEAM_REPORT_WORDS = {
  entry: 'Report a problem or idea',
  title: 'Your reports',
  intro: 'Problems and ideas you sent the Whombat Team, and their answers.',
  newReport: 'New report',
  empty: 'Tell the Whombat Team what isn’t working or what you’d like Whombat to do.',
  stale: 'This list may be out of date: the Whombat Team can’t be reached right now.',
  loading: 'Loading…',
  updateFirst: 'Update this Whombat to send reports to the Whombat Team.',
  listFailed: 'Your reports couldn’t load. Try again.',
  tryAgain: 'Try again',
  open: 'Open',
  closed: 'Closed',
  showClosed: 'Show',
  hideClosed: 'Hide',
  unread: 'New answer',
  back: 'Your reports',
  // The form.
  formTitle: 'New report',
  kindQuestion: 'What is it about?',
  kinds: {
    bug: { title: 'Something’s wrong', hint: 'Whombat doesn’t do what it should.' },
    idea: { title: 'An idea', hint: 'Something you’d like Whombat to do.' },
  },
  textLabel: { bug: 'What happened?', idea: 'What would you like Whombat to do?' },
  expectedLabel: 'What did you expect?',
  optional: 'Optional',
  sentWith: 'What’s sent with it',
  sentWithNothingElse: 'Nothing else: no files, logs or pictures.',
  warning:
    'The Whombat Team and its AI assistant read what you send here. Leave out passwords and private details.',
  securityQuestion: 'A security problem?',
  securityLink: 'Report it privately.',
  send: 'Send',
  sending: 'Sending…',
  sent: 'Sent. The Whombat Team reads every report and answers here.',
  draftDone: 'That draft was already sent or put aside. You can write a new report here.',
  /** The assistant's card: opens the form with its draft, to change it before sending. */
  edit: 'Edit',
  draftFailed: 'The draft couldn’t load. You can write the report here.',
  // A report's page.
  you: 'You',
  team: 'Whombat Team',
  expected: 'Expected',
  progress: 'Progress',
  reply: 'Write to the Whombat Team',
  replySend: 'Send',
  confirmQuestion: 'Is it fixed for you?',
  works: 'It works',
  stillHappening: 'Still happening',
  more: 'More',
  withdraw: 'Withdraw report',
  withdrawConfirm: 'Withdraw this report? The Whombat Team’s copy is deleted.',
  withdrawn: 'Report withdrawn.',
  cancel: 'Cancel',
  notFound: 'This report isn’t here any more.',
  reportFailed: 'This report couldn’t load. Try again.',
  /** Above a conversation too long for one answer: its oldest messages aren't here. */
  earlier: 'Earlier messages aren’t shown here.',
  failed: 'That didn’t go through. Try again in a moment.',
  full: 'This report can’t take more replies. Start a new report if something is still wrong.',
} as const;

/** The action the box's card names when the assistant asks to send its draft (the box's `TEAM_REPORT_ACTION`). */
export { TEAM_REPORT_DRAFT_ACTION };

/** A draft's id, as the form's address and the box's draft route take it. */
const DRAFT_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The assistant's draft a card still asks about: its id, so the card offers Edit (the form with the draft) and no later
 * time. Null for any other approval, and once the card is answered.
 */
export function teamReportDraftOf(approval: Pick<Approval, 'action' | 'state'>): string | null {
  if (approval.state !== 'pending') return null;
  const { action } = approval;
  if (action.type !== 'custom' || action.params.name !== TEAM_REPORT_DRAFT_ACTION) return null;
  const id = action.params.data.draftId;
  return typeof id === 'string' && DRAFT_ID.test(id) ? id : null;
}

/** The form with the assistant's draft, burrow-less: `/reports/new?draft=<id>`. */
export function teamReportDraftPath(draftId: string): string {
  return `/reports/new?draft=${encodeURIComponent(draftId)}`;
}

/**
 * The assistant's draft an Inbox item of its card names (the item's `href`, the form with the draft), so the Inbox's
 * card offers the same Edit as Chat's; null for any other item.
 */
export function teamReportDraftOfHref(href: string | null | undefined): string | null {
  const id = /^\/reports\/new\?draft=([^&#]+)$/.exec(href ?? '')?.[1];
  if (!id) return null;
  try {
    const draftId = decodeURIComponent(id);
    return DRAFT_ID.test(draftId) ? draftId : null;
  } catch {
    return null;
  }
}

/** A report's kind in one word, for its row and page. */
export const TEAM_REPORT_KIND_WORDS: Readonly<Record<TeamReportKind, string>> = {
  bug: 'Problem',
  idea: 'Idea',
};

/** Why a new report can't be sent now, in the person's words (`reason`); null when it can. */
export function teamReportsUnavailableText(reason: TeamReportsReason | null): string | null {
  switch (reason) {
    case 'unreachable':
      return 'The Whombat Team can’t be reached right now. Try again in a moment.';
    case 'link_off':
      return 'New reports need Whombat Link.';
    case 'off':
      return 'The Whombat Team isn’t taking new reports right now.';
    case 'not_invited':
      return 'Sending new reports isn’t open to you right now.';
    default:
      return null;
  }
}

/**
 * Whether the entry shows (“Report a problem or idea”): only on a Whombat that speaks reports (session minor 10), and
 * only where the person can send one or already has some. Nobody else sees it.
 */
export function teamReportsShown(
  protocol: ProtocolVersion | null | undefined,
  list: Pick<TeamReportsList, 'available' | 'reports'> | null | undefined,
): boolean {
  if (!protocolAtLeast(protocol, TEAM_REPORTS_MINOR) || !list) return false;
  return list.available || list.reports.length > 0;
}

/** Newest first. */
const newest = (a: TeamReportRow, b: TeamReportRow) => b.updatedAt - a.updatedAt || b.number - a.number;

/** Open reports that wait for the person first, then those with something new, then the latest change. */
export function teamReportOrder(a: TeamReportRow, b: TeamReportRow): number {
  const rank = (r: TeamReportRow) => (teamReportNeedsYou(r.status) ? 0 : r.unread ? 1 : 2);
  return rank(a) - rank(b) || newest(a, b);
}

export interface TeamReportGroups {
  open: TeamReportRow[];
  closed: TeamReportRow[];
  /** Closed is folded while open reports exist; shown at once when there are none. */
  foldable: boolean;
  /** The closed reports a folded “Closed” still shows: those with something new. */
  closedWhileFolded: TeamReportRow[];
}

/** The list's two parts: open reports (`teamReportOrder`) and the closed ones, newest first, folded under “Closed”. */
export function teamReportGroups(rows: readonly TeamReportRow[]): TeamReportGroups {
  const open = rows.filter((r) => teamReportOpen(r.status)).sort(teamReportOrder);
  const closed = rows.filter((r) => !teamReportOpen(r.status)).sort(newest);
  return {
    open,
    closed,
    foldable: open.length > 0,
    closedWhileFolded: closed.filter((r) => r.unread),
  };
}

/** How many of the person's reports have something new. */
export function teamReportsUnread(rows: readonly Pick<TeamReportRow, 'unread'>[]): number {
  return rows.filter((r) => r.unread).length;
}

/** About's line for the person's reports: “No reports yet”, “1 report”, “3 reports · 1 new answer”. */
export function teamReportsSummary(rows: readonly Pick<TeamReportRow, 'unread'>[]): string {
  if (!rows.length) return 'No reports yet';
  const count = rows.length === 1 ? '1 report' : `${rows.length} reports`;
  const unread = teamReportsUnread(rows);
  if (!unread) return count;
  return `${count} · ${unread === 1 ? '1 new answer' : `${unread} new answers`}`;
}

/** A row's line under its title: “#12 · Problem · Looking into it”. */
export function teamReportRowLine(row: Pick<TeamReportRow, 'number' | 'kind' | 'status'>): string {
  return `#${row.number} · ${TEAM_REPORT_KIND_WORDS[row.kind]} · ${TEAM_REPORT_STATUS_WORDS[row.status]}`;
}

/** A row's name for screen readers: its title, its status, and whether something is new. */
export function teamReportRowLabel(row: Pick<TeamReportRow, 'title' | 'status' | 'unread'>): string {
  return [row.title, TEAM_REPORT_STATUS_WORDS[row.status], row.unread ? TEAM_REPORT_WORDS.unread : null]
    .filter(Boolean)
    .join(', ');
}

const DAY_MS = 86_400_000;

/** A list's time: “14:05” today, “Yesterday”, a weekday within the week, else “6 Oct”. Seconds since 1970. */
export function teamReportWhen(at: number, now: number, timeZone?: string): string {
  const t = at * 1000;
  const today = formatDay(now, timeZone);
  if (formatDay(t, timeZone) === today && Math.abs(now - t) < DAY_MS) return formatTime(t, timeZone);
  if (formatDay(now - DAY_MS, timeZone) === formatDay(t, timeZone)) return 'Yesterday';
  if (now - t < 6 * DAY_MS && now >= t)
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', ...(timeZone ? { timeZone } : {}) }).format(
      t,
    );
  return formatDay(t, timeZone);
}

/** A conversation's time: “Today 14:05”, “Yesterday 09:12”, “Mon 08:00”, “4 Oct, 02:00”. Seconds since 1970. */
export function teamReportMessageWhen(at: number, now: number, timeZone?: string): string {
  return formatRelativeDay(at * 1000, now, timeZone);
}

/** One line of a report's conversation, oldest first. */
export type TeamReportEntry =
  /** What the person sent: the report's own words and what they expected. */
  | { kind: 'sent'; key: string; at: number; text: string; expected: string }
  /** A message: the person's (`reporter`) or the team's, as plain text. */
  | { kind: 'message'; key: string; at: number; author: 'reporter' | 'team'; who: string; text: string }
  /** A status change, as a quiet line (“Being fixed”). */
  | { kind: 'status'; key: string; at: number; status: TeamReportStatus; words: string };

/**
 * A report's conversation in time order: what the person sent first, then every message as it came, a status change as
 * its own quiet line before the words sent with it. A first message that only repeats the report is left out (only
 * when the answer has the first message: `earlier` counts the oldest it left out). Only an entry of the person's with a
 * status and no words is their press (It works, Still happening); a reply of theirs that moved the status (an answer to
 * the team's question) is their message, as they wrote it.
 */
export function teamReportTimeline(
  report: Pick<TeamReport, 'text' | 'expected' | 'createdAt' | 'messages'>,
  earlier = 0,
) {
  const entries: TeamReportEntry[] = [
    { kind: 'sent', key: 'sent', at: report.createdAt, text: report.text, expected: report.expected },
  ];
  report.messages.forEach((m, i) => {
    if (
      earlier === 0 &&
      i === 0 &&
      m.author === 'reporter' &&
      !m.status &&
      m.text.trim() === report.text.trim()
    )
      return;
    const press = m.author === 'reporter' && !m.text.trim();
    if (m.status && (m.author === 'team' || press))
      entries.push({
        kind: 'status',
        key: `${m.id}-status`,
        at: m.at,
        status: m.status,
        words: teamReportStatusLine(m.status, m.author),
      });
    if (m.text.trim())
      entries.push({
        kind: 'message',
        key: m.id,
        at: m.at,
        author: m.author,
        who: m.author === 'team' ? TEAM_REPORT_WORDS.team : TEAM_REPORT_WORDS.you,
        text: m.text,
      });
  });
  return entries;
}

/** A status change in the conversation: the team's as the new status, the person's press as what they said. */
export function teamReportStatusLine(status: TeamReportStatus, author: 'reporter' | 'team' = 'team'): string {
  if (author === 'reporter') {
    if (status === 'confirmed') return 'You said it works';
    if (teamReportOpen(status)) return 'You said it still happens';
  }
  return `Status: ${TEAM_REPORT_STATUS_WORDS[status]}`;
}

export type TeamReportStepState = 'done' | 'current' | 'ahead';

/**
 * The four-step track (Received → Looking into it → Being fixed → Fixed) for a status: the steps behind it done, its
 * own current while the team works on it. Received and Fixed are done once reached; a report that ended without a fix
 * stays where it got to, done.
 */
export function teamReportTrack(status: TeamReportStatus): { label: string; state: TeamReportStepState }[] {
  const stage = teamReportStage(status);
  const ended = !teamReportOpen(status);
  return TEAM_REPORT_STAGES.map((label, i) => ({
    label,
    state:
      i < stage || (i === stage && (ended || stage === 0 || stage === 3))
        ? 'done'
        : i === stage
          ? 'current'
          : 'ahead',
  }));
}

/** The track for a screen reader: “Step 2 of 4: Looking into it”. */
export function teamReportTrackLabel(status: TeamReportStatus): string {
  const stage = teamReportStage(status);
  return `Step ${stage + 1} of ${TEAM_REPORT_STAGES.length}: ${TEAM_REPORT_STAGES[stage]}`;
}

/** What the app says about itself, before it is checked against the contract. */
export interface TeamReportClientInput {
  client: 'web' | 'android' | 'ios';
  appVersion?: string | null | undefined;
  device?: string | null | undefined;
  language?: string | null | undefined;
}

const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: they are what it takes out
const CONTROL = /[\u0000-\u001f\u007f]+/g;

/** The device in a few words, at most 120 characters, without control characters; null when nothing is left. */
function deviceWords(device: string | null | undefined): string | null {
  const words = (device ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return words ? words.slice(0, 120).trimEnd() : null;
}

/** What the app sends with a new report (`context`): each part only when it is in the contract's shape. */
export function teamReportClientContext(input: TeamReportClientInput): TeamReportClientContext {
  const out: TeamReportClientContext = { client: input.client };
  const version = input.appVersion?.trim();
  if (version && VERSION.test(version)) out.appVersion = version;
  const device = deviceWords(input.device);
  if (device) out.device = device;
  const language = input.language?.trim();
  if (language && LANGUAGE.test(language)) out.language = language;
  return out;
}

const CLIENT_WORDS: Record<'web' | 'android' | 'ios', string> = {
  web: 'Web app',
  android: 'Android app',
  ios: 'iPhone app',
};

/** The update channel as people say it: Beta is the development channel. */
const CHANNEL_WORDS: Record<NonNullable<TeamReportContext['channel']>, string> = {
  development: 'Beta',
  production: 'Production',
};

type SentWithContext = Pick<
  TeamReportContext,
  'runtimeVersion' | 'channel' | 'client' | 'appVersion' | 'device' | 'language'
>;

/**
 * What the box adds about itself, its version and update channel, in the words the app knows: “0.304.0 · Beta”, or
 * what it doesn't know named (“0.304.0 and its update channel”). The box always adds both.
 */
function boxWords(context: SentWithContext): string {
  const channel = context.channel ? CHANNEL_WORDS[context.channel] : null;
  if (context.runtimeVersion && channel) return `${context.runtimeVersion} · ${channel}`;
  if (context.runtimeVersion) return `${context.runtimeVersion} and its update channel`;
  return 'Its version and update channel';
}

/**
 * “What’s sent with it”, one line each: the Whombat's version and update channel (the box adds them; named even where
 * the app doesn't know them), this app's version, the device and system in a few words, the language. Another part not
 * known is left out.
 */
export function teamReportSentWith(context: SentWithContext): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [{ label: 'Whombat', value: boxWords(context) }];
  if (context.client)
    rows.push({
      label: CLIENT_WORDS[context.client],
      value: context.appVersion ?? 'version not known',
    });
  if (context.device) rows.push({ label: 'Device', value: context.device });
  if (context.language) rows.push({ label: 'Language', value: context.language });
  return rows;
}

/**
 * “What’s sent with it” folded into one line: “Whombat 0.304.0 · Beta · Web app 3.158.0 · Firefox 146 · Linux · en-GB”,
 * or “Web app 3.158.0 · … · en-GB, and this Whombat’s version and update channel” while the app doesn't know them.
 */
export function teamReportSentWithLine(context: SentWithContext): string {
  const known = !!context.runtimeVersion && !!context.channel;
  const parts = teamReportSentWith(context)
    .filter((r) => known || r.label !== 'Whombat')
    .map((r) => (r.label === 'Device' || r.label === 'Language' ? r.value : `${r.label} ${r.value}`))
    .join(' · ');
  if (known) return parts;
  const box = 'this Whombat’s version and update channel';
  return parts ? `${parts}, and ${box}` : box.charAt(0).toUpperCase() + box.slice(1);
}

/**
 * A browser and its system in a few words from its user agent (“Firefox 146 · Linux”, “Safari 26 · iOS”); null when
 * neither is known.
 */
export function browserDeviceWords(userAgent: string): string | null {
  const ua = userAgent || '';
  const pick = (re: RegExp) => re.exec(ua)?.[1]?.split('.')[0] ?? null;
  const browser = (() => {
    const edge = pick(/Edg(?:e|A|iOS)?\/([\d.]+)/);
    if (edge) return `Edge ${edge}`;
    const opera = pick(/OPR\/([\d.]+)/);
    if (opera) return `Opera ${opera}`;
    const firefox = pick(/(?:Firefox|FxiOS)\/([\d.]+)/);
    if (firefox) return `Firefox ${firefox}`;
    const chrome = pick(/(?:Chrome|CriOS)\/([\d.]+)/);
    if (chrome) return `Chrome ${chrome}`;
    const safari = /Safari\//.test(ua) ? pick(/Version\/([\d.]+)/) : null;
    if (safari) return `Safari ${safari}`;
    return null;
  })();
  const system = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /CrOS/.test(ua)
        ? 'ChromeOS'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  const words = [browser, system].filter(Boolean).join(' · ');
  return words || null;
}
