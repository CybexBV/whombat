/**
 * Reports to the Whombat Team (docs/decisions/team-reports.md), the parts without a database: the words inside the
 * device ops, what counts as unread, when the person is told and in which words, control's refusals in plain words, the
 * Link gate, the stand-in team that development and the tests talk to, and a tracker connection's own signature.
 */
import {
  connectionSignature,
  customerSignature,
  TeamReport,
  TeamReportDraft,
  TeamReportList,
  type TeamReportStatus,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { standInAnswer } from '../managed/dev-standins';
import { FAKE_TEAM_FIRST_ANSWER, FakeTeam, FakeTeamRefusal } from '../managed/fake-team';
import { ManagerCallError, type ManagerPort } from '../managed/ports';
import type { Services } from '../services';
import {
  sameTeamReportSummary,
  TEAM_REPORT_NOTICE_WORDS,
  teamReportEnteredNeedsYou,
  teamReportNoticeTitle,
  teamReportOlderThanCopy,
} from './commands';
import {
  controlFailure,
  refusalCode,
  TEAM_REPORT_WORDS,
  teamPortOf,
  teamReportsLeftLink,
  useTeamReports,
} from './control';
import { fitTeamReport, fitTeamReportsList, TEAM_REPORT_ANSWER_MAX_BYTES } from './fit';
import {
  TEAM_REPORTS_FIRST_JITTER_MS,
  TEAM_REPORTS_FIRST_MS,
  TEAM_REPORTS_FOLLOW_MS,
  teamReportsFollowPeriod,
} from './follow';
import { teamReportItem } from './inbox';
import { decodeTeamPayload, encodeTeamPayload, TeamPayloadError } from './payload';
import { teamListMatchesCopies, teamReportUnread } from './service';

const draft = {
  kind: 'bug' as const,
  text: 'The map stays blank — even after a minute 🗺️',
  expected: 'My phone on the map',
  context: { client: 'web' as const, language: 'nl' },
};

describe('the words inside the device ops', () => {
  it('travel as base64url JSON and come back as the same shape', () => {
    const payload = encodeTeamPayload(draft);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeTeamPayload(TeamReportDraft, payload)).toEqual(draft);
  });

  it('refuse anything that isn’t base64url JSON of the shape', () => {
    expect(() => decodeTeamPayload(TeamReportDraft, 'not base64url!')).toThrow(TeamPayloadError);
    expect(() => decodeTeamPayload(TeamReportDraft, Buffer.from('{').toString('base64url'))).toThrow(
      TeamPayloadError,
    );
    expect(() => decodeTeamPayload(TeamReportDraft, encodeTeamPayload({ kind: 'bug' }))).toThrow(
      TeamPayloadError,
    );
  });
});

describe('what is new to the person', () => {
  it('is a report whose team revision is past the one they read', () => {
    expect(teamReportUnread(0, 0)).toBe(false);
    expect(teamReportUnread(2, 1)).toBe(true);
    expect(teamReportUnread(1, null)).toBe(true);
    expect(teamReportUnread(1, 3)).toBe(false);
  });

  it('tells them when the team asks something or offers a fix, not when they answered themselves', () => {
    const before = { status: 'investigating', revision: 1 };
    expect(teamReportEnteredNeedsYou(before, { status: 'needs_information', revision: 2 })).toBe(true);
    expect(teamReportEnteredNeedsYou(before, { status: 'available', revision: 2 })).toBe(true);
    expect(teamReportEnteredNeedsYou(before, { status: 'in_progress', revision: 2 })).toBe(false);
    // Still waiting for the same answer, and a status change without a team change.
    expect(
      teamReportEnteredNeedsYou(
        { status: 'needs_information', revision: 2 },
        { status: 'needs_information', revision: 3 },
      ),
    ).toBe(false);
    expect(teamReportEnteredNeedsYou(before, { status: 'needs_information', revision: 1 })).toBe(false);
  });

  it('is said in fixed words that open the report, never the team’s', () => {
    expect(teamReportNoticeTitle('needs_information')).toContain('asked about your report');
    expect(teamReportNoticeTitle('available')).toContain('ready to try');
    expect(teamReportNoticeTitle('investigating')).toBeNull();
    const item = teamReportItem({
      reportId: 'tr_AAAAAAAAAAAAAAAAAAAA',
      number: 12,
      status: 'needs_information',
      updatedAt: new Date('2026-11-25T10:00:00Z'),
    });
    expect(item).toMatchObject({
      title: TEAM_REPORT_NOTICE_WORDS.needs_information.title,
      href: '/reports/tr_AAAAAAAAAAAAAAAAAAAA',
      nature: 'you',
      ref: { kind: 'team_report', id: 'tr_AAAAAAAAAAAAAAAAAAAA' },
    });
    expect(item.body).toContain('#12');
    expect(item.actions[0]).toMatchObject({ kind: 'open', href: item.href });
  });
});

