/**
 * A Google, Microsoft 365 or Email (IMAP) account's page in slots, from what was read with the person's own token:
 *
 * - **Live**: what is left of today's calendar, next first (“in 25 min”); without a calendar, the newest unread mail.
 * - **Inventory**: unread mail, meetings today, how full Drive or OneDrive is (amber from 85 %), how many automations
 *   start on this account's new mail; for Email, when Whombat last counted and the mail server.
 * - **Below**: the newest unread mail beside a calendar, and for Google the files changed last in Drive, each opening in
 *   Drive (Microsoft has none: Graph's list of recent files stops in November 2026).
 * - **Worth a look**: signed out, a count that failed, and Drive or OneDrive almost full from 95 %, which starts off.
 *
 * A service the account doesn't bring leaves its parts out; one that couldn't be read says why in one line, and the page
 * shows the rest. Pure: the reads are `page.ts`'s.
 */
import type { CalendarEvent, ConnectorService, ThingPageItem, ThingPagePanel } from '@whombat/core';
import type { FilesQuota, InboxUnread, RecentFile } from '../../connectors/types';
import { senderName, soonWords, todayLeft } from '../../desk/widgets/account-views';
import { clockIn } from '../../desk/widgets/own';
import { accountName, mailLines, unreadCountWords } from '../../home/mail-glance';
import { countLine, inventory, liveList, slotPanels } from '../kinds/slots';
import { ago, FULL_WARN_PCT, fullTone, usedOf } from '../kinds/storage/shared';
import type { KindView } from '../kinds/types';
import { registerChecks } from '../quiet/defaults';
import type { KindCheck, KindNotice } from '../quiet/types';
import { bytes, cap, clip, pct, plural } from '../words';

export type MailProvider = 'google' | 'microsoft' | 'imap';

/** One part of the page as read: its value and when, or why it couldn't be read. */
export type Part<T> = { ok: true; value: T; at: Date } | { ok: false; problem: string };

export interface MailAccountInput {
  provider: MailProvider;
  email: string;
  services: readonly ConnectorService[];
  /** Signed in (`active`); else nothing is read and the page says what to do. */
  signedIn: boolean;
  /** Null: the account brings no calendar (Email never does). */
  calendar: Part<CalendarEvent[]> | null;
  /** Null: no mail. */
  unread: Part<InboxUnread> | null;
  /** Null: no files (Email never has). */
  quota: Part<FilesQuota> | null;
  /** Google's Drive only; null otherwise. */
  recent: Part<RecentFile[]> | null;
  /** Automations that start on this account's new mail. */
  automations: number;
  /** Email: when Whombat last counted its unread mail, and its mail server. */
  checked?: { at: Date | null; host: string | null };
  /** The health pass's last count failed (`mail.count`). */
  countFailed: boolean;
  now: Date;
  timeZone: string;
}

/** What the page builds from it: the Summary's slots, Worth a look and the head's parts. */
export type MailAccountView = Pick<
  KindView,
  'panels' | 'slots' | 'notices' | 'verdict' | 'readAt' | 'open' | 'problem' | 'refreshS'
>;

/** The check of a nearly full Drive or OneDrive. */
export const SPACE_CHECK = 'files.space';
/** Worth a look from this full; the space line is amber from 85 %. */
export const SPACE_NOTICE_PCT = 95;

/** What Whombat watches on a Google or Microsoft 365 account with its files, besides sign-in and counting. */
export function spaceCheck(provider: 'google' | 'microsoft'): KindCheck {
  return {
    check: SPACE_CHECK,
    name: provider === 'google' ? 'Drive almost full' : 'OneDrive almost full',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  };
}
registerChecks([spaceCheck('google')]);

/** “Drive”, “OneDrive”. */
const driveWord = (provider: MailProvider) => (provider === 'microsoft' ? 'OneDrive' : 'Drive');

/** How full, as a share of the limit; null without one. */
export function quotaPct(q: FilesQuota): number | null {
  return q.total ? (q.used / q.total) * 100 : null;
}

