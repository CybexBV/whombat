import { type CalendarEvent, type DeskWidgetSpec, DeskWidgetView } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { ConnectionUnavailableError, type InboxUnread } from '../../connectors/types';
import type { PrincipalRow } from '../../read/principals';
import type { Services } from '../../services';
import type { AccountPull } from './account-views';
import { type AccountReads, type AccountRow, checksOf } from './accounts';
import { screenViews, WidgetResolver } from './resolve';
import type { ThingWidgets, WidgetCtx } from './types';

let now = Date.parse('2026-10-28T08:48:00.000Z');
const services = {
  clock: () => new Date(now),
  google: { mode: 'fake' },
  log: { warn: () => {} },
} as unknown as Services;
const ctx = (): WidgetCtx => ({
  services,
  viewer: {
    accountId: 'acc_1',
    burrowId: 'brw_1',
    principal: { id: 'prn_1', burrowId: 'brw_1' } as PrincipalRow,
  },
  now: new Date(now),
  timeZone: 'Europe/Amsterdam',
  assistant: 'Dusty',
});
const noThings: ThingWidgets = {
  groups: async () => [],
  resolve: async () => new Map(),
};

const GOOGLE: AccountRow = {
  id: 'con_g',
  provider: 'google',
  email: 'anna@example.com',
  services: ['calendar', 'mail'],
  status: 'active',
};
const standup: CalendarEvent = {
  id: 'e1',
  calendarId: 'primary',
  summary: 'Standup',
  description: '',
  location: '',
  start: '2026-10-28T09:00:00Z',
  end: '2026-10-28T09:15:00Z',
  allDay: false,
  guests: [],
  organizer: null,
  webUrl: null,
  meetUrl: null,
};

/** Reads that count their calls and answer what the test sets. */
function fakeReads() {
  const calls = { calendar: 0, unread: 0, pulls: 0 };
  const state = {
    rows: [GOOGLE] as AccountRow[],
    events: [standup] as CalendarEvent[],
    unread: { count: 3, newest: [] } as InboxUnread,
    fail: null as Error | null,
    repos: true,
    pulls: [] as AccountPull[],
  };
  const reads: AccountReads = {
    accounts: async () => state.rows,
    calendar: async () => {
      calls.calendar++;
      if (state.fail) throw state.fail;
      return state.events;
    },
    unread: async () => {
      calls.unread++;
      if (state.fail) throw state.fail;
      return state.unread;
    },
    hasRepos: async () => state.repos,
    pulls: async () => {
      calls.pulls++;
      return state.pulls;
    },
  };
  return { calls, state, reads };
}

const panel = (id: string, ref: string, name: string): DeskWidgetSpec => ({
  id,
  type: 'panel',
  ref,
  opts: { panel: name },
});

