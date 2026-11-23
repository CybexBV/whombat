/**
 * A Google, Microsoft 365 or Email account's page from recorded answers: the slots each shows (what is left of today,
 * the counts, the newest unread mail, Drive's newest files), what a missing service leaves out, Drive almost full from
 * 95 %, and one line of why when signed out or a read failed. Pure.
 */
import type { CalendarEvent, ThingPageItem, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { InboxUnread, RecentFile } from '../../connectors/types';
import { slotProblems } from '../kinds/slots';
import { type MailAccountInput, mailAccountView, SPACE_CHECK } from './mail';

const NOW = new Date('2026-11-23T10:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

const event = (
  summary: string,
  from: number,
  to: number,
  more: Partial<CalendarEvent> = {},
): CalendarEvent => ({
  id: summary,
  calendarId: 'primary',
  summary,
  description: '',
  location: '',
  start: at(from),
  end: at(to),
  allDay: false,
  guests: [],
  organizer: null,
  webUrl: null,
  meetUrl: null,
  ...more,
});

const EVENTS = [
  event('Standup', -2 * HOUR, -HOUR - 45 * MIN),
  event('Planning', -HOUR, -30 * MIN),
  event('Lunch', -15 * MIN, 30 * MIN, { location: 'Canteen' }),
  event('Design review', 25 * MIN, 70 * MIN, { meetUrl: 'https://meet.google.com/abc-defg-hij' }),
  event('Call with Arnica Labs', 3 * HOUR, 3 * HOUR + 30 * MIN, { location: 'Phone' }),
];

const UNREAD: InboxUnread = {
  count: 4,
  newest: [
    { subject: 'Invoice 2026-114', from: 'Arnica Labs <billing@arnica.example>', ago: 12 * MIN },
    { subject: 'Re: Design review notes', from: 'Noor Haddad <noor@example.com>', ago: 48 * MIN },
  ].map((m, i) => ({
    id: `m${i}`,
    threadId: `t${i}`,
    from: m.from,
    to: ['mara@example.com'],
    subject: m.subject,
    snippet: '',
    date: at(-m.ago),
    unread: true,
    labels: ['INBOX', 'UNREAD'],
    webUrl: `https://mail.google.com/mail/#inbox/t${i}`,
  })),
};

const FILES: RecentFile[] = [
  {
    id: 'f1',
    name: 'Q4 plan',
    kind: 'doc',
    modifiedAt: at(-20 * MIN),
    by: 'Mara',
    byMe: true,
    webUrl: 'https://docs.google.com/document/d/f1',
  },
  {
    id: 'f2',
    name: 'Budget 2027',
    kind: 'sheet',
    modifiedAt: at(-2 * HOUR),
    by: 'Noor Haddad',
    byMe: false,
    webUrl: 'https://docs.google.com/spreadsheets/d/f2',
  },
];

const ok = <T>(value: T) => ({ ok: true as const, value, at: new Date(NOW.getTime() - MIN) });

function google(over: Partial<MailAccountInput> = {}): MailAccountInput {
  return {
    provider: 'google',
    email: 'mara@example.com',
    services: ['mail', 'calendar', 'files'],
    signedIn: true,
    calendar: ok(EVENTS),
    unread: ok(UNREAD),
    quota: ok({ used: 12.6e9, total: 15e9 }),
    recent: ok(FILES),
    automations: 1,
    countFailed: false,
    now: NOW,
    timeZone: 'Europe/Amsterdam',
    ...over,
  };
}

const panel = (panels: readonly ThingPagePanel[], id: string) => panels.find((p) => p.id === id);
const items = (p: ThingPagePanel | undefined): ThingPageItem[] =>
  p && 'items' in p ? (p.items as ThingPageItem[]) : [];
const count = (panels: readonly ThingPagePanel[], id: string) =>
  items(panel(panels, 'account')).find((i) => i.id === id);

describe('a Google account’s page', () => {
  it('shows what is left of today, its counts, the newest unread mail and Drive’s newest files', () => {
    const view = mailAccountView(google());
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['today', 'account', 'unread-mail', 'files']);
    const today = items(panel(view.panels, 'today'));
    expect(today.map((i) => [i.title, i.right, i.tone])).toEqual([
      ['Lunch', 'Now', 'ok'],
      ['Design review', 'in 25 min', 'info'],
      ['Call with Arnica Labs', 'in 3 h', undefined],
    ]);
    expect(today[1]?.detail).toBe('45 min · Google Meet');
    expect(count(view.panels, 'unread')?.figure?.value).toBe('4');
    expect(count(view.panels, 'meetings')?.figure?.value).toBe('5');
    expect(count(view.panels, 'meetings')?.detail).toContain('3');
    expect(count(view.panels, 'space')?.figure?.value).toBe('84 %');
    expect(count(view.panels, 'space')?.tone).toBeUndefined();
    expect(count(view.panels, 'automations')?.figure?.value).toBe('1');
    expect(items(panel(view.panels, 'unread-mail')).map((i) => [i.title, i.detail, i.right])).toEqual([
      ['Invoice 2026-114', 'Arnica Labs', '12 min ago'],
      ['Re: Design review notes', 'Noor Haddad', '48 min ago'],
    ]);
    const files = items(panel(view.panels, 'files'));
    expect(files.map((f) => [f.title, f.detail, f.url])).toEqual([
      ['Q4 plan', 'Google Docs · you', 'https://docs.google.com/document/d/f1'],
      ['Budget 2027', 'Google Sheets · Noor Haddad', 'https://docs.google.com/spreadsheets/d/f2'],
    ]);
    expect(view.verdict).toContain('4 unread mails');
    expect(view.verdict).toContain('3 meetings left today');
    expect(view.open?.label).toBe('Open Gmail');
    expect(view.notices).toEqual([]);
    expect(view.problem).toBeUndefined();
  });

  it('colours the space amber from 85 % and says Drive is almost full from 95 %', () => {
    expect(
      count(mailAccountView(google({ quota: ok({ used: 13e9, total: 15e9 }) })).panels, 'space')?.tone,
    ).toBe('warn');
    expect(mailAccountView(google({ quota: ok({ used: 13e9, total: 15e9 }) })).notices).toEqual([]);
    const full = mailAccountView(google({ quota: ok({ used: 14.5e9, total: 15e9 }) }));
    expect(full.notices.map((n) => [n.check, n.nature, n.title])).toEqual([
      [SPACE_CHECK, 'fyi', 'Drive is almost full'],
    ]);
  });

  it('puts unread mail in Live without a calendar, and leaves out what the account doesn’t bring', () => {
    const view = mailAccountView(
      google({ services: ['mail'], calendar: null, quota: null, recent: null, automations: 0 }),
    );
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['unread', 'account']);
    expect(items(panel(view.panels, 'account')).map((i) => i.id)).toEqual(['unread', 'automations']);
  });

  it('says in one line why a part couldn’t be read, and shows the rest', () => {
    const view = mailAccountView(
      google({ calendar: { ok: false, problem: 'Google isn’t answering right now.' } }),
    );
    expect(view.problem).toBe('Google isn’t answering right now.');
    expect(view.panels.map((p) => p.id)).toEqual(['unread', 'account', 'files']);
    expect(slotProblems(view)).toEqual([]);
  });

  it('asks to sign in again when signed out, and still counts its automations', () => {
    const view = mailAccountView(
      google({ signedIn: false, calendar: null, unread: null, quota: null, recent: null }),
    );
    expect(view.problem).toContain('Sign in to Google again');
    expect(view.notices.map((n) => n.check)).toEqual(['conn.signin']);
    expect(view.panels.map((p) => p.id)).toEqual(['account']);
    expect(items(panel(view.panels, 'account')).map((i) => i.id)).toEqual(['automations']);
  });
});