/** Worth a look: Drive or OneDrive almost full, from 95 %. */
export function spaceLine(provider: MailProvider, quota: FilesQuota | null | undefined): KindNotice[] {
  if (provider === 'imap' || !quota?.total) return [];
  const p = quotaPct(quota);
  if (p === null || p < SPACE_NOTICE_PCT) return [];
  const drive = driveWord(provider);
  const full = p >= 100;
  return [
    {
      id: 'space',
      tone: 'warn',
      icon: 'disk',
      title: full ? `${drive} is full` : `${drive} is almost full`,
      detail: `${pct(p)} used · ${usedOf(quota.used, quota.total)} · ${bytes(Math.max(0, quota.total - quota.used))} free`,
      link: {
        kind: 'ask',
        label: 'What takes space',
        question: `My ${provider === 'google' ? 'Google Drive' : 'OneDrive'} is almost full. What takes the most space, and what could go?`,
      },
      nature: 'fyi',
      check: SPACE_CHECK,
      band: full ? 100 : SPACE_NOTICE_PCT,
      ignore: { lifts: 'fixed', words: 'Until there’s room again.' },
    },
  ];
}

const isDate = (t: string) => /^\d{4}-\d{2}-\d{2}$/.test(t);
const allDay = (e: CalendarEvent) => e.allDay || isDate(e.start);

/** Whether the account's person said no to it. */
function declined(e: CalendarEvent, self: string): boolean {
  const me = self.toLowerCase();
  return e.guests.some((g) => g.email.toLowerCase() === me && g.response === 'declined');
}

