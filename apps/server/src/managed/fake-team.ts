/**
 * A stand-in for control's side of the reports to the Whombat Team (docs/decisions/team-reports.md), in memory: the
 * development box's manager stand-in answers the team report paths with it, so `pnpm dev` shows the whole way, and tests
 * use it as the fake manager's control. It keeps reports as control would (numbered, only the team's changes counted in
 * `revision`, a request done once per request id, Still happening opening it again as new) and refuses as control
 * does, with its codes. With `replyAfterMs` the
 * team answers each new report once, that long after it came, the next time it is asked about: no timers to stop.
 */
import { randomBytes } from 'node:crypto';
import type { TeamReportRefusalCode } from '@whombat/control-contracts/device';
import {
  TEAM_REPORT_CLOSED,
  TEAM_REPORT_MESSAGES_MAX,
  TEAM_REPORTS_LIST_MAX,
  type TeamReport,
  type TeamReportAction,
  TeamReportDraft,
  TeamReportReply,
  type TeamReportStatus,
  type TeamReportsUnavailable,
  teamReportCanConfirm,
  teamReportExcerptTitle,
} from '@whombat/core/domain';
import { decodeTeamPayload, encodeTeamPayload, TeamPayloadError } from '../team-reports/payload';

/** What the stand-in team says to every new report in development. */
export const FAKE_TEAM_FIRST_ANSWER = 'Thank you for telling us. We’re looking into it.';

/** Control refused: its code, as the manager puts it first in its message. */
export class FakeTeamRefusal extends Error {
  constructor(
    readonly code: TeamReportRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'FakeTeamRefusal';
  }
}

export interface FakeTeamOptions {
  /** Milliseconds now (tests move it). */
  now?: () => number;
  /** The team's first answer comes this long after a report; null: the team says nothing by itself. */
  replyAfterMs?: number | null;
}

export class FakeTeam {
  /** Whether the person may send, and why not (`team.reports.list`). */
  available = true;
  reason: TeamReportsUnavailable | null = null;
  /** The reports as control keeps them, by id. */
  readonly reports = new Map<string, TeamReport>();
  /** Every op asked, in order (tests). */
  readonly asked: string[] = [];
  readonly #done = new Map<string, TeamReport | null>();
  readonly #answered = new Set<string>();
  #number = 0;
  #message = 0;

  constructor(private readonly options: FakeTeamOptions = {}) {}