describe('control’s answers in plain words', () => {
  const refused = (code: string) =>
    new ManagerCallError('/v1/runtime/team-reports/get', 502, 'control_refused', `refused ${code}: no`);

  it('reads control’s code from the manager’s message', () => {
    expect(refusalCode(refused('report_unknown'))).toBe('report_unknown');
    expect(refusalCode(refused('rate_limited'))).toBe('rate_limited');
    expect(refusalCode(new ManagerCallError('/x', 503, 'control_unreachable', 'report_unknown'))).toBeNull();
    // Control's error code and its details.code, as the manager puts them first.
    expect(refusalCode(refused('forbidden not_invited'))).toBe('not_invited');
    expect(refusalCode(refused('conflict too_many_open'))).toBe('too_many_open');
  });

  it('takes the code the manager put first, never one in control’s words after it', () => {
    const answer = (message: string) =>
      new ManagerCallError(
        '/v1/runtime/team-reports/create',
        502,
        'control_refused',
        `manager /v1/runtime/team-reports/create: 502 ${JSON.stringify({ error: { code: 'control_refused', message } })}`,
      );
    expect(refusalCode(answer('refused link_off: control refused team.reports.create: rate_limited'))).toBe(
      'link_off',
    );
    expect(refusalCode(answer('refused device_revoked: control refused: report_unknown'))).toBeNull();
    expect(refusalCode(refused('device_revoked: report_unknown'))).toBeNull();
  });

  it('reads control’s code from the message the manager really writes', () => {
    // As the manager's client puts it: its path, the status and the start of the manager's JSON answer, whose message
    // leads with control's error code and details.code (once when they are the same), then control's own answer.
    const manager = (codes: string, control: object) => {
      const message = `${codes}: control refused team.reports.create: control HTTP 400: ${JSON.stringify(control)}`;
      const body = JSON.stringify({ error: { code: 'control_refused', message } });
      return new ManagerCallError(
        '/v1/runtime/team-reports/create',
        502,
        'control_refused',
        `manager /v1/runtime/team-reports/create: 502 ${body.slice(0, 200)}`,
      );
    };
    const invalid = manager('validation_failed', {
      error: {
        code: 'validation_failed',
        message: 'What was sent isn’t a report the Whombat Team takes.',
        details: { code: 'validation_failed' },
      },
    });
    expect(refusalCode(invalid)).toBe('validation_failed');
    expect(controlFailure(invalid).message).toBe(TEAM_REPORT_WORDS.invalid);
    const unknown = manager('not_found report_unknown', {
      error: {
        code: 'not_found',
        message: 'This Whombat has no such report.',
        details: { code: 'report_unknown' },
      },
    });
    expect(refusalCode(unknown)).toBe('report_unknown');
    const notInvited = manager('forbidden not_invited', {
      error: { code: 'forbidden', message: 'Only invited accounts.', details: { code: 'not_invited' } },
    });
    expect(controlFailure(notInvited).message).toBe(TEAM_REPORT_WORDS.notInvited);
  });

  it('says Link is needed to read, and that sending needs Link on, for control’s link_off', () => {
    const linkOff = refused('forbidden link_off');
    expect(controlFailure(linkOff, 'read').message).toBe(TEAM_REPORT_WORDS.linkOff);
    expect(controlFailure(linkOff, 'send').message).toBe(TEAM_REPORT_WORDS.sendNeedsLink);
    expect(controlFailure(linkOff).message).toBe(TEAM_REPORT_WORDS.sendNeedsLink);
  });

  it('says what the person can do about each', () => {
    expect(controlFailure(refused('report_unknown')).code).toBe('not_found');
    expect(controlFailure(refused('report_closed')).code).toBe('conflict');
    expect(controlFailure(refused('rate_limited')).code).toBe('rate_limited');
    expect(controlFailure(refused('team_reports_unavailable')).message).toBe(TEAM_REPORT_WORDS.off);
    expect(controlFailure(refused('forbidden not_invited')).message).toBe(TEAM_REPORT_WORDS.notInvited);
    expect(controlFailure(refused('forbidden link_off')).message).toBe(TEAM_REPORT_WORDS.sendNeedsLink);
    const full = controlFailure(refused('conflict too_many_open'));
    expect(full.code).toBe('conflict');
    expect(full.message).toContain('20 open reports');
    // A refusal the box doesn't know: Whombat's servers didn't take it, never that Link is off.
    expect(controlFailure(refused('refused something_new')).message).toBe(TEAM_REPORT_WORDS.refused);
    expect(controlFailure(new ManagerCallError('/x', 0, 'unreachable', 'no socket'))).toMatchObject({
      code: 'unavailable',
    });
    expect(controlFailure(new ManagerCallError('/x', 404, 'unavailable', 'Link is off')).message).toContain(
      'Link',
    );
  });
});