/** “45 min”, “1 h”, “1 h 30 min”. */
function duration(e: CalendarEvent): string {
  const min = Math.round((Date.parse(e.end) - Date.parse(e.start)) / 60_000);
  if (!Number.isFinite(min) || min <= 0) return '';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

/** Where it is: its place, else the call it has (“Google Meet”, “Teams”, “Zoom”). */
function place(e: CalendarEvent): string {
  if (e.location.trim()) return clip(e.location, 80);
  if (!e.meetUrl) return '';
  const host = (() => {
    try {
      return new URL(e.meetUrl).hostname;
    } catch {
      return '';
    }
  })();
  if (host === 'meet.google.com') return 'Google Meet';
  if (host.endsWith('teams.microsoft.com') || host.endsWith('teams.live.com')) return 'Teams';
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'Zoom';
  return 'Video call';
}

const httpsOnly = (url: string | null | undefined) => (url?.startsWith('https://') ? { url } : {});
const joined = (parts: readonly string[]) => parts.filter(Boolean).join(' · ');

/** Today, in slots' Live: what is left, all-day items first, then each meeting by its start; the next one marked. */
function todayPanel(events: readonly CalendarEvent[], self: string, now: Date, timeZone: string) {
  const left = todayLeft(events, self, now, timeZone);
  const timed = left.filter((e) => !allDay(e));
  const next = timed.find((e) => Date.parse(e.start) > now.getTime());
  const items = left.slice(0, 6).map((e, i): ThingPageItem => {
    if (allDay(e))
      return {
        id: `event-${i}`,
        title: clip(e.summary, 160) || 'Busy',
        icon: 'clock',
        right: 'All day',
        ...(place(e) ? { detail: place(e) } : {}),
        ...httpsOnly(e.webUrl),
      };
    const start = new Date(e.start);
    const started = start.getTime() <= now.getTime();
    const detail = started
      ? joined([`Until ${clockIn(new Date(e.end), timeZone)}`, place(e)])
      : joined([duration(e), place(e)]);
    return {
      id: `event-${i}`,
      title: clip(e.summary, 160) || 'Busy',
      icon: 'clock',
      at: start.toISOString(),
      right: soonWords(start, now),
      ...(detail ? { detail: clip(detail, 300) } : {}),
      ...(started ? { tone: 'ok' as const } : e === next ? { tone: 'info' as const } : {}),
      ...httpsOnly(e.webUrl),
    };
  });
  return liveList({
    id: 'today',
    title: 'Today',
    meta: timed.length ? `${timed.length} left` : 'Nothing left',
    items,
    empty: 'No more meetings today.',
  });
}

/** The newest unread mail: subject, who, when, each opening in the mail app when the provider says where. */
function mailItems(unread: InboxUnread, now: Date): ThingPageItem[] {
  if (unread.count === 0) return [];
  return unread.newest.slice(0, 5).map((m, i) => {
    const when = Date.parse(m.date);
    const who = clip(senderName(m.from), 300);
    return {
      id: `mail-${i}`,
      title: clip(m.subject, 160) || 'No subject',
      ...(who ? { detail: who } : {}),
      ...(Number.isFinite(when) ? { at: new Date(when).toISOString(), right: ago(new Date(when), now) } : {}),
      ...httpsOnly(m.webUrl),
    };
  });
}

/** Unread mail: Live without a calendar, else below the slots. */
function unreadPanel(unread: InboxUnread, now: Date, id: 'unread' | 'unread-mail') {
  return {
    kind: 'list' as const,
    id,
    title: 'Unread mail',
    meta: `${unreadCountWords(unread.count)} unread`,
    items: mailItems(unread, now),
    empty: 'No unread mail.',
  };
}

const FILE_WORDS: Record<RecentFile['kind'], string> = {
  doc: 'Google Docs',
  sheet: 'Google Sheets',
  slides: 'Google Slides',
  folder: 'Folder',
  pdf: 'PDF',
  text: 'Text',
  image: 'Picture',
  other: 'File',
};
const FILE_ICONS: Record<RecentFile['kind'], ThingPageItem['icon']> = {
  doc: 'log',
  sheet: 'database',
  slides: 'media',
  folder: 'disk',
  pdf: 'log',
  text: 'log',
  image: 'photo',
  other: 'log',
};

/** Changed lately in Drive: the newest few, what each is and who changed it, each opening in Drive. */
function filesPanel(files: readonly RecentFile[], now: Date): ThingPagePanel | null {
  if (!files.length) return null;
  return {
    kind: 'list',
    id: 'files',
    title: 'Changed lately',
    meta: 'In Drive',
    items: files.slice(0, 5).map((f, i) => {
      const at = f.modifiedAt ? Date.parse(f.modifiedAt) : Number.NaN;
      const who = f.byMe ? 'you' : (f.by ?? '');
      return {
        id: `file-${i}`,
        title: clip(f.name, 160) || 'Untitled',
        detail: joined([FILE_WORDS[f.kind], who]),
        icon: FILE_ICONS[f.kind],
        ...(Number.isFinite(at) ? { at: new Date(at).toISOString(), right: ago(new Date(at), now) } : {}),
        ...httpsOnly(f.webUrl),
      };
    }),
  };
}

/** The space line of Inventory: used of the limit, amber from 85 %. */
function spaceCount(provider: MailProvider, q: FilesQuota): ThingPageItem {
  const p = quotaPct(q);
  const tone = p !== null && p >= FULL_WARN_PCT ? fullTone(p) : undefined;
  return countLine({
    id: 'space',
    title: `${driveWord(provider)} space`,
    icon: 'disk',
    detail: q.total ? usedOf(q.used, q.total) : 'No limit',
    value: p !== null ? pct(p) : bytes(q.used),
    ...(tone ? { tone, noteTone: tone } : {}),
  });
}

/** “4 unread mails”, “1 unread mail”, “No unread mail”. */
function mailWords(count: number): string {
  if (count === 0) return 'No unread mail';
  return count === 1 ? '1 unread mail' : `${unreadCountWords(count)} unread mails`;
}

/** “2 meetings left today”, “no more meetings today”. */
function meetingWords(left: number): string {
  if (left === 0) return 'no more meetings today';
  return `${plural(left, 'meeting')} left today`;
}

/** The sentence under the name while all is well. */
function verdictOf(
  input: MailAccountInput,
  unread: InboxUnread | null,
  left: number | null,
  space: string | null,
): string | undefined {
  if (input.provider === 'imap') return unread ? `${mailWords(unread.count)} in your inbox.` : undefined;
  if (unread && left !== null) return `${mailWords(unread.count)}, and ${meetingWords(left)}.`;
  if (unread) return `${mailWords(unread.count)} in your inbox.`;
  if (left !== null) return `${cap(meetingWords(left))}.`;
  return space ?? undefined;
}

/** Where the account opens: its mail, else its calendar, else its files. */
function openOf(input: MailAccountInput): { label: string; url: string } | undefined {
  const has = (s: ConnectorService) => input.services.includes(s);
  if (input.provider === 'google') {
    if (has('mail')) return { label: 'Open Gmail', url: 'https://mail.google.com/' };
    if (has('calendar')) return { label: 'Open Calendar', url: 'https://calendar.google.com/' };
    if (has('files')) return { label: 'Open Drive', url: 'https://drive.google.com/' };
    return undefined;
  }
  if (input.provider === 'microsoft') {
    if (has('mail')) return { label: 'Open Outlook', url: 'https://outlook.office.com/mail/' };
    if (has('calendar')) return { label: 'Open Calendar', url: 'https://outlook.office.com/calendar/' };
    return { label: 'Open Microsoft 365', url: 'https://www.microsoft365.com/' };
  }
  return undefined;
}

/** The words for an account that isn't signed in: what to do, and that the page waits for it. */
export function signedOutWords(provider: MailProvider): string {
  return provider === 'imap'
    ? 'Type your email password again to see your mail here.'
    : `Sign in to ${accountName(provider)} again to see your mail and calendar here.`;
}

/** The account's Summary in slots, its Worth a look and its head's parts. */
export function mailAccountView(input: MailAccountInput): MailAccountView {
  const { provider, now, timeZone } = input;
  const calendar = input.calendar?.ok ? input.calendar : null;
  const unread = input.unread?.ok ? input.unread : null;
  const quota = input.quota?.ok ? input.quota : null;
  const recent = input.recent?.ok ? input.recent : null;

  const events = calendar ? calendar.value.filter((e) => !declined(e, input.email)) : [];
  const timedToday = events.filter((e) => !allDay(e));
  const left = calendar
    ? todayLeft(calendar.value, input.email, now, timeZone).filter((e) => !allDay(e)).length
    : null;

  const live = calendar
    ? todayPanel(calendar.value, input.email, now, timeZone)
    : unread
      ? liveList(unreadPanel(unread.value, now, 'unread'))
      : null;

  const lines: ThingPageItem[] = [];
  if (unread)
    lines.push(
      countLine({
        id: 'unread',
        title: 'Unread mail',
        icon: 'log',
        detail: 'In your inbox',
        value: unreadCountWords(unread.value.count),
      }),
    );
  if (calendar)
    lines.push(
      countLine({
        id: 'meetings',
        title: 'Meetings today',
        icon: 'clock',
        detail: left === 0 ? 'None left' : `${left} left`,
        value: String(timedToday.length),
      }),
    );
  if (quota && provider !== 'imap') lines.push(spaceCount(provider, quota.value));
  if (input.services.includes('mail'))
    lines.push(
      countLine({
        id: 'automations',
        title: 'Automations',
        icon: 'update',
        detail: 'Start on new mail',
        value: String(input.automations),
      }),
    );
  if (provider === 'imap' && input.checked)
    lines.push(
      countLine({
        id: 'checked',
        title: 'Checked',
        icon: 'clock',
        ...(input.checked.host ? { detail: input.checked.host } : {}),
        value: input.checked.at ? ago(input.checked.at, now) : 'Not yet',
      }),
    );

  const more: ThingPagePanel[] = [];
  if (calendar && unread) more.push(unreadPanel(unread.value, now, 'unread-mail'));
  const files = provider === 'google' && recent ? filesPanel(recent.value, now) : null;
  if (files) more.push(files);

  const parts = [input.calendar, input.unread, input.quota, input.recent];
  const failed = parts.find((p): p is { ok: false; problem: string } => !!p && !p.ok);
  const problem = !input.signedIn ? signedOutWords(provider) : failed?.problem;
  const times = parts.flatMap((p) => (p?.ok ? [p.at.getTime()] : []));
  const space =
    quota && provider !== 'imap' && quota.value.total
      ? `${pct(quotaPct(quota.value) ?? 0)} of your ${driveWord(provider)} space is used.`
      : null;
  const verdict = verdictOf(input, unread?.value ?? null, left, space);

  const open = openOf(input);
  return {
    ...slotPanels({
      live,
      inventory: lines.length ? inventory({ id: 'account', title: titleOf(provider), items: lines }) : null,
      more,
    }),
    notices: [
      ...mailLines({ provider, status: input.signedIn ? 'active' : 'needs_reauth' }, input.countFailed),
      ...(quota ? spaceLine(provider, quota.value) : []),
    ],
    ...(verdict ? { verdict } : {}),
    readAt: times.length ? new Date(Math.min(...times)) : null,
    ...(open ? { open } : {}),
    ...(problem ? { problem } : {}),
    refreshS: 60,
  };
}

/** Inventory's title: “In your account”, “In your mailbox”. */
const titleOf = (provider: MailProvider) => (provider === 'imap' ? 'In your mailbox' : 'In your account');
