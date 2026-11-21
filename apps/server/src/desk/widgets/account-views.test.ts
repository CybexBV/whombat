import { type CalendarEvent, DeskCatalogGroup, DeskWidgetView, type MailSummary } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  type AccountPull,
  accountGroup,
  accountPanelOf,
  accountPanels,
  nextView,
  pullsView,
  reviewsView,
  senderName,
  soonWords,
  todayLeft,
  todayView,
  unreadView,
} from './account-views';
import { deskCatalog } from './catalog';
import type { ScreenHomeWidget } from './home';
import { catalogFor } from './older-apps';

const TZ = 'Europe/Amsterdam';
// 09:48 in Amsterdam.
const now = new Date('2026-10-28T08:48:00Z');
const SELF = 'anna@example.com';

const event = (
  over: Partial<CalendarEvent> & Pick<CalendarEvent, 'summary' | 'start' | 'end'>,
): CalendarEvent => ({
  id: over.summary,
  calendarId: 'primary',
  description: '',
  location: '',
  allDay: false,
  guests: [],
  organizer: null,
  webUrl: null,
  meetUrl: null,
  ...over,
});

const EVENTS: CalendarEvent[] = [
  event({ summary: 'Breakfast', start: '2026-10-28T06:00:00Z', end: '2026-10-28T06:30:00Z' }),
  event({
    summary: 'Standup',
    start: '2026-10-28T09:00:00Z',
    end: '2026-10-28T09:15:00Z',
    location: 'Room 3',
  }),
  event({
    summary: 'Planning',
    start: '2026-10-28T13:00:00Z',
    end: '2026-10-28T14:00:00Z',
    guests: [
      { email: SELF, name: null, response: 'accepted' },
      { email: 'mara@example.com', name: null, response: 'accepted' },
      { email: 'bo@example.com', name: null, response: 'needs_action' },
    ],
  }),
  event({
    summary: 'Declined one',
    start: '2026-10-28T10:00:00Z',
    end: '2026-10-28T11:00:00Z',
    guests: [{ email: SELF, name: null, response: 'declined' }],
  }),
  event({ summary: 'Office day', start: '2026-10-28', end: '2026-10-29', allDay: true }),
  event({ summary: 'Tomorrow', start: '2026-10-28T23:30:00Z', end: '2026-10-29T00:30:00Z' }),
];

const valid = (v: unknown) => DeskWidgetView.parse(v);

describe('the calendar’s widgets', () => {
  it('Today lists what’s left: the all-day item without a time, then each meeting at its time', () => {
    const left = todayLeft(EVENTS, SELF, now, TZ).map((e) => e.summary);
    expect(left).toEqual(['Office day', 'Standup', 'Planning']);
    const view = valid(todayView('w_1', 'google', { events: EVENTS, self: SELF, now, timeZone: TZ }));
    expect(view.kind).toBe('list');
    if (view.kind !== 'list') return;
    expect(view.head).toBe('2 left today');
    expect(view.rows.map((r) => r.time ?? null)).toEqual([null, '10:00', '14:00']);
    expect(view.rows[0]?.meta).toBe('All day');
    expect(view.rows[1]?.detail).toBe('Room 3');
    expect(view.rows[2]?.detail).toBe('with 2 others');
    expect(view.name).toBe('Google');
  });

  it('Today is calm when nothing is left', () => {
    const view = valid(todayView('w_1', 'microsoft', { events: [], self: SELF, now, timeZone: TZ }));
    expect(view.kind === 'list' && view.rows).toEqual([]);
    expect(view.kind === 'list' && view.empty).toBe('Nothing else today.');
    expect(view.kind === 'list' && view.head).toBeUndefined();
  });

  it('Next meeting says how soon, what and when, and moves with the clock', () => {
    const view = valid(nextView('w_2', 'google', { events: EVENTS, self: SELF, now, timeZone: TZ }));
    expect(view.kind).toBe('figures');
    if (view.kind !== 'figures') return;
    expect(view.items[0]).toEqual({ value: 'in 12 min', label: 'Standup' });
    expect(view.line).toBe('10:00 · Room 3');
    const during = valid(
      nextView('w_2', 'google', {
        events: EVENTS,
        self: SELF,
        now: new Date('2026-10-28T09:05:00Z'),
        timeZone: TZ,
      }),
    );
    expect(during.kind === 'figures' && during.items[0]?.value).toBe('Now');
    expect(during.kind === 'figures' && during.line).toContain('until 10:15');
  });

  it('Next meeting says there are none left', () => {
    const late = new Date('2026-10-28T20:00:00Z');
    const view = valid(nextView('w_2', 'google', { events: EVENTS, self: SELF, now: late, timeZone: TZ }));
    expect(view.kind).toBe('text');
    expect(view.kind === 'text' && view.body).toBe('No more meetings today.');
  });

  it('says how soon in minutes and hours', () => {
    expect(soonWords(new Date(now.getTime() + 60_000), now)).toBe('in 1 min');
    expect(soonWords(new Date(now.getTime() + 125 * 60_000), now)).toBe('in 2 h 5 min');
    expect(soonWords(new Date(now.getTime() + 120 * 60_000), now)).toBe('in 2 h');
    expect(soonWords(now, now)).toBe('Now');
  });
});

