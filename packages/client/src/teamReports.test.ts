import type { Approval, TeamReportRow } from '@whombat/core';
import { TEAM_REPORTS_MINOR } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import {
  browserDeviceWords,
  TEAM_REPORT_WORDS,
  teamReportClientContext,
  teamReportDraftOf,
  teamReportDraftPath,
  teamReportGroups,
  teamReportRowLine,
  teamReportSentWith,
  teamReportSentWithLine,
  teamReportsShown,
  teamReportsSummary,
  teamReportsUnavailableText,
  teamReportsUnread,
  teamReportTimeline,
  teamReportTrack,
  teamReportWhen,
} from './teamReports';

const row = (over: Partial<TeamReportRow>): TeamReportRow => ({
  id: 'tr_AAAAAAAAAAAAAAAAAAAA',
  number: 1,
  kind: 'bug',
  title: 'Report',
  status: 'new',
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_000,
  revision: 0,
  unread: false,
  ...over,
});

const AT = { major: 5, minor: TEAM_REPORTS_MINOR };
const BEFORE = { major: 5, minor: TEAM_REPORTS_MINOR - 1 };

describe('whether the entry shows', () => {
  it('needs a Whombat that speaks reports', () => {
    const list = { available: true, reports: [] };
    expect(teamReportsShown(AT, list)).toBe(true);
    expect(teamReportsShown(BEFORE, list)).toBe(false);
    expect(teamReportsShown(null, list)).toBe(false);
    expect(teamReportsShown({ major: 6, minor: 0 }, list)).toBe(true);
  });

  it('shows where a report can be sent or the person has some, and nowhere else', () => {
    expect(teamReportsShown(AT, { available: false, reports: [] })).toBe(false);
    expect(teamReportsShown(AT, { available: false, reports: [row({})] })).toBe(true);
    expect(teamReportsShown(AT, undefined)).toBe(false);
  });

  it('says why a new report can’t be sent', () => {
    expect(teamReportsUnavailableText(null)).toBeNull();
    for (const reason of ['not_invited', 'off', 'link_off', 'unreachable'] as const)
      expect(teamReportsUnavailableText(reason)).toBeTruthy();
    expect(teamReportsUnavailableText('link_off')).toContain('Whombat Link');
  });
});

describe('the list', () => {
  const rows = [
    row({ id: 'tr_old_open_AAAAAAAAA', number: 1, status: 'investigating', updatedAt: 100 }),
    row({ id: 'tr_new_open_AAAAAAAAA', number: 2, status: 'in_progress', updatedAt: 300 }),
    row({ id: 'tr_unread_AAAAAAAAAAA', number: 3, status: 'planned', updatedAt: 50, unread: true }),
    row({ id: 'tr_asks_AAAAAAAAAAAAA', number: 4, status: 'needs_information', updatedAt: 10 }),
    row({ id: 'tr_fix_AAAAAAAAAAAAAA', number: 5, status: 'available', updatedAt: 20 }),
    row({ id: 'tr_done_AAAAAAAAAAAAA', number: 6, status: 'confirmed', updatedAt: 500 }),
    row({ id: 'tr_dup_AAAAAAAAAAAAAA', number: 7, status: 'duplicate', updatedAt: 600, unread: true }),
  ];

  it('puts what needs the person first, then what is new, then the latest', () => {
    const { open } = teamReportGroups(rows);
    expect(open.map((r) => r.number)).toEqual([5, 4, 3, 2, 1]);
  });

  it('folds closed reports under Closed while open ones exist, still showing those with news', () => {
    const groups = teamReportGroups(rows);
    expect(groups.closed.map((r) => r.number)).toEqual([7, 6]);
    expect(groups.foldable).toBe(true);
    expect(groups.closedWhileFolded.map((r) => r.number)).toEqual([7]);
    expect(teamReportGroups(rows.filter((r) => r.number >= 6)).foldable).toBe(false);
  });

  it('counts the reports with something new and says a row in a line', () => {
    expect(teamReportsUnread(rows)).toBe(2);
    expect(teamReportsSummary([])).toBe('No reports yet');
    expect(teamReportsSummary(rows.slice(0, 1))).toBe('1 report');
    expect(teamReportsSummary(rows)).toBe('7 reports · 2 new answers');
    expect(teamReportRowLine(row({ number: 12, kind: 'idea', status: 'investigating' }))).toBe(
      '#12 · Idea · Looking into it',
    );
  });

  it('says a row’s time in a few words', () => {
    const now = Date.UTC(2026, 10, 25, 15, 0);
    const sec = (ms: number) => Math.floor(ms / 1000);
    expect(teamReportWhen(sec(Date.UTC(2026, 10, 25, 9, 5)), now, 'UTC')).toBe('09:05');
    expect(teamReportWhen(sec(Date.UTC(2026, 10, 24, 9, 5)), now, 'UTC')).toBe('Yesterday');
    expect(teamReportWhen(sec(Date.UTC(2026, 10, 22, 9, 5)), now, 'UTC')).toBe('Sun');
    expect(teamReportWhen(sec(Date.UTC(2026, 9, 6, 9, 5)), now, 'UTC')).toBe('6 Oct');
  });
});

