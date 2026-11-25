/**
 * Reports to the Whombat Team (docs/decisions/team-reports.md), end to end on the box with control faked behind the
 * manager: nothing goes without Link; a report goes with the box's version; the team's change shows as unread and is
 * told in fixed words; reading marks it read; a reply goes; the kept copy shows while control is out of reach; taking it
 * back deletes it at control and here; the assistant's draft becomes a card whose yes sends it as the person, and
 * sending it from the form instead withdraws the card. Needs Postgres: the copies, the drafts, the notification and the
 * approval go through the commit pipeline.
 */
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { decideApproval } from '../commands/approvals';
import { approvals, events, messages, notifications, teamReportCopies } from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import { ManagerCallError } from '../managed/ports';
import { FakeManager } from '../managed/testing';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { sessionFor } from '../test/tokens';
import { askedTeamReportDraft, saveTeamReportDraft, sendTeamReportDraft } from './commands';
import { useTeamReports } from './control';
import { followTeamReports } from './follow';

const t = useTestServer({ seed: true, app: true });
const manager = new FakeManager();
let linkOn = false;
let mine: PersonalSetup;
let cookie: string;

beforeAll(async () => {
  mine = await addPersonalAgent(t.services, t.burrowId, IDS.mara, {
    name: 'Dusty',
    services: null,
    grants: [],
  });
  ({ cookie } = await sessionFor(t.services, IDS.mara));
  useTeamReports(t.services, manager, () => linkOn);
});

const req = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  t.api.inject({
    method,
    url: `/api/v1/burrows/burrow-hq${url}`,
    headers: { cookie },
    ...(payload === undefined ? {} : { payload }),
  });

const copyOf = async (reportId: string) =>
  (
    await t.services.db
      .select()
      .from(teamReportCopies)
      .where(and(eq(teamReportCopies.burrowId, t.burrowId), eq(teamReportCopies.reportId, reportId)))
  )[0];