describe('the Link gate', () => {
  it('sends while Link runs, reads and withdraws while control knows the box, and nothing without the routes', () => {
    const services = {} as Services;
    let on = false;
    let known = false;
    const link = { on: () => on, known: () => known };
    const manager = new FakeTeam();
    const port: Partial<ManagerPort> = {
      teamReportsList: async () => manager.list(),
      teamReportsGet: async (r) => manager.get(r),
      teamReportsCreate: async (r) => manager.create(r),
      teamReportsReply: async (r) => manager.reply(r),
      teamReportsAct: async (r) => manager.act(r),
    };
    useTeamReports(
      services,
      { teamReportsList: port.teamReportsList },
      { on: () => true, known: () => true },
    );
    expect(teamPortOf(services, 'read')).toBeNull();
    useTeamReports(services, port, link);
    expect(teamPortOf(services, 'read')).toBeNull();
    // Link ended: control still knows the box.
    known = true;
    expect(teamPortOf(services, 'read')).not.toBeNull();
    expect(teamPortOf(services, 'send')).toBeNull();
    on = true;
    expect(teamPortOf(services, 'send')).not.toBeNull();
  });

  it('drops the copies once the manager says the box is out of Link, never on a view it only assumed', () => {
    const view = (state: string, over: { enabled?: boolean; assumed?: boolean } = {}) => ({
      enabled: true,
      assumed: false,
      link: { state },
      ...over,
    });
    expect(teamReportsLeftLink(view('off'))).toBe(true);
    expect(teamReportsLeftLink(view('on', { enabled: false }))).toBe(true);
    for (const state of ['starting', 'on', 'grace', 'ended'])
      expect(teamReportsLeftLink(view(state))).toBe(false);
    expect(teamReportsLeftLink(view('off', { assumed: true }))).toBe(false);
  });
});

/** A whole report with `n` messages of `size` characters each (multi-byte: 3 bytes in UTF-8 each). */
function longReport(n: number, size = 6000) {
  return TeamReport.parse({
    id: 'tr_AAAAAAAAAAAAAAAAAAAA',
    number: 7,
    kind: 'bug',
    title: 'The map is blank',
    status: 'investigating',
    createdAt: 1_790_000_000,
    updatedAt: 1_790_000_000 + n,
    revision: n,
    text: '地'.repeat(6000),
    expected: '図'.repeat(1500),
    context: { client: 'web', device: 'Firefox 146 · Linux' },
    messages: Array.from({ length: n }, (_, i) => ({
      id: `m${i}`,
      author: i % 2 ? 'team' : 'reporter',
      text: `${i}:${'返'.repeat(size - String(i).length - 1)}`,
      at: 1_790_000_000 + i,
    })),
  });
}

