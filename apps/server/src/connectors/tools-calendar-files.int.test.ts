/**
 * Calendar, files, docs, sheets and contacts tools over MCP with the fake Google (docs/decisions/connectors.md
 * "Tools"): changes without guests go ahead, anything that emails guests (including changes to an event that
 * already has guests) asks the person first (in a turn for them, one-agent.md OA-10), sharing and trashing always ask, and the log holds no content.
 */
import { agentDefaultGrants } from '@whombat/core';
import { and, eq, gt } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideApproval } from '../commands/approvals';
import { approvals, events, grants } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { mcpClient, type TestMcp } from '../test/mcp';
import { addPersonalAgent, FAKE_ACCESS_TOKEN, type PersonalSetup } from '../test/personal';
import { agentTokenFor } from '../test/tokens';
import type { FakeGoogleWorkspace } from './workspace-fake';

const t = useTestServer({ seed: true, listen: true });
const clients: TestMcp[] = [];
let maraChat: PersonalSetup;
let fake: FakeGoogleWorkspace;
let mcp: TestMcp;
let startSeq = 0;

const state = () => fake.stateFor(FAKE_ACCESS_TOKEN);

async function headSeq(): Promise<number> {
  const rows = await t.services.db
    .select({ seq: events.seq })
    .from(events)
    .where(eq(events.burrowId, t.burrowId));
  return Math.max(0, ...rows.map((r) => r.seq));
}

async function eventsSince(seq: number) {
  return t.services.db
    .select()
    .from(events)
    .where(and(eq(events.burrowId, t.burrowId), gt(events.seq, seq)))
    .orderBy(events.seq);
}

async function approve(approvalId: string) {
  const [row] = await t.services.db.select().from(approvals).where(eq(approvals.id, approvalId));
  if (!row) throw new Error('no approval');
  const res = await t.commit(IDS.mara, decideApproval, { number: row.number, decision: 'approve' });
  expect(res.status).toBe('ok');
  const [after] = await t.services.db.select().from(approvals).where(eq(approvals.id, approvalId));
  return after;
}

async function texts(since: number) {
  return (await eventsSince(since)).filter((r) => r.text).map((r) => r.text);
}

beforeAll(async () => {
  // Dusty with the keys a new Whombat's agent holds, a person's account keys among them (one-agent.md OA-05); the
  // test world's Dusty holds the mock crew's.
  maraChat = await addPersonalAgent(t.services, t.burrowId, IDS.mara, {
    grants: agentDefaultGrants(IDS.dusty),
  });
  fake = t.services.google.workspace as FakeGoogleWorkspace;
  const { token } = await agentTokenFor(t.services, t.burrowId, maraChat.agentId, maraChat.dmId);
  mcp = await mcpClient(t.baseUrl, token);
  clients.push(mcp);
  startSeq = await headSeq();
});

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
});

