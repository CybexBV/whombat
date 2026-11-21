/**
 * The person's own accounts as widgets (docs/decisions/desk-display.md DK-159; desk-display-server.md DK-S250…): what
 * each account offers in *Add a widget*, and each widget's view from what was read. A Google or Microsoft 365 account
 * with its calendar has *Today* and *Next meeting*; one with its mail, and an Email (IMAP) account, *Unread mail*; the
 * Whombat's GitHub *Pull requests* and *Waiting for review*. Pure: the reads are `accounts.ts`'s.
 */
import {
  type CalendarEvent,
  type ConnectorProvider,
  type ConnectorService,
  DESK_ACCOUNT_GITHUB,
  DESK_VIEW_ROWS_MAX,
  type DeskCatalogGroup,
  type DeskCatalogItem,
  type DeskViewRow,
  type DeskViewTone,
  type DeskWidgetSpec,
  type DeskWidgetView,
  type MailSummary,
} from '@whombat/core';
import { unreadCountWords } from '../../home/mail-glance';
import { startOfLocalDay, tomorrowAt } from '../../home/time';
import { screenText } from '../glance';
import { clockIn } from './own';
import type { Resolved } from './types';

/** An account's widgets, each a `panel` with this `opts.panel`. */
export const ACCOUNT_PANELS = ['today', 'next', 'unread', 'pulls', 'reviews'] as const;
export type AccountPanel = (typeof ACCOUNT_PANELS)[number];

/** How often each is drawn again from what's kept (seconds): *Next meeting*'s “in 12 min” moves every minute. */
export const ACCOUNT_REFRESH_S: Record<AccountPanel, number> = {
  today: 60,
  next: 60,
  unread: 120,
  pulls: 60,
  reviews: 60,
};

/** What a connected account is, as the widgets need it. */
export interface AccountInfo {
  /** `account:<connections.id>`. */
  ref: string;
  provider: ConnectorProvider;
  email: string;
  services: readonly ConnectorService[];
}

/** An open pull request as the mirror knows it. */
export interface AccountPull {
  /** The repository's short name (“web”, not “lumio/web”). */
  repo: string;
  number: number;
  title: string;
  /** Who opened it, as GitHub or Whombat names them; null when the mirror doesn't know. */
  author: string | null;
  draft: boolean;
  openedAt: Date;
  /** Its head's checks: passing, failing, still going, or none known. */
  checks: 'passing' | 'failing' | 'running' | null;
  /** The people asked to review it who haven't yet, with whether the screen's person is one of them. */
  waitingOn: readonly { name: string; viewer: boolean }[];
}

export const ACCOUNT_WORDS = {
  provider: { google: 'Google', microsoft: 'Microsoft 365', imap: 'Email', github: 'GitHub' },
  panels: {
    today: { name: 'Today', line: 'What’s left of today’s meetings, each at its time' },
    next: { name: 'Next meeting', line: 'What’s next, when, where and in how long' },
    unread: { name: 'Unread mail', line: 'How many unread in the inbox, and the newest' },
    pulls: { name: 'Pull requests', line: 'What’s open, whose, and whether its checks pass' },
    reviews: { name: 'Waiting for review', line: 'Pull requests someone was asked to review' },
  },
  allDay: 'All day',
  now: 'Now',
  until: 'until {time}',
  left: '{n} left today',
  nothingToday: 'Nothing else today.',
  noMeetings: 'No more meetings today.',
  busy: 'Busy',
  withOne: 'with 1 other',
  withMany: 'with {n} others',
  unread: '{n} unread',
  noUnread: 'No unread mail.',
  noSubject: 'No subject',
  open: '{n} open',
  noPulls: 'No open pull requests.',
  draft: 'Draft',
  checks: { passing: 'Checks pass', failing: 'Checks fail', running: 'Checks running' },
  waiting: '{n} waiting',
  waitingFor: 'Waiting for {names}',
  you: 'you',
  noReviews: 'Nobody’s waiting for a review.',
  /** Why a widget can't show. */
  problems: {
    gone: 'This account isn’t connected any more.',
    signIn: 'Sign in to {provider} again in Settings.',
    password: 'Type your email password again in Settings.',
    noCalendar: 'Its calendar isn’t connected. Turn it on in Settings.',
    noMail: 'Its mail isn’t connected. Turn it on in Settings.',
    notAllowed: '{provider} didn’t allow this. Connect it again in Settings.',
    notAnswering: '{provider} isn’t answering right now.',
    noRepos: 'This Whombat has no repositories yet.',
    unknown: 'This account has no widget like that.',
  },
} as const;

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));