describe('a report’s conversation', () => {
  const report = {
    text: 'The backup page stays empty.',
    expected: 'My backups.',
    createdAt: 100,
    messages: [
      { id: 'm0', author: 'reporter' as const, text: 'The backup page stays empty.', at: 100 },
      { id: 'm1', author: 'team' as const, text: '', at: 200, status: 'investigating' as const },
      {
        id: 'm2',
        author: 'team' as const,
        text: 'Which browser?',
        at: 300,
        status: 'needs_information' as const,
      },
      { id: 'm3', author: 'reporter' as const, text: 'Firefox.', at: 400 },
      { id: 'm4', author: 'reporter' as const, text: '', at: 500, status: 'confirmed' as const },
    ],
  };

  it('starts with what was sent, without repeating it, oldest first', () => {
    const entries = teamReportTimeline(report);
    expect(entries.map((e) => e.kind)).toEqual(['sent', 'status', 'status', 'message', 'message', 'status']);
    expect(entries[0]).toMatchObject({ kind: 'sent', text: report.text, expected: 'My backups.' });
  });

  it('puts a status change before the words sent with it, and names who wrote', () => {
    const entries = teamReportTimeline(report);
    expect(entries[2]).toMatchObject({ kind: 'status', status: 'needs_information' });
    expect(entries[2]?.kind === 'status' && entries[2].words).toContain('Needs your reply');
    expect(entries[3]).toMatchObject({
      kind: 'message',
      who: TEAM_REPORT_WORDS.team,
      text: 'Which browser?',
    });
    expect(entries[4]).toMatchObject({ kind: 'message', who: TEAM_REPORT_WORDS.you });
    expect(entries[5]?.kind === 'status' && entries[5].words).toContain('works');
  });

  it('keeps a first message that says something new', () => {
    const entries = teamReportTimeline({
      ...report,
      messages: [{ id: 'm0', author: 'reporter', text: 'Also on my phone.', at: 150 }],
    });
    expect(entries.map((e) => e.kind)).toEqual(['sent', 'message']);
  });

  it('keeps the first message shown when older ones were left out', () => {
    const entries = teamReportTimeline({ ...report, messages: report.messages.slice(0, 1) }, 3);
    expect(entries.map((e) => e.kind)).toEqual(['sent', 'message']);
  });

  it('shows the person’s answer that moved the status as their words, never as a press', () => {
    const entries = teamReportTimeline({
      ...report,
      messages: [
        { id: 'q', author: 'team', text: 'Which browser?', at: 200, status: 'needs_information' },
        { id: 'a', author: 'reporter', text: 'Firefox on Linux.', at: 300, status: 'investigating' },
        { id: 'p', author: 'reporter', text: '', at: 400, status: 'investigating' },
      ],
    });
    expect(entries.map((e) => [e.kind, e.key])).toEqual([
      ['sent', 'sent'],
      ['status', 'q-status'],
      ['message', 'q'],
      ['message', 'a'],
      ['status', 'p-status'],
    ]);
    expect(entries[3]).toMatchObject({ who: TEAM_REPORT_WORDS.you, text: 'Firefox on Linux.' });
    // Only the press without words is “Still happening”.
    expect(entries[4]?.kind === 'status' && entries[4].words).toContain('still happens');
  });
});

describe('the track', () => {
  const states = (s: Parameters<typeof teamReportTrack>[0]) => teamReportTrack(s).map((x) => x.state);

  it('marks the steps behind done and the team’s current one', () => {
    expect(states('new')).toEqual(['done', 'ahead', 'ahead', 'ahead']);
    expect(states('investigating')).toEqual(['done', 'current', 'ahead', 'ahead']);
    expect(states('in_progress')).toEqual(['done', 'done', 'current', 'ahead']);
    expect(states('available')).toEqual(['done', 'done', 'done', 'done']);
  });

  it('leaves a report that ended without a fix where it got to', () => {
    expect(states('not_planned')).toEqual(['done', 'done', 'ahead', 'ahead']);
  });
});