describe('calendar', () => {
  it('lists upcoming events without an event in the log', async () => {
    const before = await headSeq();
    const res = await mcp.call('calendar_events', { limit: 10 });
    expect(res).toMatchObject({ isError: false, body: { status: 'ok' } });
    const list = res.body.events as { summary: string; guests: unknown[] }[];
    expect(list.map((e) => e.summary)).toEqual(['Standup', 'Dentist', 'Q3 planning', 'Team offsite']);
    expect(await eventsSince(before)).toEqual([]);
  });

  it('adds, changes and deletes events without guests right away', async () => {
    const before = await headSeq();
    const created = await mcp.call('calendar_create_event', {
      summary: 'Focus time',
      start: '2026-10-01T09:00:00+02:00',
      end: '2026-10-01T11:00:00+02:00',
    });
    expect(created.body).toMatchObject({ status: 'ok', event: { summary: 'Focus time', guests: [] } });
    const id = (created.body.event as { id: string }).id;
    const changed = await mcp.call('calendar_update_event', { eventId: id, location: 'Home' });
    expect(changed.body).toMatchObject({ status: 'ok', event: { location: 'Home' } });
    const dentist = await mcp.call('calendar_delete_event', { eventId: 'evt_dentist' });
    expect(dentist.body).toEqual({ status: 'ok', deleted: true });
    expect(state().events.some((e) => e.id === 'evt_dentist')).toBe(false);
    expect(state().calendarMail).toEqual([]);
    const rows = await eventsSince(before);
    expect(rows.map((r) => [r.text, r.where, r.keyUsed?.id])).toEqual([
      ['Created an event', 'Google Calendar', 'calendar.write'],
      ['Changed an event', 'Google Calendar', 'calendar.write'],
      ['Deleted an event', 'Google Calendar', 'calendar.write'],
    ]);
  });

  it('asks before inviting guests, then creates the event and sends the invite', async () => {
    const before = await headSeq();
    const asked = await mcp.call('calendar_create_event', {
      summary: 'Invoice review',
      start: '2026-10-02T14:00:00+02:00',
      end: '2026-10-02T14:30:00+02:00',
      guests: ['priya@northwind.example'],
      addMeet: true,
    });
    expect(asked.body.status).toBe('pending_approval');
    expect(state().events.some((e) => e.summary === 'Invoice review')).toBe(false);
    const done = await approve(asked.body.approvalId as string);
    expect(done).toMatchObject({
      title: 'Send a calendar invite for “Invoice review” to 1 person',
      target: 'Google Calendar · Invoice review',
      whatHappens: [
        'Add “Invoice review” to the calendar and email 1 guest',
        'When: 2 Oct 14:00–14:30',
        'Guests: priya@northwind.example',
      ],
      execution: { state: 'succeeded' },
    });
    const event = state().events.find((e) => e.summary === 'Invoice review');
    expect(event?.meetUrl).toMatch(/^https:\/\/meet\.google\.com\//);
    expect(state().calendarMail.at(-1)).toMatchObject({
      kind: 'invite',
      guests: ['priya@northwind.example'],
    });
    expect(await texts(before)).toEqual([
      'Asked to send a calendar invite',
      'Approved Dusty’s request to send a calendar invite',
      'Sent a calendar invite',
    ]);
  });

  it('asks before changing or cancelling an event that already has guests', async () => {
    const before = await headSeq();
    // No guests in the input, but the standup has two: moving it emails them.
    const moved = await mcp.call('calendar_update_event', {
      eventId: 'evt_standup',
      start: '2026-10-03T10:00:00+02:00',
      end: '2026-10-03T10:15:00+02:00',
    });
    expect(moved.body.status).toBe('pending_approval');
    const [pending] = await t.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, moved.body.approvalId as string));
    expect(pending?.keyId).toBe('calendar.invite');
    expect(pending?.action).toMatchObject({
      type: 'calendar_invite',
      params: {
        op: 'update',
        eventId: 'evt_standup',
        summary: 'Standup',
        guests: ['joris@example.org', 'priya@northwind.example'],
      },
    });
    expect(state().events.find((e) => e.id === 'evt_standup')?.start).not.toBe('2026-10-03T10:00:00+02:00');
    await approve(moved.body.approvalId as string);
    const standup = state().events.find((e) => e.id === 'evt_standup');
    expect(standup?.start).toBe('2026-10-03T10:00:00+02:00');
    // The guests and their answers stay.
    expect(standup?.guests.map((g) => [g.email, g.response])).toEqual([
      ['joris@example.org', 'accepted'],
      ['priya@northwind.example', 'needs_action'],
    ]);
    expect(state().calendarMail.at(-1)).toMatchObject({ kind: 'update', eventId: 'evt_standup' });

    const cancel = await mcp.call('calendar_delete_event', { eventId: 'evt_q3' });
    expect(cancel.body.status).toBe('pending_approval');
    await approve(cancel.body.approvalId as string);
    expect(state().events.some((e) => e.id === 'evt_q3')).toBe(false);
    expect(state().calendarMail.at(-1)).toEqual({
      kind: 'cancel',
      eventId: 'evt_q3',
      guests: ['mara@okafor.example'],
    });
    expect(await texts(before)).toEqual([
      'Asked to send an updated calendar invite',
      'Approved Dusty’s request to send an updated calendar invite',
      'Sent an updated calendar invite',
      'Asked to cancel an event',
      'Approved Dusty’s request to cancel an event',
      'Cancelled an event',
    ]);
  });
});