describe('a Microsoft 365 account’s page', () => {
  it('shows OneDrive’s space and no list of recent files', () => {
    const view = mailAccountView(google({ provider: 'microsoft', recent: null }));
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['today', 'account', 'unread-mail']);
    expect(count(view.panels, 'space')?.title).toBe('OneDrive space');
    expect(view.open?.label).toBe('Open Outlook');
  });
});

describe('an Email account’s page', () => {
  it('shows its unread mail, its automations, when Whombat last counted and its mail server', () => {
    const view = mailAccountView(
      google({
        provider: 'imap',
        services: ['mail'],
        calendar: null,
        quota: null,
        recent: null,
        unread: ok({ ...UNREAD, count: 3 }),
        automations: 0,
        checked: { at: new Date(NOW.getTime() - 2 * MIN), host: 'imap.fastmail.example' },
      }),
    );
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['unread', 'account']);
    expect(items(panel(view.panels, 'account')).map((i) => [i.id, i.figure?.value])).toEqual([
      ['unread', '3'],
      ['automations', '0'],
      ['checked', '2 min ago'],
    ]);
    expect(count(view.panels, 'checked')?.detail).toBe('imap.fastmail.example');
    expect(view.verdict).toBe('3 unread mails in your inbox.');
    expect(view.open).toBeUndefined();
  });
});