  #seconds(): number {
    return Math.floor((this.options.now?.() ?? Date.now()) / 1000);
  }

  /** The team's first answer, once its time came. */
  #catchUp(): void {
    const after = this.options.replyAfterMs;
    if (after === null || after === undefined) return;
    const now = this.#seconds();
    for (const report of this.reports.values()) {
      if (this.#answered.has(report.id) || (now - report.createdAt) * 1000 < after) continue;
      this.#answered.add(report.id);
      if (report.status === 'new') this.teamSays(report.id, FAKE_TEAM_FIRST_ANSWER, 'investigating');
    }
  }

  #report(reportId: string): TeamReport {
    const report = this.reports.get(reportId);
    if (!report) throw new FakeTeamRefusal('report_unknown', 'No such report.');
    return report;
  }

  #messageId(): string {
    this.#message += 1;
    return `m${this.#message}`;
  }

  list(): { available: boolean; reason: TeamReportsUnavailable | null; reports: string } {
    this.asked.push('list');
    this.#catchUp();
    const reports = [...this.reports.values()]
      .sort((a, b) => b.createdAt - a.createdAt || b.number - a.number)
      .slice(0, TEAM_REPORTS_LIST_MAX)
      .map(({ text: _t, expected: _e, context: _c, messages: _m, ...summary }) => summary);
    return { available: this.available, reason: this.reason, reports: encodeTeamPayload({ reports }) };
  }

  get(input: { reportId: string }): { report: string } {
    this.asked.push('get');
    this.#catchUp();
    return { report: encodeTeamPayload(this.#report(input.reportId)) };
  }

  create(input: { requestId: string; payload: string }): { report: string } {
    this.asked.push('create');
    const again = this.#done.get(input.requestId);
    if (again) return { report: encodeTeamPayload(this.reports.get(again.id) ?? again) };
    // Control says why in its code: the team's switch is `team_reports_unavailable`, the others their own reason.
    if (!this.available)
      throw new FakeTeamRefusal(
        this.reason && this.reason !== 'off' ? this.reason : 'team_reports_unavailable',
        'Reports can’t be sent now.',
      );
    let draft: TeamReportDraft;
    try {
      draft = decodeTeamPayload(TeamReportDraft, input.payload);
    } catch (err) {
      if (err instanceof TeamPayloadError) throw new FakeTeamRefusal('validation_failed', err.message);
      throw err;
    }
    this.#number += 1;
    const now = this.#seconds();
    const report: TeamReport = {
      id: `tr_${randomBytes(15).toString('base64url')}`,
      number: this.#number,
      kind: draft.kind,
      title: teamReportExcerptTitle(draft.text),
      status: 'new',
      createdAt: now,
      updatedAt: now,
      revision: 0,
      text: draft.text,
      expected: draft.expected,
      context: draft.context,
      messages: [],
    };
    this.reports.set(report.id, report);
    this.#done.set(input.requestId, report);
    return { report: encodeTeamPayload(report) };
  }

  reply(input: { requestId: string; reportId: string; payload: string }): { report: string } {
    this.asked.push('reply');
    const report = this.#report(input.reportId);
    if (this.#done.has(input.requestId)) return { report: encodeTeamPayload(report) };
    let reply: TeamReportReply;
    try {
      reply = decodeTeamPayload(TeamReportReply, input.payload);
    } catch (err) {
      if (err instanceof TeamPayloadError) throw new FakeTeamRefusal('validation_failed', err.message);
      throw err;
    }
    if (TEAM_REPORT_CLOSED.has(report.status) || report.messages.length >= TEAM_REPORT_MESSAGES_MAX)
      throw new FakeTeamRefusal('report_closed', 'This report takes no more replies.');
    const now = this.#seconds();
    // An answer to the team's question puts the report back with the team; the person's own words change no revision.
    const status: TeamReportStatus = report.status === 'needs_information' ? 'investigating' : report.status;
    const next: TeamReport = {
      ...report,
      status,
      updatedAt: now,
      messages: [
        ...report.messages,
        { id: this.#messageId(), author: 'reporter', text: reply.text, at: now },
      ],
    };
    this.reports.set(next.id, next);
    this.#done.set(input.requestId, next);
    return { report: encodeTeamPayload(next) };
  }

  act(input: { requestId: string; reportId: string; action: TeamReportAction }): { report: string | null } {
    this.asked.push(`act ${input.action}`);
    if (this.#done.has(input.requestId)) {
      const done = this.#done.get(input.requestId);
      return { report: done ? encodeTeamPayload(this.reports.get(done.id) ?? done) : null };
    }
    const report = this.#report(input.reportId);
    if (input.action === 'withdraw') {
      this.reports.delete(report.id);
      this.#done.set(input.requestId, null);
      return { report: null };
    }
    if (!teamReportCanConfirm(report.status))
      throw new FakeTeamRefusal('report_closed', 'There is no fix to say anything about yet.');
    const now = this.#seconds();
    // As control: the person's press is an entry of theirs with the status it gave; Still happening opens it again as
    // new. The revision the box reads counts the team's changes only, so the person's own press moves none.
    const status: TeamReportStatus = input.action === 'works' ? 'confirmed' : 'new';
    const next: TeamReport = {
      ...report,
      status,
      updatedAt: now,
      messages: [
        ...report.messages,
        { id: this.#messageId(), author: 'reporter', text: '', at: now, status },
      ],
    };
    this.reports.set(next.id, next);
    this.#done.set(input.requestId, next);
    return { report: encodeTeamPayload(next) };
  }

  /** The team writes in a report, and may change its status with it: a change the person hasn't read. */
  teamSays(reportId: string, text: string, status?: TeamReportStatus): TeamReport {
    const report = this.#report(reportId);
    const now = Math.max(this.#seconds(), report.updatedAt);
    const next: TeamReport = {
      ...report,
      ...(status ? { status } : {}),
      updatedAt: now,
      revision: report.revision + 1,
      messages: [
        ...report.messages,
        { id: this.#messageId(), author: 'team', text, at: now, ...(status ? { status } : {}) },
      ],
    };
    this.reports.set(next.id, next);
    return next;
  }
}