describe('Unread mail', () => {
  const mail = (subject: string, from: string, date: string): MailSummary => ({
    id: subject,
    threadId: subject,
    from,
    to: [],
    subject,
    snippet: '',
    date,
    unread: true,
    labels: [],
  });

  it('heads with the count, capped like Home, and lists the newest with who and when', () => {
    const view = valid(
      unreadView('w_3', 'imap', {
        count: 73,
        newest: [
          mail('Invoice', 'Anna Jansen <anna@x.test>', '2026-10-28T07:30:00Z'),
          mail('', 'bo@x.test', '2026-10-20T07:30:00Z'),
        ],
        now,
        timeZone: TZ,
      }),
    );
    if (view.kind !== 'list') throw new Error(view.kind);
    expect(view.head).toBe('50+ unread');
    expect(view.count).toBe(73);
    expect(view.rows.map((r) => [r.title, r.detail, r.time])).toEqual([
      ['Invoice', 'Anna Jansen', '08:30'],
      ['No subject', 'bo@x.test', '20 Oct'],
    ]);
    expect(view.name).toBe('Email');
  });

  it('says there’s none', () => {
    const view = valid(unreadView('w_3', 'google', { count: 0, newest: [], now, timeZone: TZ }));
    expect(view.kind === 'list' && [view.head, view.rows.length, view.empty]).toEqual([
      undefined,
      0,
      'No unread mail.',
    ]);
  });

  it('names a sender', () => {
    expect(senderName('"Jansen, Anna" <anna@x.test>')).toBe('Jansen, Anna');
    expect(senderName('<anna@x.test>')).toBe('anna@x.test');
    expect(senderName('anna@x.test')).toBe('anna@x.test');
  });
});

describe('GitHub’s widgets', () => {
  const pull = (n: number, over: Partial<AccountPull> = {}): AccountPull => ({
    repo: 'web',
    number: n,
    title: `Change ${n}`,
    author: 'mara',
    draft: false,
    openedAt: new Date(now.getTime() - n * 3_600_000),
    checks: null,
    waitingOn: [],
    ...over,
  });

  it('Pull requests lists what’s open, newest first, with whose and its checks', () => {
    const view = valid(
      pullsView('w_4', [
        pull(12, { checks: 'failing' }),
        pull(3, { checks: 'passing', draft: true }),
        pull(7),
      ]),
    );
    if (view.kind !== 'list') throw new Error(view.kind);
    expect(view.head).toBe('3 open');
    expect(view.rows.map((r) => r.title)).toEqual([
      'web #3 · Change 3',
      'web #7 · Change 7',
      'web #12 · Change 12',
    ]);
    expect(view.rows.map((r) => [r.meta, r.tone])).toEqual([
      ['Checks pass', 'ok'],
      [undefined, undefined],
      ['Checks fail', 'bad'],
    ]);
    expect(view.rows[0]?.detail).toBe('mara · Draft');
  });

  it('Waiting for review puts what waits on the screen’s person first, and leaves out drafts', () => {
    const view = valid(
      reviewsView('w_5', [
        pull(1, { waitingOn: [{ name: 'Bo', viewer: false }] }),
        pull(2, {
          waitingOn: [
            { name: 'Mara', viewer: false },
            { name: 'Anna', viewer: true },
          ],
        }),
        pull(3, { draft: true, waitingOn: [{ name: 'Bo', viewer: false }] }),
        pull(4),
      ]),
    );
    if (view.kind !== 'list') throw new Error(view.kind);
    expect(view.head).toBe('2 waiting');
    expect(view.rows.map((r) => [r.title, r.detail])).toEqual([
      ['web #2 · Change 2', 'Waiting for you, Mara'],
      ['web #1 · Change 1', 'Waiting for Bo'],
    ]);
  });
});

