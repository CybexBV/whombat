/**
 * Looks ahead's look through new mail and what it keeps an eye on (docs/decisions/looks-ahead.md), end to end on a real
 * database:
 * - a triage pass lists the new mail (night mail too, noise and the person's own left out), is served only
 *   `ahead_triage`, and its picks start as mail checks one at a time; triage passes have their own budget and gap;
 * - mail that matches a matter the person asked for (`ahead_watch`) is checked at once and told in their thread beyond
 *   the day's findings, never at night; “Stop checking for this” under it closes the matter;
 * - a mail check opens a matter matched only by the mail's thread and sender, within the caps;
 * - a follow-up runs by the clock once per reason and closes a matter the check says is done;
 * - Settings shows matters and recent rows in the values older apps know, and the person removes a matter.
 * Postgres because every step is a signed commit and a queued turn.
 */
import {
  AHEAD_CHECKS_PER_DAY,
  AHEAD_FINDINGS_PER_DAY,
  AHEAD_MATTERS_MAX,
  AHEAD_MATTERS_OPENED_PER_DAY,
  LOOKS_AHEAD_WORDS,
  newId,
} from '@whombat/core';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueDispatchToken } from '../auth/agent-tokens';
import { sendMessage } from '../commands/messages';
import type { FakeGoogleState, FakeGoogleWorkspace } from '../connectors/workspace-fake';
import { aheadChecks, aheadMatters, burrows, dispatches, messages } from '../db/schema/index';
import { buildDispatchContext } from '../runtime/context';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent, FAKE_ACCESS_TOKEN, type PersonalSetup } from '../test/personal';
import { aheadSettingsOf, updateLooksAhead } from './commands';
import { looksAheadView } from './settings';
import { checkAheadNow, watchAhead } from './watch';

const t = useTestServer({ seed: true, listen: true });
let mine: PersonalSetup;
let realClock: () => Date;
let now = new Date('2026-12-14T09:00:00Z');
let google: FakeGoogleState;
let oldMail: FakeGoogleState['messages'];
const ready = { ready: async () => true };
const HOUR = 3600_000;

function mail(
  id: string,
  from: string,
  subject: string,
  at: string,
  extra: { threadId?: string; body?: string; unread?: boolean } = {},
) {
  google.messages.unshift({
    id,
    threadId: extra.threadId ?? `thr_${id}`,
    from,
    to: ['you@example.com'],
    cc: [],
    bcc: [],
    subject,
    date: new Date(at),
    body: extra.body ?? subject,
    labelIds: ['INBOX', ...(extra.unread ? ['UNREAD'] : [])],
    attachments: [],
  });
}

async function pass(fresh = true): Promise<string | null> {
  return watchAhead(t.services, TEST_BURROW_ID, { ...ready, fresh });
}

async function row(id: string | null) {
  const [r] = await t.services.db
    .select()
    .from(aheadChecks)
    .where(eq(aheadChecks.id, id ?? ''));
  if (!r) throw new Error(`no check ${id}`);
  return r;
}

async function matter(id: string) {
  const [m] = await t.services.db.select().from(aheadMatters).where(eq(aheadMatters.id, id));
  if (!m) throw new Error(`no matter ${id}`);
  return m;
}

async function turnOf(dispatchId: string | null) {
  const [d] = await t.services.db
    .select()
    .from(dispatches)
    .where(eq(dispatches.id, dispatchId ?? ''));
  if (!d) throw new Error(`no turn ${dispatchId}`);
  return d;
}

async function inTurn(dispatchId: string | null) {
  const token = await issueDispatchToken(t.services, dispatchId ?? '');
  return mcpClient(t.baseUrl, token.token);
}

function said(result: object): string {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

/** Every check's turn is over, so the watcher may start the next. */
async function endTurns() {
  await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.trigger, 'ahead'));
}

/** A fresh start: no checks, no matters, no new mail. */
async function clean() {
  await endTurns();
  await t.services.db.delete(aheadChecks).where(eq(aheadChecks.burrowId, TEST_BURROW_ID));
  await t.services.db.delete(aheadMatters).where(eq(aheadMatters.burrowId, TEST_BURROW_ID));
  google.messages = [...oldMail];
  google.events = [];
}

