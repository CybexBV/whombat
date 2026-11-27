/**
 * Reports to the Whombat Team (Whombat docs/decisions/team-reports.md), the same on the web and the phone: whether the
 * entry shows, the list's order and folds, a report's conversation in time order with its status changes, the
 * four-step track, what is sent with a new report, the assistant's draft card's Edit, and the words people read. Pure.
 */
import {
  type Approval,
  TEAM_REPORT_DRAFT_ACTION,
  TEAM_REPORT_STAGES,
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
  teamReportStatusWords,
} from '@whombat/core';
import { formatLocaleOf } from '@whombat/core/i18n';
import { type ProtocolVersion, protocolAtLeast, TEAM_REPORTS_MINOR } from '@whombat/protocol/session';
import { formatDay, formatRelativeDay, formatTime } from './hosts/format';
import { clientTranslator, EN } from './i18n/catalog';

/** Where a security problem goes instead: privately, on GitHub. */
export const TEAM_REPORT_SECURITY_URL = 'https://github.com/CybexBV/whombat/security/advisories/new';

export const TEAM_REPORT_WORDS = {
  entry: EN['reports.entry'],
  title: EN['reports.title'],
  intro: EN['reports.intro'],
  newReport: EN['reports.newReport'],
  empty: EN['reports.empty'],
  stale: EN['reports.stale'],
  loading: EN['reports.loading'],
  updateFirst: EN['reports.updateFirst'],
  listFailed: EN['reports.listFailed'],
  tryAgain: EN['reports.tryAgain'],
  open: EN['reports.open'],
  closed: EN['reports.closed'],
  showClosed: EN['reports.showClosed'],
  hideClosed: EN['reports.hideClosed'],
  unread: EN['reports.unread'],
  back: EN['reports.back'],
  // The form.
  formTitle: EN['reports.formTitle'],
  kindQuestion: EN['reports.kindQuestion'],
  kinds: {
    bug: { title: EN['reports.kind.bug.title'], hint: EN['reports.kind.bug.hint'] },
    idea: { title: EN['reports.kind.idea.title'], hint: EN['reports.kind.idea.hint'] },
  },
  textLabel: { bug: EN['reports.textLabel.bug'], idea: EN['reports.textLabel.idea'] },
  expectedLabel: EN['reports.expectedLabel'],
  optional: EN['reports.optional'],
  sentWith: EN['reports.sentWith'],
  sentWithNothingElse: EN['reports.sentWithNothingElse'],
  warning: EN['reports.warning'],
  securityQuestion: EN['reports.securityQuestion'],
  securityLink: EN['reports.securityLink'],
  send: EN['reports.send'],
  sending: EN['reports.sending'],
  sent: EN['reports.sent'],
  draftDone: EN['reports.draftDone'],
  /** The assistant's card: opens the form with its draft, to change it before sending. */
  edit: EN['reports.edit'],
  draftFailed: EN['reports.draftFailed'],
  // A report's page.
  you: EN['reports.you'],
  team: EN['reports.team'],
  expected: EN['reports.expected'],
  progress: EN['reports.progress'],
  reply: EN['reports.reply'],
  replySend: EN['reports.send'],
  confirmQuestion: EN['reports.confirmQuestion'],
  works: EN['reports.works'],
  stillHappening: EN['reports.stillHappening'],
  more: EN['reports.more'],
  withdraw: EN['reports.withdraw'],
  withdrawConfirm: EN['reports.withdrawConfirm'],
  withdrawn: EN['reports.withdrawn'],
  cancel: EN['reports.cancel'],
  notFound: EN['reports.notFound'],
  reportFailed: EN['reports.reportFailed'],
  /** Above a conversation too long for one answer: its oldest messages aren't here. */
  earlier: EN['reports.earlier'],
  failed: EN['reports.failed'],
  full: EN['reports.full'],
} as const;