describe('what is sent with a report', () => {
  it('keeps only what fits the contract', () => {
    expect(
      teamReportClientContext({
        client: 'web',
        appVersion: '3.158.0',
        device: '  Firefox 146\u0007 ·\n Linux ',
        language: 'en-GB',
      }),
    ).toEqual({ client: 'web', appVersion: '3.158.0', device: 'Firefox 146 · Linux', language: 'en-GB' });
    expect(teamReportClientContext({ client: 'ios', appVersion: 'dev build', language: 'x' })).toEqual({
      client: 'ios',
    });
    expect(teamReportClientContext({ client: 'android', device: 'a'.repeat(200) }).device).toHaveLength(120);
  });

  it('says it in one line, with the Whombat’s version and update channel', () => {
    const app = {
      client: 'web' as const,
      appVersion: '3.158.0',
      device: 'Firefox 146 · Linux',
      language: 'en-GB',
    };
    expect(teamReportSentWithLine({ ...app, runtimeVersion: '0.304.0', channel: 'development' })).toBe(
      'Whombat 0.304.0 · Beta · Web app 3.158.0 · Firefox 146 · Linux · en-GB',
    );
    // What the app doesn't know is still named: the Whombat adds it.
    const unknown = teamReportSentWithLine({ ...app, runtimeVersion: '0.304.0' });
    expect(unknown.startsWith('Web app 3.158.0')).toBe(true);
    expect(unknown).toContain('version and update channel');
    expect(teamReportSentWith({ ...app, channel: 'production' })[0]).toMatchObject({ label: 'Whombat' });
    expect(teamReportSentWith({ ...app, runtimeVersion: '0.304.0', channel: 'production' })[0]?.value).toBe(
      '0.304.0 · Production',
    );
  });

  it('names a browser and its system in a few words', () => {
    expect(browserDeviceWords('Mozilla/5.0 (X11; Linux x86_64; rv:146.0) Gecko/20100101 Firefox/146.0')).toBe(
      'Firefox 146 · Linux',
    );
    expect(
      browserDeviceWords(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome 142 · macOS');
    expect(
      browserDeviceWords(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari 26 · iOS');
    expect(
      browserDeviceWords(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
      ),
    ).toBe('Edge 142 · Windows');
    expect(browserDeviceWords('')).toBeNull();
  });
});

describe('the assistant’s draft card', () => {
  const card = (
    over: { state?: Approval['state']; name?: string; data?: Record<string, string | number> } = {},
  ): Pick<Approval, 'action' | 'state'> => ({
    state: over.state ?? 'pending',
    action: {
      type: 'custom',
      params: {
        name: over.name ?? 'report_to_whombat_team',
        keyId: 'messages.external',
        data: over.data ?? { draftId: 'trd_AAAAAAAAAAAAAAAAAAAAAA' },
      },
    },
  });

  it('offers its draft while it waits', () => {
    expect(teamReportDraftOf(card())).toBe('trd_AAAAAAAAAAAAAAAAAAAAAA');
  });

  it('offers nothing once answered, for another action, or without a draft’s id', () => {
    expect(teamReportDraftOf(card({ state: 'approved' }))).toBeNull();
    expect(teamReportDraftOf(card({ state: 'declined' }))).toBeNull();
    expect(teamReportDraftOf(card({ name: 'something_else' }))).toBeNull();
    expect(teamReportDraftOf(card({ data: {} }))).toBeNull();
    expect(teamReportDraftOf(card({ data: { draftId: 42 } }))).toBeNull();
    expect(teamReportDraftOf(card({ data: { draftId: '../../x' } }))).toBeNull();
    expect(
      teamReportDraftOf({
        state: 'pending',
        action: { type: 'merge_pr', params: { prNumber: 1 } } as unknown as Approval['action'],
      }),
    ).toBeNull();
  });

  it('opens the form with it', () => {
    expect(teamReportDraftPath('trd_AAAAAAAAAAAAAAAAAAAAAA')).toBe(
      '/reports/new?draft=trd_AAAAAAAAAAAAAAAAAAAAAA',
    );
    expect(TEAM_REPORT_WORDS.edit).toBe('Edit');
  });
});