/** A check row as an earlier pass would have left it. */
async function insertRow(over: Partial<typeof aheadChecks.$inferInsert> = {}) {
  const id = newId('aheadCheck');
  await t.services.db.insert(aheadChecks).values({
    id,
    burrowId: TEST_BURROW_ID,
    agentId: mine.agentId,
    personId: IDS.mara,
    source: 'mail',
    stage: 'mail',
    eventKey: `test:${id}`,
    version: 'v:mail',
    summary: 'Earlier check',
    location: '',
    calendar: '',
    startAt: now,
    endAt: new Date(now.getTime() + 48 * HOUR),
    event: {
      start: now.toISOString(),
      end: now.toISOString(),
      description: '',
      timeZone: 'UTC',
      connectionId: '',
      calendarId: '',
      eventId: '',
    },
    state: 'quiet',
    conversationId: mine.dmId,
    threadRootId: newId('message'),
    startedAt: now,
    reportedAt: now,
    ...over,
  });
  return id;
}

/** A matter as an earlier check would have left it. */
async function insertMatter(over: Partial<typeof aheadMatters.$inferInsert> = {}) {
  const id = newId('aheadMatter');
  await t.services.db.insert(aheadMatters).values({
    id,
    burrowId: TEST_BURROW_ID,
    personId: IDS.mara,
    origin: 'check',
    title: `Matter ${id}`,
    waitingOn: 'them',
    match: { threads: [], senders: [], words: [] },
    state: 'open',
    conversationId: mine.dmId,
    lastNewsAt: now,
    createdAt: now,
    updatedAt: now,
    ...over,
  });
  return id;
}

/** The person writes in their Chat; their turn. */
async function personSays(text: string, threadRootId?: string) {
  const res = await t.commit(IDS.mara, sendMessage, {
    conversationId: mine.dmId,
    text,
    ...(threadRootId ? { threadRootId } : {}),
  });
  const messageId = (res as { result: { id: string } }).result.id;
  const [turn] = await t.services.db
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.messageId, messageId), eq(dispatches.agentId, mine.agentId)));
  if (!turn) throw new Error('no turn');
  return { messageId, turn };
}

beforeAll(async () => {
  realClock = t.services.clock;
  t.services.clock = () => now;
  mine = await addPersonalAgent(t.services, TEST_BURROW_ID, IDS.mara);
  await t.services.db.update(burrows).set({ timeZone: 'UTC' }).where(eq(burrows.id, TEST_BURROW_ID));
  google = (t.services.google.workspace as FakeGoogleWorkspace).stateFor(FAKE_ACCESS_TOKEN);
  // The seeded mail is old: only what each test sends is new.
  google.messages = google.messages.map((m) => ({ ...m, date: new Date('2026-12-01T10:00:00Z') }));
  oldMail = [...google.messages];
  google.events = [];
});

afterAll(() => {
  t.services.clock = realClock;
});