/** What an account is called in a widget: “Google”, “Microsoft 365”, “Email”, “GitHub”. */
export function providerWord(provider: ConnectorProvider | 'github'): string {
  return ACCOUNT_WORDS.provider[provider];
}

/** Its brand mark (`@whombat/brand`): Google's G, Microsoft's squares, the envelope, GitHub's cat. */
export function accountMark(provider: ConnectorProvider | 'github'): string {
  return provider === 'imap' ? 'imap' : provider;
}

/** The widgets an account offers: calendar ones where its calendar is connected, mail where its mail is. */
export function accountPanels(
  account: Pick<AccountInfo, 'provider' | 'services'> | 'github',
): AccountPanel[] {
  if (account === 'github') return ['pulls', 'reviews'];
  const out: AccountPanel[] = [];
  if (account.provider !== 'imap' && account.services.includes('calendar')) out.push('today', 'next');
  if (account.services.includes('mail')) out.push('unread');
  return out;
}

/**
 * Which of an account's widgets a spec is: a panel names it; an account's *Figures* is its first that is a figure (the
 * next meeting) or else its first; null when it has none like that.
 */
export function accountPanelOf(spec: Pick<DeskWidgetSpec, 'type' | 'opts'>, panels: readonly AccountPanel[]) {
  if (spec.type === 'figures') return panels.includes('next') ? 'next' : (panels[0] ?? null);
  const panel = spec.opts?.panel as AccountPanel | undefined;
  return panel && panels.includes(panel) ? panel : null;
}

/** Calendar and mail show what a passer-by shouldn't read; so does someone's review queue (DK-157). */
export const isPrivatePanel = (panel: AccountPanel) => panel !== 'pulls';

const PANEL_VIEWS: Record<AccountPanel, DeskCatalogItem['view']> = {
  today: 'list',
  next: 'figures',
  unread: 'list',
  pulls: 'list',
  reviews: 'list',
};

/** *Your accounts* in *Add a widget*: one group per account, “Google · anna@example.com”, with its widgets. */
export function accountGroup(account: AccountInfo | 'github'): DeskCatalogGroup | null {
  const panels = accountPanels(account);
  if (panels.length === 0) return null;
  const provider = account === 'github' ? 'github' : account.provider;
  const ref = account === 'github' ? DESK_ACCOUNT_GITHUB : account.ref;
  const mark = accountMark(provider);
  const label =
    account === 'github'
      ? providerWord('github')
      : screenText(`${providerWord(provider)} · ${account.email}`, 80) || providerWord(provider);
  return {
    key: ref,
    thing: ref,
    label,
    mark,
    items: panels.map((panel) => ({
      type: 'panel' as const,
      ref,
      opts: { panel },
      name: ACCOUNT_WORDS.panels[panel].name,
      line: ACCOUNT_WORDS.panels[panel].line,
      mark,
      view: PANEL_VIEWS[panel],
      ...(isPrivatePanel(panel) ? { private: true } : {}),
    })),
  };
}

/** The common parts of an account widget's view. */
function base(id: string, panel: AccountPanel, provider: ConnectorProvider | 'github') {
  return {
    id,
    title: ACCOUNT_WORDS.panels[panel].name,
    name: providerWord(provider),
    mark: accountMark(provider),
  };
}