describe('the person’s accounts on a screen', () => {
  it('reads the calendar once for Today and Next meeting, keeps it 5 minutes and redraws Next each minute', async () => {
    now = Date.parse('2026-10-28T08:48:00.000Z');
    const { calls, reads } = fakeReads();
    const resolver = new WidgetResolver(services, () => noThings, { accounts: reads });
    const specs = [panel('w_today', 'account:con_g', 'today'), panel('w_next', 'account:con_g', 'next')];
    const first = await resolver.resolve(ctx(), specs, null, 1_000);
    expect(calls.calendar).toBe(1);
    const next = first.get('w_next');
    expect(next?.private).toBe(true);
    expect(next?.refreshS).toBe(60);
    expect(next?.view.kind === 'figures' && next.view.items[0]?.value).toBe('in 12 min');
    expect(first.get('w_today')?.view.kind).toBe('list');

    now += 4 * 60_000;
    const later = await resolver.resolve(ctx(), specs, null, 1_000);
    expect(calls.calendar).toBe(1);
    const moved = later.get('w_next')?.view;
    expect(moved?.kind === 'figures' && moved.items[0]?.value).toBe('in 8 min');

    now += 2 * 60_000;
    await resolver.resolve(ctx(), specs, null, 1_000);
    await resolver.idle();
    expect(calls.calendar).toBe(2);
  });

  it('keeps unread mail 2 minutes; the lock leaves out its words', async () => {
    now = Date.parse('2026-10-28T08:48:00.000Z');
    const { calls, reads } = fakeReads();
    const resolver = new WidgetResolver(services, () => noThings, { accounts: reads });
    const specs = [panel('w_mail', 'account:con_g', 'unread')];
    const got = await resolver.resolve(ctx(), specs, null, 1_000);
    expect(got.get('w_mail')?.view.kind === 'list' && got.get('w_mail')?.view).toMatchObject({
      head: '3 unread',
    });
    const locked = screenViews(specs, got, 'summary');
    expect(locked[0]).toMatchObject({ locked: true, rows: [] });
    expect(JSON.stringify(locked)).not.toContain('3 unread');
    now += 90_000;
    await resolver.resolve(ctx(), specs, null, 1_000);
    expect(calls.unread).toBe(1);
    now += 60_000;
    await resolver.resolve(ctx(), specs, null, 1_000);
    await resolver.idle();
    expect(calls.unread).toBe(2);
  });

  it('says to sign in again when the account is signed out, and names no one else’s account', async () => {
    now = Date.parse('2026-10-28T08:48:00.000Z');
    const { reads, state } = fakeReads();
    state.fail = new ConnectionUnavailableError('needs_reauth', 'gone');
    const resolver = new WidgetResolver(services, () => noThings, { accounts: reads });
    const got = await resolver.resolve(
      ctx(),
      [panel('w_mail', 'account:con_g', 'unread'), panel('w_other', 'account:con_someone', 'unread')],
      null,
      1_000,
    );
    const signedOut = DeskWidgetView.parse(got.get('w_mail')?.view);
    expect(signedOut.problem?.text).toContain('Sign in to Google again');
    expect(got.get('w_mail')?.private).toBe(false);
    expect(got.get('w_other')?.view.problem?.text).toContain('isn’t connected');
  });

  it('keeps what it read when the provider doesn’t answer, and says so when it never did', async () => {
    now = Date.parse('2026-10-28T08:48:00.000Z');
    const { reads, state } = fakeReads();
    const resolver = new WidgetResolver(services, () => noThings, { accounts: reads });
    const specs = [panel('w_mail', 'account:con_g', 'unread')];
    await resolver.resolve(ctx(), specs, null, 1_000);
    state.fail = new Error('timeout');
    now += 3 * 60_000;
    await resolver.resolve(ctx(), specs, null, 1_000);
    await resolver.idle();
    const kept = await resolver.resolve(ctx(), specs, null, 1_000);
    expect(kept.get('w_mail')?.view).toMatchObject({ kind: 'list', head: '3 unread' });

    const fresh = new WidgetResolver(services, () => noThings, { accounts: reads });
    const never = await fresh.resolve(ctx(), specs, null, 1_000);
    expect(never.get('w_mail')?.view.problem?.text).toContain('isn’t answering');
  });

  it('says a calendar widget on an account without its calendar needs it turned on', async () => {
    const { reads, state } = fakeReads();
    state.rows = [{ ...GOOGLE, services: ['mail'] }];
    const resolver = new WidgetResolver(services, () => noThings, { accounts: reads });
    const got = await resolver.resolve(ctx(), [panel('w_today', 'account:con_g', 'today')], null, 1_000);
    expect(got.get('w_today')?.view.problem?.text).toContain('calendar');
  });

  it('shows the GitHub mirror’s pull requests, not private; a widget it has no such panel for says so', async () => {
    const { reads, state } = fakeReads();
    state.pulls = [
      {
        repo: 'web',
        number: 12,
        title: 'Fix the login',
        author: 'mara',
        draft: false,
        openedAt: new Date(now),
        checks: 'passing',
        waitingOn: [],
      },
    ];
    const resolver = new WidgetResolver(services, () => noThings, { accounts: reads });
    const got = await resolver.resolve(
      ctx(),
      [panel('w_prs', 'account:github', 'pulls'), panel('w_bad', 'account:github', 'today')],
      null,
      1_000,
    );
    expect(got.get('w_prs')?.private).toBe(false);
    expect(got.get('w_prs')?.view).toMatchObject({ kind: 'list', head: '1 open' });
    expect(got.get('w_bad')?.view.problem).toBeTruthy();
  });

  it('lists only the person’s active accounts with a calendar or mail, then GitHub when there are repositories', async () => {
    const { reads, state } = fakeReads();
    state.rows = [
      GOOGLE,
      { id: 'con_m', provider: 'microsoft', email: 'anna@corp.test', services: ['files'], status: 'active' },
      { id: 'con_i', provider: 'imap', email: 'jo@home.test', services: ['mail'], status: 'needs_reauth' },
    ];
    const resolver = new WidgetResolver(services, () => noThings, { accounts: reads });
    expect((await resolver.accounts.groups(ctx())).map((g) => g.key)).toEqual([
      'account:con_g',
      'account:github',
    ]);
    expect((await resolver.accounts.groups(ctx(), 'account:github')).map((g) => g.key)).toEqual([
      'account:github',
    ]);
    state.repos = false;
    expect((await resolver.accounts.groups(ctx())).map((g) => g.key)).toEqual(['account:con_g']);
  });

  it('sums a head’s checks', () => {
    expect(checksOf([])).toBeNull();
    expect(checksOf(['passed', 'skipped'])).toBe('passing');
    expect(checksOf(['passed', 'running'])).toBe('running');
    expect(checksOf(['running', 'failed'])).toBe('failing');
  });
});