describe('Looks ahead: the triage pass (looks-ahead.md)', () => {
  let triageId = '';

  it('lists the new mail, night mail too, without noise or the person’s own, and is served only ahead_triage', async () => {
    mail('m_night', 'Bob <bob@example.org>', 'Can you answer me by Friday?', '2026-12-14T02:10:00Z');
    mail('m_news', 'Shop <news@shop.example>', 'Weekly digest', '2026-12-14T06:00:00Z', {
      body: 'Our newsletter. Unsubscribe here.',
    });
    mail('m_own', 'You <you@example.com>', 'Note to self', '2026-12-14T07:00:00Z');
    mail(
      'm_hotel',
      'Hotel <bookings@hotel.example>',
      'Booking confirmation for 20 Dec',
      '2026-12-14T06:30:00Z',
      {
        unread: true,
      },
    );
    triageId = (await pass()) ?? '';
    const r = await row(triageId);
    expect(r).toMatchObject({ source: 'triage', stage: 'triage', summary: 'New mail', state: 'checking' });
    expect(r.mailReadAt).not.toBeNull();
    // Booking words first, then the newest; the newsletter and the person's own mail aren't in it.
    expect(r.event.triage?.count).toBe(2);
    expect(r.event.triage?.mails.map((m) => [m.ref, m.messageId])).toEqual([
      ['m1', 'm_hotel'],
      ['m2', 'm_night'],
    ]);

    const ctx = await buildDispatchContext(t.services, await turnOf(r.dispatchId));
    expect(ctx.ahead).toMatchObject({ source: 'triage', stage: 'triage' });
    expect(ctx.ahead?.triage?.mails.map((m) => m.ref)).toEqual(['m1', 'm2']);
    expect(ctx.ahead?.triage?.mails[0]).toMatchObject({ unread: true });
    expect(ctx.ahead?.triage?.mails[0]).not.toHaveProperty('messageId');

    const mcp = await inTurn(r.dispatchId);
    expect((await mcp.client.listTools()).tools.map((x) => x.name)).toEqual(['ahead_triage']);
    const read = await mcp.client.callTool({ name: 'mail_search', arguments: { query: '' } });
    expect(read.isError).toBe(true);
    expect(said(read)).toContain('ahead_triage');
    const report = await mcp.client.callTool({ name: 'ahead_report', arguments: { found: false } });
    expect(report.isError).toBe(true);
    // An unknown number is refused so the turn can correct it.
    const wrong = await mcp.client.callTool({ name: 'ahead_triage', arguments: { picks: [{ mail: 'm9' }] } });
    expect(wrong.isError).toBe(true);
    expect(said(wrong)).toContain('m9');
    const picked = await mcp.client.callTool({
      name: 'ahead_triage',
      arguments: { picks: [{ mail: 'm1' }, { mail: 'm2' }] },
    });
    expect(picked.structuredContent).toMatchObject({ status: 'ok', picked: 2 });
    await mcp.close();
    const after = await row(triageId);
    expect(after.state).toBe('quiet');
    expect(after.event.triage?.picks).toEqual([{ ref: 'm1' }, { ref: 'm2' }]);
  });

  it('starts its picks as mail checks on later passes, one at a time', async () => {
    await endTurns();
    const first = await pass(false);
    const r1 = await row(first);
    expect(r1).toMatchObject({
      source: 'mail',
      stage: 'mail',
      eventKey: `mail:${mine.connectionId}:m_hotel`,
      state: 'checking',
    });
    expect(r1.mailReadAt).not.toBeNull();
    expect(await pass(false)).toBeNull();
    const ctx = await buildDispatchContext(t.services, await turnOf(r1.dispatchId));
    expect(ctx.ahead?.mail?.subject).toContain('Booking confirmation');
    const mcp = await inTurn(r1.dispatchId);
    const tools = (await mcp.client.listTools()).tools.map((x) => x.name);
    expect(tools).toContain('ahead_report');
    expect(tools).not.toContain('ahead_triage');
    expect((await mcp.client.callTool({ name: 'ahead_triage', arguments: { picks: [] } })).isError).toBe(
      true,
    );
    await mcp.client.callTool({ name: 'ahead_report', arguments: { found: false } });
    await mcp.close();
    await endTurns();
    const second = await pass(false);
    expect((await row(second)).eventKey).toBe(`mail:${mine.connectionId}:m_night`);
    const mcp2 = await inTurn((await row(second)).dispatchId);
    await mcp2.client.callTool({ name: 'ahead_report', arguments: { found: false } });
    await mcp2.close();
    await endTurns();
    // Nothing new: no pass within the gap, every pick checked.
    expect(await pass(false)).toBeNull();
  });

  it('runs at most three triage passes a day, 4.5 hours apart unless Check now, outside the checks budget', async () => {
    const finish = async (id: string | null, picks: { mail: string }[] = []) => {
      const mcp = await inTurn((await row(id)).dispatchId);
      await mcp.client.callTool({ name: 'ahead_triage', arguments: { picks } });
      await mcp.close();
      await endTurns();
    };
    now = new Date('2026-12-14T10:00:00Z');
    mail('m_a', 'Ann <ann@example.org>', 'A question about Saturday', '2026-12-14T09:30:00Z');
    expect(await pass(false)).toBeNull();
    // “Check now” may look before the gap is over.
    expect(await checkAheadNow(t.services, TEST_BURROW_ID, ready)).toBe(true);
    const [second] = await t.services.db
      .select()
      .from(aheadChecks)
      .where(and(eq(aheadChecks.source, 'triage'), eq(aheadChecks.state, 'checking')));
    expect(second?.event.triage?.mails.map((m) => m.messageId)).toEqual(['m_a']);
    await finish(second?.id ?? null);
    now = new Date('2026-12-14T14:30:00Z');
    mail('m_b', 'Ben <ben@example.org>', 'Lunch next week?', '2026-12-14T14:00:00Z');
    const third = await pass(false);
    expect((await row(third)).source).toBe('triage');
    await finish(third);
    now = new Date('2026-12-14T17:30:00Z');
    mail('m_c', 'Cas <cas@example.org>', 'Notes from the meeting', '2026-12-14T17:00:00Z');
    expect(await pass(false)).toBeNull();
    const triages = await t.services.db.select().from(aheadChecks).where(eq(aheadChecks.source, 'triage'));
    expect(triages).toHaveLength(3);

    // Two checks and three passes today: with nine more checks, one is still left.
    for (let i = 0; i < AHEAD_CHECKS_PER_DAY - 3; i++) await insertRow();
    google.events = [
      {
        id: 'concert',
        calendarId: 'primary',
        summary: 'Concert',
        description: '',
        location: 'Ziggo Dome, Amsterdam',
        start: '2026-12-15T20:00:00Z',
        end: '2026-12-15T23:00:00Z',
        allDay: false,
        guests: [],
        organizer: 'you@example.com',
        webUrl: null,
        meetUrl: null,
        response: 'accepted',
      },
    ];
    const check = await pass();
    expect((await row(check)).source).toBe('calendar');
    await endTurns();
    await t.services.db
      .update(aheadChecks)
      .set({ state: 'quiet' })
      .where(eq(aheadChecks.id, check ?? ''));
    google.events = [];
  });
});