describe('a whole report in one answer', () => {
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

  it('keeps a short conversation whole', () => {
    const report = longReport(3, 200);
    expect(fitTeamReport(report)).toEqual({ report, earlier: 0 });
  });

  it('keeps the report’s own words and the newest messages, and counts the oldest it left out', () => {
    const report = longReport(200);
    const fitted = fitTeamReport(report);
    expect(size(fitted)).toBeLessThanOrEqual(TEAM_REPORT_ANSWER_MAX_BYTES);
    expect(fitted.earlier).toBeGreaterThan(0);
    expect(fitted.report.messages.length + fitted.earlier).toBe(200);
    expect(fitted.report.text).toBe(report.text);
    expect(fitted.report.expected).toBe(report.expected);
    expect(fitted.report.messages.at(-1)?.id).toBe('m199');
    expect(fitted.report.messages[0]?.id).toBe(`m${fitted.earlier}`);
    // Still the contract's shape.
    expect(TeamReport.safeParse(fitted.report).success).toBe(true);
  });

  it('fits a list of 100 reports with the longest titles the contract allows, cutting titles first', () => {
    const row = (i: number) => ({
      id: `tr_${String(i).padStart(20, 'A')}`,
      number: i + 1,
      kind: 'bug' as const,
      // Three bytes a letter, and a quote JSON escapes.
      title: `"${'地'.repeat(199)}`,
      status: (i % 2 ? 'closed' : 'investigating') as TeamReportStatus,
      createdAt: 1_790_000_000 - i,
      updatedAt: 1_790_000_000 - i,
      revision: 0,
      unread: false,
    });
    const list = {
      available: true,
      reason: null,
      stale: false,
      reports: Array.from({ length: 100 }, (_, i) => row(i)),
    };
    expect(size(list)).toBeGreaterThan(64 * 1024);
    const fitted = fitTeamReportsList(list);
    expect(size(fitted)).toBeLessThanOrEqual(TEAM_REPORT_ANSWER_MAX_BYTES);
    expect(fitted.reports).toHaveLength(100);
    expect(fitted.reports[0]?.title.endsWith('…')).toBe(true);
    expect(fitted.reports.every((r) => r.title.length <= 200)).toBe(true);
    // A short list stays as it is.
    const short = { ...list, reports: list.reports.slice(0, 3) };
    expect(fitTeamReportsList(short)).toBe(short);
    // Too little room even for short titles: the oldest closed reports are left out first, then the oldest others.
    const tight = fitTeamReportsList(list, 20_000);
    expect(size(tight)).toBeLessThanOrEqual(20_000);
    expect(tight.reports.length).toBeLessThan(100);
    expect(tight.reports.filter((r) => r.status !== 'closed')).toHaveLength(50);
    const closed = tight.reports.filter((r) => r.status === 'closed').map((r) => r.number);
    expect(closed).toEqual(
      list.reports
        .filter((r) => r.status === 'closed')
        .slice(0, closed.length)
        .map((r) => r.number),
    );
    const tighter = fitTeamReportsList(list, 12_000);
    expect(size(tighter)).toBeLessThanOrEqual(12_000);
    expect(tighter.reports.every((r) => r.status !== 'closed')).toBe(true);
    expect(tighter.reports[0]?.id).toBe(list.reports[0]?.id);
  });

  it('fits a session message with room to spare for any report the contract allows', () => {
    for (const n of [1, 2, 5, 200]) {
      const fitted = fitTeamReport(longReport(n));
      expect(size(fitted)).toBeLessThan(64 * 1024 - 8 * 1024);
      // The newest message always fits beside the report's own words.
      expect(fitted.report.messages.length).toBeGreaterThan(0);
    }
  });
});

describe('the box’s copy', () => {
  const copy = { status: 'investigating', revision: 3, title: 'Map', updatedAt: new Date(1_790_000_100_000) };
  const summary = (
    over: Partial<{ status: TeamReportStatus; revision: number; title: string; updatedAt: number }>,
  ) => ({
    status: 'investigating' as TeamReportStatus,
    revision: 3,
    title: 'Map',
    updatedAt: 1_790_000_100,
    ...over,
  });

  it('isn’t moved back by an answer that crossed a newer one', () => {
    expect(teamReportOlderThanCopy(copy, summary({ revision: 2 }))).toBe(true);
    expect(teamReportOlderThanCopy(copy, summary({ updatedAt: 1_790_000_050 }))).toBe(true);
    expect(teamReportOlderThanCopy(copy, summary({}))).toBe(false);
    expect(teamReportOlderThanCopy(copy, summary({ revision: 4, updatedAt: 1_790_000_050 }))).toBe(false);
    expect(sameTeamReportSummary(copy, summary({ revision: 2, status: 'new' }))).toBe(true);
  });

  it('needs no write when control’s list says what the copies say', () => {
    const row = (id: string) =>
      ({ reportId: id, ...copy }) as unknown as Parameters<typeof teamListMatchesCopies>[1][number];
    const listed = (id: string, over = {}) => ({
      id,
      number: 1,
      kind: 'bug' as const,
      createdAt: 1_790_000_000,
      ...summary(over),
    });
    const a = 'tr_AAAAAAAAAAAAAAAAAAAA';
    const b = 'tr_BBBBBBBBBBBBBBBBBBBB';
    expect(teamListMatchesCopies([listed(a)], [row(a)], true)).toBe(true);
    expect(teamListMatchesCopies([listed(a, { revision: 4 })], [row(a)], true)).toBe(false);
    expect(teamListMatchesCopies([listed(a), listed(b)], [row(a)], true)).toBe(false);
    // A copy control no longer lists goes, but only with the whole list.
    expect(teamListMatchesCopies([listed(a)], [row(a), row(b)], true)).toBe(false);
    expect(teamListMatchesCopies([listed(a)], [row(a), row(b)], false)).toBe(true);
  });
});