/** A widget that can't show says why, in plain words; the words name nothing private. */
export function accountProblemView(
  id: string,
  panel: AccountPanel | null,
  provider: ConnectorProvider | 'github',
  text: string,
): Resolved {
  const title = panel ? ACCOUNT_WORDS.panels[panel].name : providerWord(provider);
  const words = screenText(text, 120);
  return {
    view: {
      kind: 'text',
      id,
      title,
      name: providerWord(provider),
      mark: accountMark(provider),
      tone: 'off',
      body: words,
      problem: { text: words },
    },
    private: false,
    refreshS: 60,
  };
}

/* Calendar ----------------------------------------------------------------------------------------- */

const isDate = (t: string) => /^\d{4}-\d{2}-\d{2}$/.test(t);

/** The day in the zone (“2026-10-28”). */
function dayIn(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** Whether the screen's person said no to it. */
function declined(e: CalendarEvent, self: string): boolean {
  const me = self.toLowerCase();
  return e.guests.some((g) => g.email.toLowerCase() === me && g.response === 'declined');
}

/**
 * What's left of today in the person's zone: today's all-day items, then each meeting not over yet that starts before
 * tomorrow, by its start; none the person declined.
 */
export function todayLeft(
  events: readonly CalendarEvent[],
  self: string,
  now: Date,
  timeZone: string,
): CalendarEvent[] {
  const today = dayIn(now, timeZone);
  const tomorrow = tomorrowAt(now, timeZone, 0, 0).getTime();
  const allDay: CalendarEvent[] = [];
  const timed: CalendarEvent[] = [];
  for (const e of events) {
    if (declined(e, self)) continue;
    if (e.allDay || isDate(e.start)) {
      const start = e.start.slice(0, 10);
      const end = e.end.slice(0, 10);
      // An all-day item's end is the day after its last.
      if (start <= today && (end > today || end === start)) allDay.push(e);
      continue;
    }
    const start = Date.parse(e.start);
    const end = Date.parse(e.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end > now.getTime() && start < tomorrow) timed.push(e);
  }
  timed.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return [...allDay, ...timed];
}

/** Today's window as the calendar is asked for it: the start of today to the start of tomorrow, in the zone. */
export function todayWindow(now: Date, timeZone: string): { from: string; to: string; day: string } {
  return {
    from: startOfLocalDay(now, timeZone).toISOString(),
    to: tomorrowAt(now, timeZone, 0, 0).toISOString(),
    day: dayIn(now, timeZone),
  };
}

/** “with 3 others”: who else is in it (not the person, nor a room). */
function withOthers(e: CalendarEvent, self: string): string {
  const me = self.toLowerCase();
  const n = e.guests.filter(
    (g) => g.email.toLowerCase() !== me && !g.email.endsWith('resource.calendar.google.com'),
  ).length;
  if (n === 0) return '';
  return n === 1 ? ACCOUNT_WORDS.withOne : fill(ACCOUNT_WORDS.withMany, { n });
}

const titleOf = (e: CalendarEvent, max: number) => screenText(e.summary, max) || ACCOUNT_WORDS.busy;
const joined = (parts: readonly string[], max: number) => screenText(parts.filter(Boolean).join(' · '), max);

/** *Today*: what's left of today, each meeting at its time (“10:00” “Standup” “Room 3 · with 3 others”). */
export function todayView(
  id: string,
  provider: ConnectorProvider,
  input: { events: readonly CalendarEvent[]; self: string; now: Date; timeZone: string; at?: Date },
): DeskWidgetView {
  const left = todayLeft(input.events, input.self, input.now, input.timeZone);
  const timed = left.filter((e) => !(e.allDay || isDate(e.start))).length;
  const rows: DeskViewRow[] = left.slice(0, DESK_VIEW_ROWS_MAX).map((e) => {
    const detail = joined([screenText(e.location, 80), withOthers(e, input.self)], 120);
    if (e.allDay || isDate(e.start))
      return { title: titleOf(e, 120), meta: ACCOUNT_WORDS.allDay, ...(detail ? { detail } : {}) };
    const started = Date.parse(e.start) <= input.now.getTime();
    return {
      title: titleOf(e, 120),
      time: clockIn(new Date(e.start), input.timeZone),
      ...(detail ? { detail } : {}),
      ...(started
        ? {
            meta: screenText(
              `${ACCOUNT_WORDS.now} · ${fill(ACCOUNT_WORDS.until, { time: clockIn(new Date(e.end), input.timeZone) })}`,
              40,
            ),
            tone: 'ok' as const,
          }
        : {}),
    };
  });
  return {
    kind: 'list',
    ...base(id, 'today', provider),
    ...(timed > 0 ? { head: fill(ACCOUNT_WORDS.left, { n: timed }) } : {}),
    rows,
    ...(left.length > rows.length ? { count: left.length } : {}),
    empty: ACCOUNT_WORDS.nothingToday,
    ...(input.at ? { at: input.at.toISOString() } : {}),
  };
}

/** “in 12 min”, “in 2 h 5 min”, “Now”. */
export function soonWords(start: Date, now: Date): string {
  const minutes = Math.ceil((start.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return ACCOUNT_WORDS.now;
  if (minutes < 60) return `in ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `in ${h} h ${m} min` : `in ${h} h`;
}

/**
 * *Next meeting*: the meeting the person is in or comes next today, as a figure: how soon (“in 12 min”, “Now”) over
 * what it is, and a line with when, where and how many with it; when there's none, it says so.
 */
export function nextView(
  id: string,
  provider: ConnectorProvider,
  input: { events: readonly CalendarEvent[]; self: string; now: Date; timeZone: string; at?: Date },
): DeskWidgetView {
  const next = todayLeft(input.events, input.self, input.now, input.timeZone).find(
    (e) => !(e.allDay || isDate(e.start)),
  );
  const at = input.at ? { at: input.at.toISOString() } : {};
  if (!next) return { kind: 'text', ...base(id, 'next', provider), body: ACCOUNT_WORDS.noMeetings, ...at };
  const start = new Date(next.start);
  const started = start.getTime() <= input.now.getTime();
  const when = started
    ? fill(ACCOUNT_WORDS.until, { time: clockIn(new Date(next.end), input.timeZone) })
    : clockIn(start, input.timeZone);
  const line = joined([when, screenText(next.location, 60), withOthers(next, input.self)], 120);
  return {
    kind: 'figures',
    ...base(id, 'next', provider),
    items: [{ value: soonWords(start, input.now), label: titleOf(next, 40) }],
    ...(line ? { line } : {}),
    ...(started ? { tone: 'ok' as const } : {}),
    ...at,
  };
}

/* Mail --------------------------------------------------------------------------------------------- */

/** “Anna Jansen” of “Anna Jansen <anna@example.com>”; the address when there's no name. */
export function senderName(from: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  if (m) return (m[1] ?? '').trim() || (m[2] ?? '').trim();
  return from.trim();
}

/** When a mail came: its time today, its weekday this week, else its date (“12 Oct”). */
function receivedWords(at: Date, now: Date, timeZone: string): string {
  if (dayIn(at, timeZone) === dayIn(now, timeZone)) return clockIn(at, timeZone);
  const fmt = (o: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat('en-GB', { ...o, timeZone }).format(at);
    } catch {
      return new Intl.DateTimeFormat('en-GB', o).format(at);
    }
  };
  if (now.getTime() - at.getTime() < 6 * 86_400_000) return fmt({ weekday: 'short' });
  return fmt({ day: 'numeric', month: 'short' });
}

/** *Unread mail*: how many unread in the inbox (“12 unread”, “50+ unread”), the newest as rows (subject, who, when). */
export function unreadView(
  id: string,
  provider: ConnectorProvider,
  input: { count: number; newest: readonly MailSummary[]; now: Date; timeZone: string; at?: Date },
): DeskWidgetView {
  const rows: DeskViewRow[] = input.newest.slice(0, DESK_VIEW_ROWS_MAX).map((m) => {
    const who = screenText(senderName(m.from), 120);
    const when = Date.parse(m.date);
    return {
      title: screenText(m.subject, 120) || ACCOUNT_WORDS.noSubject,
      ...(who ? { detail: who } : {}),
      ...(Number.isFinite(when) ? { time: receivedWords(new Date(when), input.now, input.timeZone) } : {}),
    };
  });
  const count = Math.min(1_000_000, Math.max(0, Math.round(input.count)));
  return {
    kind: 'list',
    ...base(id, 'unread', provider),
    ...(count > 0 ? { head: fill(ACCOUNT_WORDS.unread, { n: unreadCountWords(count) }) } : {}),
    rows: count > 0 ? rows : [],
    ...(count > rows.length ? { count } : {}),
    empty: ACCOUNT_WORDS.noUnread,
    ...(input.at ? { at: input.at.toISOString() } : {}),
  };
}

/* GitHub ------------------------------------------------------------------------------------------- */

const CHECK_TONES: Record<NonNullable<AccountPull['checks']>, DeskViewTone | undefined> = {
  passing: 'ok',
  failing: 'bad',
  running: undefined,
};

const pullTitle = (p: AccountPull) => screenText(`${p.repo} #${p.number} · ${p.title}`, 120);

/** *Pull requests*: what's open, newest first (“web #12 · Fix the login”, who opened it, whether its checks pass). */
export function pullsView(id: string, pulls: readonly AccountPull[], at?: Date): DeskWidgetView {
  const sorted = [...pulls].sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime());
  const rows: DeskViewRow[] = sorted.slice(0, DESK_VIEW_ROWS_MAX).map((p) => {
    const detail = joined([screenText(p.author, 60), p.draft ? ACCOUNT_WORDS.draft : ''], 120);
    const tone = p.checks ? CHECK_TONES[p.checks] : undefined;
    return {
      title: pullTitle(p),
      ...(detail ? { detail } : {}),
      ...(p.checks ? { meta: ACCOUNT_WORDS.checks[p.checks] } : {}),
      ...(tone ? { tone } : {}),
    };
  });
  return {
    kind: 'list',
    ...base(id, 'pulls', 'github'),
    ...(pulls.length > 0 ? { head: fill(ACCOUNT_WORDS.open, { n: pulls.length }) } : {}),
    rows,
    ...(pulls.length > rows.length ? { count: pulls.length } : {}),
    empty: ACCOUNT_WORDS.noPulls,
    ...(at ? { at: at.toISOString() } : {}),
  };
}

/**
 * *Waiting for review*: open pull requests (not drafts) someone was asked to review and hasn't yet, those waiting on
 * the screen's person first, then newest first; each says who it waits for (“Waiting for you, Mara”).
 */
export function reviewsView(id: string, pulls: readonly AccountPull[], at?: Date): DeskWidgetView {
  const waiting = pulls
    .filter((p) => !p.draft && p.waitingOn.length > 0)
    .sort((a, b) => {
      const mine = Number(b.waitingOn.some((w) => w.viewer)) - Number(a.waitingOn.some((w) => w.viewer));
      return mine || b.openedAt.getTime() - a.openedAt.getTime();
    });
  const rows: DeskViewRow[] = waiting.slice(0, DESK_VIEW_ROWS_MAX).map((p) => {
    const names = [...p.waitingOn]
      .sort((a, b) => Number(b.viewer) - Number(a.viewer))
      .map((w) => (w.viewer ? ACCOUNT_WORDS.you : w.name))
      .join(', ');
    return { title: pullTitle(p), detail: screenText(fill(ACCOUNT_WORDS.waitingFor, { names }), 120) };
  });
  return {
    kind: 'list',
    ...base(id, 'reviews', 'github'),
    ...(waiting.length > 0 ? { head: fill(ACCOUNT_WORDS.waiting, { n: waiting.length }) } : {}),
    rows,
    ...(waiting.length > rows.length ? { count: waiting.length } : {}),
    empty: ACCOUNT_WORDS.noReviews,
    ...(at ? { at: at.toISOString() } : {}),
  };
}