describe('Your accounts in Add a widget', () => {
  it('offers what each account has connected, each private but pull requests', () => {
    const google = accountGroup({
      ref: 'account:con_g',
      provider: 'google',
      email: 'anna@example.com',
      services: ['mail', 'calendar', 'files'],
    });
    expect(DeskCatalogGroup.parse(google)).toBeTruthy();
    expect(google?.key).toBe('account:con_g');
    expect(google?.thing).toBe('account:con_g');
    expect(google?.label).toBe('Google · anna@example.com');
    expect(google?.mark).toBe('google');
    expect(google?.items.map((i) => [i.type, i.opts.panel, i.private ?? false])).toEqual([
      ['panel', 'today', true],
      ['panel', 'next', true],
      ['panel', 'unread', true],
    ]);
    const imap = accountGroup({
      ref: 'account:con_i',
      provider: 'imap',
      email: 'jo@home.test',
      services: ['mail'],
    });
    expect(imap?.mark).toBe('imap');
    expect(imap?.items.map((i) => i.opts.panel)).toEqual(['unread']);
    const github = accountGroup('github');
    expect(github?.key).toBe('account:github');
    expect(github?.items.map((i) => [i.opts.panel, i.private ?? false])).toEqual([
      ['pulls', false],
      ['reviews', true],
    ]);
  });

  it('offers nothing for an account with neither calendar nor mail', () => {
    expect(
      accountGroup({ ref: 'account:con_m', provider: 'microsoft', email: 'a@b.c', services: ['files'] }),
    ).toBeNull();
  });

  it('maps an account’s Figures to its next meeting, else its first', () => {
    expect(
      accountPanelOf(
        { type: 'figures', opts: {} },
        accountPanels({ provider: 'google', services: ['calendar', 'mail'] }),
      ),
    ).toBe('next');
    expect(
      accountPanelOf({ type: 'figures', opts: {} }, accountPanels({ provider: 'imap', services: ['mail'] })),
    ).toBe('unread');
    expect(accountPanelOf({ type: 'panel', opts: { panel: 'today' } }, ['unread'])).toBeNull();
  });
});

describe('where accounts go in Add a widget', () => {
  const thing: DeskCatalogGroup = {
    key: 'connection:con_plex',
    thing: 'connection:con_plex',
    label: 'Plex',
    items: [],
  };
  const accounts = [accountGroup('github')].filter((g): g is DeskCatalogGroup => g !== null);
  const home = [
    {
      id: 'wdg_1',
      title: 'Living room',
      kind: 'line',
      series: [],
      latest: [],
      points: [],
      refreshSec: 300,
      updatedAt: null,
    },
  ] as unknown as ScreenHomeWidget[];

  it('lists them after the things and before Home’s widgets', () => {
    const keys = deskCatalog({
      assistant: 'Dusty',
      fleet: null,
      things: [thing],
      accounts,
      widgets: home,
    }).map((g) => g.key);
    expect(keys).toEqual(['own', 'connection:con_plex', 'account:github', 'widgets']);
  });

  it('gives them to every app of session major 5, whatever its minor (the minor counts again from 0)', () => {
    const groups = deskCatalog({ assistant: 'Dusty', fleet: null, things: [thing], accounts, widgets: [] });
    for (const minor of [0, 1, 2, undefined])
      expect(catalogFor(groups, minor).map((g) => g.key)).toContain('account:github');
  });
});