describe('following the answers', () => {
  it('looks first shortly after start, at a moment of its own, then every ten minutes', () => {
    expect(teamReportsFollowPeriod(false, 0)).toBe(TEAM_REPORTS_FIRST_MS);
    expect(teamReportsFollowPeriod(false, 0.999)).toBeLessThan(
      TEAM_REPORTS_FIRST_MS + TEAM_REPORTS_FIRST_JITTER_MS,
    );
    expect(teamReportsFollowPeriod(false, 0.999)).toBeLessThan(TEAM_REPORTS_FOLLOW_MS / 5);
    expect(teamReportsFollowPeriod(true)).toBe(TEAM_REPORTS_FOLLOW_MS);
  });
});

describe('the stand-in team', () => {
  it('numbers reports, answers each once a moment later, and does a request once', () => {
    let now = 1_790_000_000_000;
    const team = new FakeTeam({ now: () => now, replyAfterMs: 5_000 });
    const payload = encodeTeamPayload(draft);
    const one = decodeTeamPayload(TeamReport, team.create({ requestId: 'r'.repeat(16), payload }).report);
    const again = decodeTeamPayload(TeamReport, team.create({ requestId: 'r'.repeat(16), payload }).report);
    expect(again).toEqual(one);
    team.create({ requestId: 's'.repeat(16), payload });
    let list = decodeTeamPayload(TeamReportList, team.list().reports).reports;
    expect(list.map((r) => [r.number, r.status, r.revision])).toEqual([
      [2, 'new', 0],
      [1, 'new', 0],
    ]);
    now += 5_000;
    list = decodeTeamPayload(TeamReportList, team.list().reports).reports;
    expect(list.map((r) => [r.status, r.revision])).toEqual([
      ['investigating', 1],
      ['investigating', 1],
    ]);
    const id = list[0]?.id as string;
    expect(team.reports.get(id)?.messages.map((m) => [m.author, m.text])).toEqual([
      ['team', FAKE_TEAM_FIRST_ANSWER],
    ]);
    expect(() => team.act({ requestId: 't'.repeat(16), reportId: id, action: 'works' })).toThrow(
      FakeTeamRefusal,
    );
    // As control: Still happening opens the report again as new, and the person's own press moves no revision (it
    // counts the team's changes only).
    team.teamSays(id, 'Try the next update', 'available');
    const offered = team.reports.get(id)?.revision as number;
    const again2 = decodeTeamPayload(
      TeamReport,
      team.act({ requestId: 'w'.repeat(16), reportId: id, action: 'still_happening' }).report as string,
    );
    expect(again2).toMatchObject({ status: 'new', revision: offered });
    // Sending isn't open: refused with control's own reason.
    team.available = false;
    team.reason = 'not_invited';
    expect(() => team.create({ requestId: 'v'.repeat(16), payload })).toThrow(
      expect.objectContaining({ code: 'not_invited' }),
    );
    team.reason = 'off';
    expect(() => team.create({ requestId: 'v'.repeat(16), payload })).toThrow(
      expect.objectContaining({ code: 'team_reports_unavailable' }),
    );
    expect(team.act({ requestId: 'u'.repeat(16), reportId: id, action: 'withdraw' })).toEqual({
      report: null,
    });
    expect(() => team.get({ reportId: id })).toThrow(FakeTeamRefusal);
  });

  it('answers the manager’s team report paths in development, with control’s refusals', () => {
    const team = new FakeTeam();
    const list = standInAnswer('/v1/runtime/team-reports/list', {}, undefined, team);
    expect(list).toMatchObject({ status: 200, body: { available: true, reason: null } });
    const made = standInAnswer(
      '/v1/runtime/team-reports/create',
      { requestId: 'r'.repeat(16), payload: encodeTeamPayload(draft) },
      undefined,
      team,
    );
    expect(made.status).toBe(200);
    const unknown = standInAnswer(
      '/v1/runtime/team-reports/get',
      { reportId: 'tr_BBBBBBBBBBBBBBBBBBBB' },
      undefined,
      team,
    );
    expect(unknown.status).toBe(502);
    expect(JSON.stringify(unknown.body)).toContain('report_unknown');
  });
});

describe('a tracker connection’s own signature', () => {
  it('signs replies with the connection’s words when it has them, else as before', () => {
    expect(connectionSignature({ signature: '  Whombat Team (AI assistant) ' })).toBe(
      'Whombat Team (AI assistant)',
    );
    expect(connectionSignature({ signature: '' })).toBeNull();
    expect(connectionSignature({})).toBeNull();
    expect(connectionSignature({ signature: 'x'.repeat(61) })).toBeNull();
    expect(connectionSignature(null) ?? customerSignature('Dusty')).toBe(customerSignature('Dusty'));
  });
});