export function teamReportWords(locale?: string | null) {
  const tr = clientTranslator(locale);
  if (tr.language === 'en') return TEAM_REPORT_WORDS;
  return {
    entry: tr.t('reports.entry'),
    title: tr.t('reports.title'),
    intro: tr.t('reports.intro'),
    newReport: tr.t('reports.newReport'),
    empty: tr.t('reports.empty'),
    stale: tr.t('reports.stale'),
    loading: tr.t('reports.loading'),
    updateFirst: tr.t('reports.updateFirst'),
    listFailed: tr.t('reports.listFailed'),
    tryAgain: tr.t('reports.tryAgain'),
    open: tr.t('reports.open'),
    closed: tr.t('reports.closed'),
    showClosed: tr.t('reports.showClosed'),
    hideClosed: tr.t('reports.hideClosed'),
    unread: tr.t('reports.unread'),
    back: tr.t('reports.back'),
    formTitle: tr.t('reports.formTitle'),
    kindQuestion: tr.t('reports.kindQuestion'),
    kinds: {
      bug: {
        title: tr.t('reports.kind.bug.title'),
        hint: tr.t('reports.kind.bug.hint'),
      },
      idea: {
        title: tr.t('reports.kind.idea.title'),
        hint: tr.t('reports.kind.idea.hint'),
      },
    },
    textLabel: {
      bug: tr.t('reports.textLabel.bug'),
      idea: tr.t('reports.textLabel.idea'),
    },
    expectedLabel: tr.t('reports.expectedLabel'),
    optional: tr.t('reports.optional'),
    sentWith: tr.t('reports.sentWith'),
    sentWithNothingElse: tr.t('reports.sentWithNothingElse'),
    warning: tr.t('reports.warning'),
    securityQuestion: tr.t('reports.securityQuestion'),
    securityLink: tr.t('reports.securityLink'),
    send: tr.t('reports.send'),
    sending: tr.t('reports.sending'),
    sent: tr.t('reports.sent'),
    draftDone: tr.t('reports.draftDone'),
    edit: tr.t('reports.edit'),
    draftFailed: tr.t('reports.draftFailed'),
    you: tr.t('reports.you'),
    team: tr.t('reports.team'),
    expected: tr.t('reports.expected'),
    progress: tr.t('reports.progress'),
    reply: tr.t('reports.reply'),
    replySend: tr.t('reports.send'),
    confirmQuestion: tr.t('reports.confirmQuestion'),
    works: tr.t('reports.works'),
    stillHappening: tr.t('reports.stillHappening'),
    more: tr.t('reports.more'),
    withdraw: tr.t('reports.withdraw'),
    withdrawConfirm: tr.t('reports.withdrawConfirm'),
    withdrawn: tr.t('reports.withdrawn'),
    cancel: tr.t('reports.cancel'),
    notFound: tr.t('reports.notFound'),
    reportFailed: tr.t('reports.reportFailed'),
    earlier: tr.t('reports.earlier'),
    failed: tr.t('reports.failed'),
    full: tr.t('reports.full'),
  };
}

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
  bug: EN['reports.kindWord.bug'],
  idea: EN['reports.kindWord.idea'],
};

export function teamReportKindWords(locale?: string | null): Readonly<Record<TeamReportKind, string>> {
  const tr = clientTranslator(locale);
  return { bug: tr.t('reports.kindWord.bug'), idea: tr.t('reports.kindWord.idea') };
}

/** Why a new report can't be sent now, in the person's words (`reason`); null when it can. */
export function teamReportsUnavailableText(
  reason: TeamReportsReason | null,
  locale?: string | null,
): string | null {
  return reason ? clientTranslator(locale).t(`reports.unavailable.${reason}`) : null;
}

/**
 * Whether the entry shows (“Report a problem or idea”): only on a Whombat that speaks reports (session minor 11), and
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
export function teamReportsSummary(
  rows: readonly Pick<TeamReportRow, 'unread'>[],
  locale?: string | null,
): string {
  const tr = clientTranslator(locale);
  if (!rows.length) return tr.t('reports.summaryNone');
  const count = tr.tp('reports.summaryCount', rows.length);
  const unread = teamReportsUnread(rows);
  return unread ? `${count} · ${tr.tp('reports.summaryUnread', unread)}` : count;
}

/** A row's line under its title. */
export function teamReportRowLine(
  row: Pick<TeamReportRow, 'number' | 'kind' | 'status'>,
  locale?: string | null,
): string {
  return `#${row.number} · ${teamReportKindWords(locale)[row.kind]} · ${teamReportStatusWords(locale)[row.status]}`;
}

/** A row's name for screen readers: its title, its status, and whether something is new. */
export function teamReportRowLabel(
  row: Pick<TeamReportRow, 'title' | 'status' | 'unread'>,
  locale?: string | null,
): string {
  return [
    row.title,
    teamReportStatusWords(locale)[row.status],
    row.unread ? teamReportWords(locale).unread : null,
  ]
    .filter(Boolean)
    .join(', ');
}

const DAY_MS = 86_400_000;

/** A list's time: “14:05” today, “Yesterday”, a weekday within the week, else “6 Oct”. Seconds since 1970. */
export function teamReportWhen(at: number, now: number, timeZone?: string, locale?: string | null): string {
  const t = at * 1000;
  const today = formatDay(now, timeZone, locale);
  if (formatDay(t, timeZone, locale) === today && Math.abs(now - t) < DAY_MS) return formatTime(t, timeZone);
  if (formatDay(now - DAY_MS, timeZone, locale) === formatDay(t, timeZone, locale))
    return clientTranslator(locale).t('reports.yesterday');
  if (now - t < 6 * DAY_MS && now >= t)
    return new Intl.DateTimeFormat(formatLocaleOf(locale), {
      weekday: 'short',
      ...(timeZone ? { timeZone } : {}),
    }).format(t);
  return formatDay(t, timeZone, locale);
}

/** A conversation's time: “Today 14:05”, “Yesterday 09:12”, “Mon 08:00”, “4 Oct, 02:00”. Seconds since 1970. */
export function teamReportMessageWhen(
  at: number,
  now: number,
  timeZone?: string,
  locale?: string | null,
): string {
  return formatRelativeDay(at * 1000, now, timeZone, locale);
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
  locale?: string | null,
) {
  const words = teamReportWords(locale);
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
        words: teamReportStatusLine(m.status, m.author, locale),
      });
    if (m.text.trim())
      entries.push({
        kind: 'message',
        key: m.id,
        at: m.at,
        author: m.author,
        who: m.author === 'team' ? words.team : words.you,
        text: m.text,
      });
  });
  return entries;
}

