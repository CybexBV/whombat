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
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { standInAnswer } from '../managed/dev-standins';
import { FAKE_TEAM_FIRST_ANSWER, FakeTeam, FakeTeamRefusal } from '../managed/fake-team';
import { ManagerCallError, type ManagerPort } from '../managed/ports';
import type { Services } from '../services';
import { TEAM_REPORT_NOTICE_WORDS, teamReportEnteredNeedsYou, teamReportNoticeTitle } from './commands';
import { controlFailure, refusalCode, teamPortOf, useTeamReports } from './control';
import { teamReportItem } from './inbox';
import { decodeTeamPayload, encodeTeamPayload, TeamPayloadError } from './payload';
import { teamReportUnread } from './service';

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
  });

  it('says what the person can do about each', () => {
    expect(controlFailure(refused('report_unknown')).code).toBe('not_found');
    expect(controlFailure(refused('report_closed')).code).toBe('conflict');
    expect(controlFailure(refused('rate_limited')).code).toBe('rate_limited');
    expect(controlFailure(refused('team_reports_unavailable')).code).toBe('not_allowed');
    expect(controlFailure(new ManagerCallError('/x', 0, 'unreachable', 'no socket'))).toMatchObject({
      code: 'unavailable',
    });
    expect(controlFailure(new ManagerCallError('/x', 404, 'unavailable', 'Link is off')).message).toContain(
      'Link',
    );
  });
});

describe('the Link gate', () => {
  it('reaches the team only while Link runs, and not at all without the manager’s routes', () => {
    const services = {} as Services;
    let on = false;
    const manager = new FakeTeam();
    const port: Partial<ManagerPort> = {
      teamReportsList: async () => manager.list(),
      teamReportsGet: async (r) => manager.get(r),
      teamReportsCreate: async (r) => manager.create(r),
      teamReportsReply: async (r) => manager.reply(r),
      teamReportsAct: async (r) => manager.act(r),
    };
    useTeamReports(services, { teamReportsList: port.teamReportsList }, () => true);
    expect(teamPortOf(services)).toBeNull();
    useTeamReports(services, port, () => on);
    expect(teamPortOf(services)).toBeNull();
    on = true;
    expect(teamPortOf(services)).not.toBeNull();
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