describe('reports to the Whombat Team', () => {
  it('wait for Whombat Link: the list says so and nothing is sent', async () => {
    const list = await req('GET', '/team-reports');
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toMatchObject({ available: false, reason: 'link_off', reports: [], stale: false });
    const sent = await req('POST', '/team-reports', { kind: 'bug', text: 'The map is blank' });
    expect(sent.statusCode).toBe(503);
    expect(manager.team.reports.size).toBe(0);
  });

  it('go, follow the team’s answer, are read, replied to and taken back', async () => {
    linkOn = true;
    const made = await req('POST', '/team-reports', {
      kind: 'bug',
      text: 'The map stays blank after I open Find My',
      expected: 'My phone on the map',
      context: { client: 'web', appVersion: '3.158.0', language: 'en-GB' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const report = made.json().report;
    expect(report).toMatchObject({ number: 1, kind: 'bug', status: 'new', revision: 0 });
    // The app's words about itself and the box's own version went with it.
    const atControl = manager.team.reports.get(report.id);
    expect(atControl?.context).toMatchObject({ client: 'web', appVersion: '3.158.0', language: 'en-GB' });
    expect(atControl?.context.runtimeVersion).toBeTruthy();
    // The log says a report went, without its words.
    const [sentEvent] = await t.services.db.select().from(events).where(eq(events.type, 'team_report.sent'));
    expect(sentEvent?.payload).toMatchObject({ reportId: report.id, number: 1 });
    expect(JSON.stringify(sentEvent?.payload)).not.toContain('Find My');

    // The team asks something: unread, and the person is told in fixed words, never the team's.
    manager.team.teamSays(report.id, 'Which browser do you use?', 'needs_information');
    const asked = (await req('GET', '/team-reports')).json();
    expect(asked).toMatchObject({ available: true, reason: null, stale: false });
    expect(asked.reports).toEqual([
      expect.objectContaining({ id: report.id, status: 'needs_information', unread: true }),
    ]);
    const person = await thePerson(t.services.db, t.burrowId);
    const told = await t.services.db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupKey, `team-report:${report.id}:1`));
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ kind: 'needs_you', principalId: person?.id });
    expect(told[0]?.text).toContain('asked about your report');
    expect(told[0]?.text).not.toContain('browser');
    // Asking again tells nobody twice.
    await followTeamReports(t.services);
    expect(
      await t.services.db
        .select()
        .from(notifications)
        .where(eq(notifications.dedupKey, `team-report:${report.id}:1`)),
    ).toHaveLength(1);

    // Opening it reads it.
    const opened = await req('GET', `/team-reports/${report.id}`);
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json().report.messages.map((m: { author: string }) => m.author)).toEqual(['team']);
    expect((await req('GET', '/team-reports')).json().reports[0].unread).toBe(false);
    expect((await copyOf(report.id))?.readRevision).toBe(1);

    // The person answers: the report goes back to the team, and their own words make nothing unread.
    const replied = await req('POST', `/team-reports/${report.id}/replies`, { text: 'Firefox on Linux' });
    expect(replied.statusCode, replied.body).toBe(200);
    expect(replied.json().report).toMatchObject({ status: 'investigating', revision: 1 });
    expect((await req('GET', '/team-reports')).json().reports[0].unread).toBe(false);

    // Control out of reach: the kept copy, said to be one.
    manager.teamFails = new ManagerCallError(
      '/v1/runtime/team-reports/list',
      503,
      'control_unreachable',
      'down',
    );
    const stale = (await req('GET', '/team-reports')).json();
    expect(stale).toMatchObject({ available: false, reason: 'unreachable', stale: true });
    expect(stale.reports.map((r: { id: string }) => r.id)).toEqual([report.id]);
    const kept = await req('GET', `/team-reports/${report.id}`);
    expect(kept.statusCode).toBe(200);
    expect(kept.json().report.messages).toHaveLength(2);
    const notNow = await req('POST', `/team-reports/${report.id}/replies`, { text: 'Also Chrome' });
    expect(notNow.statusCode).toBe(503);
    manager.teamFails = null;

    // Taking it back deletes it at control and here.
    const back = await req('POST', `/team-reports/${report.id}/act`, { action: 'withdraw' });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json()).toEqual({ report: null });
    expect(manager.team.reports.has(report.id)).toBe(false);
    expect(await copyOf(report.id)).toBeUndefined();
    expect((await req('GET', '/team-reports')).json().reports).toEqual([]);
    const [withdrawn] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'team_report.withdrawn'));
    expect(withdrawn?.payload).toMatchObject({ reportId: report.id });
  });

  it('turn the assistant’s draft into a card that quotes it; the yes sends it as the person', async () => {
    linkOn = true;
    const saved = await t.commit(mine.agentId, saveTeamReportDraft, {
      kind: 'idea',
      text: 'Let me sort the Inbox by date',
      expected: '',
      personId: IDS.mara,
      conversationId: mine.dmId,
    });
    if (saved.status !== 'ok') throw new Error('draft');
    const draftId = (saved.result as { id: string }).id;
    const asked = await t.commit(mine.agentId, sendTeamReportDraft, { draftId });
    expect(asked.status).toBe('pending_approval');
    if (asked.status !== 'pending_approval') return;
    await t.commit(mine.agentId, askedTeamReportDraft, { draftId, approvalId: asked.approvalId });
    // Nothing goes before the person's yes; the card shows exactly what would.
    expect(manager.team.reports.size).toBe(0);
    const [a] = await t.services.db.select().from(approvals).where(eq(approvals.id, asked.approvalId));
    const [card] = await t.services.db
      .select({ text: messages.text })
      .from(messages)
      .where(eq(messages.id, a?.messageId ?? ''));
    expect(card?.text).toContain('Let me sort the Inbox by date');
    expect(a?.action).toMatchObject({ type: 'custom', params: { data: { draftId } } });
    // The form's Edit opens the draft.
    const open = await req('GET', `/team-report-drafts/${draftId}`);
    expect(open.statusCode, open.body).toBe(200);
    expect(open.json().draft).toMatchObject({ kind: 'idea', done: false });

    const yes = await t.commit(IDS.mara, decideApproval, { number: a?.number, decision: 'approve' });
    expect(yes.status).toBe('ok');
    await t.services.background.settle();
    const sent = [...manager.team.reports.values()];
    expect(sent.map((r) => [r.kind, r.text])).toEqual([['idea', 'Let me sort the Inbox by date']]);
    expect((await copyOf(sent[0]?.id ?? ''))?.createdById).toBe(IDS.mara);
    expect((await req('GET', `/team-report-drafts/${draftId}`)).json().draft.done).toBe(true);
  });

  it('leave a declined draft done, and nothing sent', async () => {
    linkOn = true;
    const before = manager.team.reports.size;
    const saved = await t.commit(mine.agentId, saveTeamReportDraft, {
      kind: 'bug',
      text: 'Settings forgets my time zone',
      expected: '',
      personId: IDS.mara,
      conversationId: mine.dmId,
    });
    if (saved.status !== 'ok') throw new Error('draft');
    const draftId = (saved.result as { id: string }).id;
    const asked = await t.commit(mine.agentId, sendTeamReportDraft, { draftId });
    if (asked.status !== 'pending_approval') throw new Error('no card');
    await t.commit(mine.agentId, askedTeamReportDraft, { draftId, approvalId: asked.approvalId });
    const [a] = await t.services.db.select().from(approvals).where(eq(approvals.id, asked.approvalId));
    const no = await t.commit(IDS.mara, decideApproval, { number: a?.number, decision: 'decline' });
    expect(no.status).toBe('ok');
    await t.services.background.settle();
    expect(manager.team.reports.size).toBe(before);
    expect((await req('GET', `/team-report-drafts/${draftId}`)).json().draft.done).toBe(true);
  });

  it('withdraw the card when the draft is sent from the form instead, and offer no later time before', async () => {
    linkOn = true;
    const before = manager.team.reports.size;
    const saved = await t.commit(mine.agentId, saveTeamReportDraft, {
      kind: 'bug',
      text: 'The calendar shows yesterday',
      expected: '',
      personId: IDS.mara,
      conversationId: mine.dmId,
    });
    if (saved.status !== 'ok') throw new Error('draft');
    const draftId = (saved.result as { id: string }).id;
    const asked = await t.commit(mine.agentId, sendTeamReportDraft, { draftId });
    if (asked.status !== 'pending_approval') throw new Error('no card');
    await t.commit(mine.agentId, askedTeamReportDraft, { draftId, approvalId: asked.approvalId });
    const [a] = await t.services.db.select().from(approvals).where(eq(approvals.id, asked.approvalId));
    // The Inbox asks now or not at all, as the card does.
    const home = await req('GET', '/home');
    expect(home.statusCode, home.body).toBe(200);
    const item = home
      .json()
      .needsYouList.find((i: { approvalNumber?: number }) => i.approvalNumber === a?.number);
    expect(item.actions.map((x: { kind: string }) => x.kind)).toEqual(['approve', 'decline']);

    // The person changes it in the form and sends it there.
    const made = await req('POST', '/team-reports', {
      kind: 'bug',
      text: 'The calendar shows yesterday after midnight',
      draftId,
    });
    expect(made.statusCode, made.body).toBe(201);
    expect(manager.team.reports.size).toBe(before + 1);
    expect(manager.team.reports.get(made.json().report.id)?.text).toContain('after midnight');
    // The card asks no more: declined by the person, signed as withdrawn.
    const [card] = await t.services.db.select().from(approvals).where(eq(approvals.id, asked.approvalId));
    expect(card).toMatchObject({ state: 'declined', decidedById: IDS.mara });
    const [why] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'approval.declined'), eq(events.approvalId, asked.approvalId)));
    expect(why?.payload).toMatchObject({ approvalId: asked.approvalId, withdrawn: true });
    expect((await req('GET', `/team-report-drafts/${draftId}`)).json().draft.done).toBe(true);
    await t.services.background.settle();
    expect(manager.team.reports.size).toBe(before + 1);
  });
});