describe('files, docs and sheets', () => {
  it('searches and reads documents as Markdown and spreadsheets as CSV, without events', async () => {
    const before = await headSeq();
    const found = await mcp.call('files_search', { query: 'budget' });
    expect((found.body.files as { name: string }[]).map((f) => f.name).sort()).toEqual([
      'Budget 2026',
      'Q3 plan',
    ]);
    const doc = await mcp.call('files_read', { fileId: 'file_q3plan' });
    expect(doc.body).toMatchObject({ status: 'ok', format: 'markdown', truncated: false });
    expect(doc.body.content).toContain('# Q3 plan');
    const sheet = await mcp.call('files_read', { fileId: 'file_budget' });
    expect(sheet.body).toMatchObject({ format: 'csv' });
    const pdf = await mcp.call('files_read', { fileId: 'file_invoice_pdf' });
    expect(pdf.body).toMatchObject({ format: 'none', content: null, file: { kind: 'pdf' } });
    const cells = await mcp.call('sheets_read', { spreadsheetId: 'file_budget', range: 'Sheet1!A1:B3' });
    expect(cells.body).toMatchObject({
      status: 'ok',
      values: [
        ['Item', 'Q1'],
        ['Design', 4000],
        ['Hosting', 320],
      ],
    });
    const contacts = await mcp.call('contacts_search', { query: 'northwind' });
    expect(contacts.body).toMatchObject({ contacts: [{ name: 'Priya Shah', organization: 'Northwind' }] });
    expect(await eventsSince(before)).toEqual([]);
  });

  it('creates files and edits docs and sheets right away', async () => {
    const before = await headSeq();
    const created = await mcp.call('files_create', { kind: 'doc', name: 'Call notes', content: '# Call' });
    expect(created.body).toMatchObject({ status: 'ok', file: { name: 'Call notes', kind: 'doc' } });
    const edited = await mcp.call('docs_edit', {
      documentId: 'file_q3plan',
      edits: [
        { op: 'replace', find: 'Hire a second designer', text: 'Hire a designer' },
        { op: 'append', text: '\n## Risks\n' },
      ],
    });
    expect(edited.body).toEqual({ status: 'ok', applied: 2 });
    expect(state().files.find((f) => f.file.id === 'file_q3plan')?.content).toContain('- Hire a designer\n');
    const written = await mcp.call('sheets_write', {
      spreadsheetId: 'file_budget',
      range: 'Sheet1!E1:E2',
      values: [['Q4'], [6000]],
    });
    expect(written.body).toEqual({ status: 'ok', range: 'Sheet1!E1:E2', updatedCells: 2 });
    expect(await texts(before)).toEqual(['Created a doc', 'Edited a doc', 'Edited a spreadsheet']);
  });

  it('shares and trashes only after the person approves; the log names no file or person', async () => {
    const before = await headSeq();
    const share = await mcp.call('files_share', {
      fileId: 'file_q3plan',
      email: 'Joris@Example.org',
      role: 'writer',
    });
    expect(share.body.status).toBe('pending_approval');
    const [pending] = await t.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, share.body.approvalId as string));
    expect(pending).toMatchObject({
      title: 'Share “Q3 plan” with joris@example.org',
      target: 'Google Drive · Q3 plan',
      whatHappens: ['Share “Q3 plan” with joris@example.org as an editor'],
    });
    expect(state().files.find((f) => f.file.id === 'file_q3plan')?.permissions).toEqual([]);
    await approve(share.body.approvalId as string);
    expect(state().files.find((f) => f.file.id === 'file_q3plan')?.permissions).toEqual([
      { email: 'joris@example.org', role: 'writer' },
    ]);

    const trash = await mcp.call('files_trash', { fileId: 'file_notes' });
    expect(trash.body.status).toBe('pending_approval');
    expect(state().files.find((f) => f.file.id === 'file_notes')?.trashed).toBe(false);
    await approve(trash.body.approvalId as string);
    expect(state().files.find((f) => f.file.id === 'file_notes')?.trashed).toBe(true);

    expect(await texts(before)).toEqual([
      'Asked to share a file',
      'Approved Dusty’s request to share a file',
      'Shared a file',
      'Asked to move a file to the trash',
      'Approved Dusty’s request to move a file to the trash',
      'Moved a file to the trash',
    ]);
  });

  it('trashes a file without asking once the person allows it', async () => {
    const allow = (tier: 'can' | 'ask') =>
      t.services.db
        .update(grants)
        .set({ tier })
        .where(and(eq(grants.agentId, maraChat.agentId), eq(grants.keyId, 'files.delete')));
    const file = () => state().files.find((f) => f.file.id === 'file_budget');
    await allow('can');
    try {
      const res = await mcp.call('files_trash', { fileId: 'file_budget' });
      expect(res.body).toMatchObject({ status: 'ok', trashed: true });
      expect(file()?.trashed).toBe(true);
    } finally {
      await allow('ask');
      const f = file();
      if (f) f.trashed = false;
    }
  });

  it('a missing file is a clear not-found, before anything is asked', async () => {
    const res = await mcp.call('files_trash', { fileId: 'file_nope' });
    expect(res.body).toMatchObject({
      error: { code: 'not_found', message: 'Google Drive has nothing with that id.' },
    });
  });
});

describe('the audit log across every tool', () => {
  it('holds no subjects, recipients, file names, event titles or content', async () => {
    const rows = await eventsSince(startSeq);
    expect(rows.length).toBeGreaterThan(10);
    const words = [
      'Q3 plan',
      'Budget',
      'Meeting notes',
      'Invoice review',
      'Standup',
      'Focus time',
      'Call notes',
      'joris@',
      'priya@',
      'mara@okafor',
      'Northwind',
      'designer',
    ];
    for (const row of rows) {
      const blob = `${row.text ?? ''} ${row.where ?? ''} ${JSON.stringify(row.payload)}`;
      for (const w of words) expect(blob, `event ${row.type} “${row.text}” holds “${w}”`).not.toContain(w);
    }
  });
});