/** A status change in the conversation: the team's as the new status, the person's press as what they said. */
export function teamReportStatusLine(
  status: TeamReportStatus,
  author: 'reporter' | 'team' = 'team',
  locale?: string | null,
): string {
  const tr = clientTranslator(locale);
  if (author === 'reporter') {
    if (status === 'confirmed') return tr.t('reports.youWorks');
    if (teamReportOpen(status)) return tr.t('reports.youStill');
  }
  return tr.t('reports.statusLine', { status: teamReportStatusWords(locale)[status] });
}

function teamReportStages(locale?: string | null): readonly [string, string, string, string] {
  const tr = clientTranslator(locale);
  if (tr.language === 'en') return TEAM_REPORT_STAGES;
  return [tr.t('reports.stage.0'), tr.t('reports.stage.1'), tr.t('reports.stage.2'), tr.t('reports.stage.3')];
}

export type TeamReportStepState = 'done' | 'current' | 'ahead';

/**
 * The four-step track (Received → Looking into it → Being fixed → Fixed) for a status: the steps behind it done, its
 * own current while the team works on it. Received and Fixed are done once reached; a report that ended without a fix
 * stays where it got to, done.
 */
export function teamReportTrack(
  status: TeamReportStatus,
  locale?: string | null,
): { label: string; state: TeamReportStepState }[] {
  const stage = teamReportStage(status);
  const ended = !teamReportOpen(status);
  return teamReportStages(locale).map((label, i) => ({
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
export function teamReportTrackLabel(status: TeamReportStatus, locale?: string | null): string {
  const stage = teamReportStage(status);
  const stages = teamReportStages(locale);
  return clientTranslator(locale).t('reports.trackLabel', {
    step: stage + 1,
    total: stages.length,
    label: stages[stage],
  });
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

type SentWithContext = Pick<
  TeamReportContext,
  'runtimeVersion' | 'channel' | 'client' | 'appVersion' | 'device' | 'language'
>;

/**
 * What the box adds about itself, its version and update channel, in the words the app knows: “0.304.0 · Beta”, or
 * what it doesn't know named (“0.304.0 and its update channel”). The box always adds both.
 */
function boxWords(context: SentWithContext, locale?: string | null): string {
  const tr = clientTranslator(locale);
  const channel = context.channel ? tr.t(`reports.channel.${context.channel}`) : null;
  if (context.runtimeVersion && channel) return `${context.runtimeVersion} · ${channel}`;
  if (context.runtimeVersion)
    return tr.t('reports.boxVersionAndChannel', { version: context.runtimeVersion });
  return tr.t('reports.boxUnknown');
}

function sentWithRows(context: SentWithContext, locale?: string | null) {
  const tr = clientTranslator(locale);
  const rows: { kind: 'box' | 'client' | 'device' | 'language'; label: string; value: string }[] = [
    { kind: 'box', label: 'Whombat', value: boxWords(context, locale) },
  ];
  if (context.client)
    rows.push({
      kind: 'client',
      label: tr.t(`reports.client.${context.client}`),
      value: context.appVersion ?? tr.t('reports.versionUnknown'),
    });
  if (context.device) rows.push({ kind: 'device', label: tr.t('reports.device'), value: context.device });
  if (context.language)
    rows.push({ kind: 'language', label: tr.t('reports.language'), value: context.language });
  return rows;
}

/**
 * “What’s sent with it”, one line each: the Whombat's version and update channel (the box adds them; named even where
 * the app doesn't know them), this app's version, the device and system in a few words, the language. Another part not
 * known is left out.
 */
export function teamReportSentWith(
  context: SentWithContext,
  locale?: string | null,
): { label: string; value: string }[] {
  return sentWithRows(context, locale).map(({ label, value }) => ({ label, value }));
}

/**
 * “What’s sent with it” folded into one line: “Whombat 0.304.0 · Beta · Web app 3.158.0 · Firefox 146 · Linux · en-GB”,
 * or “Web app 3.158.0 · … · en-GB, and this Whombat’s version and update channel” while the app doesn't know them.
 */
export function teamReportSentWithLine(context: SentWithContext, locale?: string | null): string {
  const known = !!context.runtimeVersion && !!context.channel;
  const parts = sentWithRows(context, locale)
    .filter((r) => known || r.kind !== 'box')
    .map((r) => (r.kind === 'device' || r.kind === 'language' ? r.value : `${r.label} ${r.value}`))
    .join(' · ');
  if (known) return parts;
  const tr = clientTranslator(locale);
  const box = tr.t('reports.thisBoxVersionAndChannel');
  return parts ? tr.t('reports.sentWithAnd', { parts, box }) : box.charAt(0).toUpperCase() + box.slice(1);
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