describe('Looks ahead: keeping an eye on (looks-ahead.md)', () => {
  let asked = '';
  let askedIn = '';

  it('starts, lists and keeps one watch in the person’s own turn', async () => {
    await clean();
    now = new Date('2026-12-15T09:00:00Z');
    const { messageId, turn } = await personSays('Tell me when the notary replies');
    askedIn = messageId;
    const mcp = await inTurn(turn.id);
    expect((await mcp.client.listTools()).tools.map((x) => x.name)).toContain('ahead_watch');
    const start = await mcp.client.callTool({
      name: 'ahead_watch',
      arguments: {
        action: 'start',
        title: 'Answer from the notary',
        who: 'the notary',
        senders: ['Notaris-Jansen'],
        waitingOn: 'them',
      },
    });
    expect(start.structuredContent).toMatchObject({
      status: 'ok',
      matter: { asked: true, waitingOn: 'them' },
    });
    asked = (start.structuredContent as { matter: { id: string } }).matter.id;
    const again = await mcp.client.callTool({
      name: 'ahead_watch',
      arguments: { action: 'start', title: 'answer from the notary', senders: ['notary'] },
    });
    expect((again.structuredContent as { matter: { id: string } }).matter.id).toBe(asked);
    const list = await mcp.client.callTool({ name: 'ahead_watch', arguments: { action: 'list' } });
    expect((list.structuredContent as { matters: { id: string }[] }).matters.map((m) => m.id)).toEqual([
      asked,
    ]);
    await mcp.close();
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, turn.id));
    expect(await matter(asked)).toMatchObject({
      origin: 'person',
      state: 'open',
      conversationId: mine.dmId,
      threadRootId: messageId,
      match: { threads: [], senders: ['notaris-jansen'], words: [] },
    });
  });

  it('checks matching mail at once and tells it in the person’s thread, beyond the day’s findings', async () => {
    for (let i = 0; i < AHEAD_FINDINGS_PER_DAY; i++) await insertRow({ state: 'told', kind: 'other' });
    now = new Date('2026-12-15T09:45:00Z');
    mail(
      'm_notary',
      'Notaris Jansen <office@notaris-jansen.example>',
      'Re: your deed',
      '2026-12-15T09:30:00Z',
    );
    const id = await pass();
    const r = await row(id);
    expect(r).toMatchObject({ source: 'mail', matterId: asked, state: 'checking' });
    const ctx = await buildDispatchContext(t.services, await turnOf(r.dispatchId));
    expect(ctx.ahead?.matter).toMatchObject({ ref: 'k1', asked: true, title: 'Answer from the notary' });

    const mcp = await inTurn(r.dispatchId);
    // Only the person's own turn starts a watch.
    expect((await mcp.client.listTools()).tools.map((x) => x.name)).not.toContain('ahead_watch');
    expect((await mcp.client.callTool({ name: 'ahead_watch', arguments: { action: 'list' } })).isError).toBe(
      true,
    );
    await mcp.client.callTool({ name: 'mail_read', arguments: { messageId: 'm_notary' } });
    const told = await mcp.client.callTool({
      name: 'ahead_report',
      arguments: {
        found: true,
        kind: 'other',
        text: 'The notary replied: the deed is ready to sign.',
        sources: [{ mailId: 'm_notary' }],
      },
    });
    expect(told.structuredContent).toMatchObject({ status: 'ok', told: true });
    await mcp.close();
    await endTurns();
    const [posted] = await t.services.db.select().from(messages).where(eq(messages.id, r.threadRootId));
    expect(posted?.threadRootId).toBe(askedIn);
    expect((await matter(asked)).lastNewsAt.getTime()).toBe(now.getTime());
  });

  it('tells a watched sender’s mail about something else as an ordinary finding, in a thread of its own', async () => {
    // Yesterday's findings don't count towards today's.
    await t.services.db
      .update(aheadChecks)
      .set({ reportedAt: new Date('2026-12-14T10:00:00Z') })
      .where(and(eq(aheadChecks.state, 'told'), isNull(aheadChecks.matterId)));
    now = new Date('2026-12-15T10:30:00Z');
    mail(
      'm_other',
      'Notaris Jansen <office@notaris-jansen.example>',
      'Your invoice is overdue',
      '2026-12-15T10:20:00Z',
    );
    const r = await row(await pass());
    expect(r).toMatchObject({ source: 'mail', matterId: asked });
    const before = (await matter(asked)).lastNewsAt.getTime();
    const mcp = await inTurn(r.dispatchId);
    await mcp.client.callTool({ name: 'mail_read', arguments: { messageId: 'm_other' } });
    const told = await mcp.client.callTool({
      name: 'ahead_report',
      arguments: {
        found: true,
        kind: 'deadline',
        text: 'The notary’s invoice is overdue.',
        sources: [{ mailId: 'm_other' }],
        unrelated: true,
      },
    });
    expect(told.structuredContent).toMatchObject({ status: 'ok', told: true });
    await mcp.close();
    await endTurns();
    const [posted] = await t.services.db.select().from(messages).where(eq(messages.id, r.threadRootId));
    expect(posted?.threadRootId ?? null).toBeNull();
    expect(await row(r.id)).toMatchObject({ state: 'told', matterId: null });
    expect((await matter(asked)).lastNewsAt.getTime()).toBe(before);
  });

  it('closes the matter on “Stop checking for this” under its finding, without stopping the kind', async () => {
    const { turn } = await personSays('Stop checking for this', askedIn);
    const ctx = await buildDispatchContext(t.services, turn);
    expect(ctx.ahead?.found?.matter).toEqual({ title: 'Answer from the notary', asked: true });
    const mcp = await inTurn(turn.id);
    const stop = await mcp.client.callTool({ name: 'ahead_feedback', arguments: { verdict: 'stop_kind' } });
    expect(stop.structuredContent).toMatchObject({ status: 'ok' });
    await mcp.close();
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, turn.id));
    expect(await matter(asked)).toMatchObject({ state: 'closed', closedReason: 'removed' });
    expect((await aheadSettingsOf(t.services.db, TEST_BURROW_ID)).stopped).not.toContain('other');
  });

  it('checks news on an asked matter again in the morning when it came at night', async () => {
    await clean();
    now = new Date('2026-12-15T20:00:00Z');
    const id = await insertMatter({
      origin: 'person',
      title: 'Parcel from the shop',
      match: { threads: [], senders: ['parcel.example'], words: [] },
      lastNewsAt: new Date('2026-12-15T12:00:00Z'),
    });
    mail('m_parcel', 'Parcel <track@parcel.example>', 'Your parcel', '2026-12-15T19:55:00Z');
    now = new Date('2026-12-15T20:25:00Z');
    const late = await pass();
    const r = await row(late);
    expect(r.matterId).toBe(id);
    now = new Date('2026-12-15T21:10:00Z');
    const mcp = await inTurn(r.dispatchId);
    const res = await mcp.client.callTool({ name: 'ahead_report', arguments: { found: false } });
    expect(res.structuredContent).toMatchObject({ status: 'ok', told: false });
    await mcp.close();
    await endTurns();
    expect(
      await t.services.db
        .select()
        .from(aheadChecks)
        .where(eq(aheadChecks.id, late ?? '')),
    ).toEqual([]);
    now = new Date('2026-12-16T08:05:00Z');
    const morning = await pass();
    expect((await row(morning)).eventKey).toBe(r.eventKey);
    await endTurns();
  });

  it('opens a matter from a mail check, matched only by the mail’s thread and sender, within the caps', async () => {
    await clean();
    now = new Date('2026-12-16T09:00:00Z');
    mail('m_refund', 'Shop Service <Service@Shop.example>', 'Your refund request', '2026-12-16T08:00:00Z', {
      threadId: 'thr_refund',
    });
    const triage = await pass();
    const tm = await inTurn((await row(triage)).dispatchId);
    await tm.client.callTool({ name: 'ahead_triage', arguments: { picks: [{ mail: 'm1' }] } });
    await tm.close();
    await endTurns();
    const check = await pass();
    const mcp = await inTurn((await row(check)).dispatchId);
    // A check given no matter can't name one by ref.
    const byRef = await mcp.client.callTool({
      name: 'ahead_report',
      arguments: { found: false, matter: { ref: 'k1', close: true } },
    });
    expect(byRef.isError).toBe(true);
    const res = await mcp.client.callTool({
      name: 'ahead_report',
      arguments: {
        found: false,
        matter: {
          title: 'Refund for the kettle https://refund.example.net',
          who: 'Coolblue',
          waitingOn: 'them',
          due: '2026-12-20',
        },
      },
    });
    expect(res.structuredContent).toMatchObject({ status: 'ok', told: false });
    await mcp.close();
    await endTurns();
    const r = await row(check);
    expect(r.matterId).toBeTruthy();
    const opened = await matter(r.matterId ?? '');
    expect(opened).toMatchObject({
      origin: 'check',
      title: 'Refund for the kettle',
      who: 'Coolblue',
      waitingOn: 'them',
      state: 'open',
      match: {
        threads: [{ connectionId: mine.connectionId, threadId: 'thr_refund' }],
        senders: ['service@shop.example'],
        words: [],
      },
    });
    expect(opened.dueAt?.toISOString()).toBe('2026-12-20T12:00:00.000Z');

    // Checks open at most three a day.
    for (let i = 1; i < AHEAD_MATTERS_OPENED_PER_DAY; i++) await insertMatter();
    mail('m_other', 'Garage <desk@garage.example>', 'Your car service', '2026-12-16T09:10:00Z');
    now = new Date('2026-12-16T09:20:00Z');
    expect(await checkAheadNow(t.services, TEST_BURROW_ID, ready)).toBe(true);
    const [second] = await t.services.db
      .select()
      .from(aheadChecks)
      .where(and(eq(aheadChecks.source, 'triage'), eq(aheadChecks.state, 'checking')));
    const tm2 = await inTurn(second?.dispatchId ?? null);
    await tm2.client.callTool({ name: 'ahead_triage', arguments: { picks: [{ mail: 'm1' }] } });
    await tm2.close();
    await endTurns();
    const check2 = await pass();
    const mcp2 = await inTurn((await row(check2)).dispatchId);
    await mcp2.client.callTool({
      name: 'ahead_report',
      arguments: { found: false, matter: { title: 'Car service booking', waitingOn: 'you' } },
    });
    await mcp2.close();
    await endTurns();
    expect((await row(check2)).matterId).toBeNull();
    expect(
      await t.services.db.select().from(aheadMatters).where(eq(aheadMatters.origin, 'check')),
    ).toHaveLength(AHEAD_MATTERS_OPENED_PER_DAY);

    // At most thirty open: the person's next ask is refused plainly.
    for (let i = AHEAD_MATTERS_OPENED_PER_DAY; i < AHEAD_MATTERS_MAX; i++)
      await insertMatter({ createdAt: new Date('2026-12-10T09:00:00Z') });
    const { turn } = await personSays('Tell me when the plumber answers');
    const ask = await inTurn(turn.id);
    const full = await ask.client.callTool({
      name: 'ahead_watch',
      arguments: { action: 'start', title: 'Answer from the plumber', senders: ['plumber'] },
    });
    expect(full.isError).toBe(true);
    expect(said(full)).toContain(String(AHEAD_MATTERS_MAX));
    await ask.close();
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, turn.id));
  });

  it('follows a matter up by the clock once per reason, and closes one the check says is done', async () => {
    await clean();
    now = new Date('2026-12-17T10:00:00Z');
    const quiet = await insertMatter({
      title: 'Refund for the kettle',
      lastNewsAt: new Date('2026-12-11T09:00:00Z'),
      createdAt: new Date('2026-12-11T09:00:00Z'),
    });
    const id = await pass();
    const r = await row(id);
    expect(r).toMatchObject({
      source: 'matter',
      stage: 'matter',
      eventKey: `matter:${quiet}`,
      version: 'no_answer:matter',
      matterId: quiet,
      summary: 'Refund for the kettle',
    });
    expect(r.mailReadAt).not.toBeNull();
    expect((await matter(quiet)).followedUp).toEqual(['no_answer']);
    const ctx = await buildDispatchContext(t.services, await turnOf(r.dispatchId));
    expect(ctx.ahead).toMatchObject({ source: 'matter', matter: { ref: 'k1', reason: 'no_answer' } });
    const mcp = await inTurn(r.dispatchId);
    const told = await mcp.client.callTool({
      name: 'ahead_report',
      arguments: {
        found: true,
        kind: 'other',
        text: 'Still nothing from the shop about your refund since the 11th.',
        sources: [{ matter: true }],
        action: 'Draft a reminder',
      },
    });
    expect(told.structuredContent).toMatchObject({ status: 'ok', told: true });
    await mcp.close();
    await endTurns();
    const [posted] = await t.services.db.select().from(messages).where(eq(messages.id, r.threadRootId));
    expect(posted?.text).toContain(LOOKS_AHEAD_WORDS.matters);
    expect((await matter(quiet)).threadRootId).toBe(r.threadRootId);
    // Once per reason.
    expect(await pass()).toBeNull();

    const due = await insertMatter({
      title: 'Answer the school about the trip',
      waitingOn: 'you',
      dueAt: new Date('2026-12-18T09:00:00Z'),
    });
    const follow = await pass();
    expect((await row(follow)).version).toBe('due:matter');
    const mcp2 = await inTurn((await row(follow)).dispatchId);
    const done = await mcp2.client.callTool({
      name: 'ahead_report',
      arguments: { found: false, matter: { ref: 'k1', close: true } },
    });
    expect(done.structuredContent).toMatchObject({ status: 'ok', told: false });
    await mcp2.close();
    await endTurns();
    expect(await matter(due)).toMatchObject({ state: 'closed', closedReason: 'done' });
  });

  it('shows matters and recent rows as older apps know them, and lets only the person remove a matter', async () => {
    await insertRow({
      source: 'triage',
      stage: 'triage',
      eventKey: 'triage:test',
      summary: 'New mail',
      startedAt: new Date(now.getTime() + 60_000),
      event: {
        start: now.toISOString(),
        end: now.toISOString(),
        description: '',
        timeZone: 'UTC',
        connectionId: '',
        calendarId: '',
        eventId: '',
        triage: { since: now.toISOString(), count: 7, mails: [], picks: [{ ref: 'm1' }] },
      },
    });
    const view = await looksAheadView(t.services, TEST_BURROW_ID);
    for (const r of view.recent ?? []) {
      expect(['calendar', 'mail']).toContain(r.source);
      expect(['early', 'eve', 'morning', 'mail']).toContain(r.stage);
    }
    expect(view.recent?.[0]).toMatchObject({
      source: 'mail',
      stage: 'mail',
      of: 'triage',
      count: 7,
      picked: 1,
    });
    expect(view.recent?.find((r) => r.of === 'matter')).toMatchObject({ source: 'mail', stage: 'mail' });
    // The week counts checks only: the two follow-ups.
    expect(view.week).toEqual({ checked: 2, told: 1 });
    const open = view.matters ?? [];
    expect(open.map((m) => m.title)).toEqual(['Refund for the kettle']);

    const id = open[0]?.id ?? '';
    await expect(t.commit(mine.agentId, updateLooksAhead, { removeMatter: id })).rejects.toThrow();
    await t.commit(IDS.mara, updateLooksAhead, { removeMatter: id });
    expect(await matter(id)).toMatchObject({ state: 'closed', closedReason: 'removed' });
    expect((await looksAheadView(t.services, TEST_BURROW_ID)).matters).toEqual([]);
  });
});
