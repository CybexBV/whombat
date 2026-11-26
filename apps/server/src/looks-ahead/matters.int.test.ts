/**
 * Looks ahead's look through new mail and what it keeps an eye on (docs/decisions/looks-ahead.md), end to end on a real
 * database:
 * - a triage pass lists the new mail (night mail too, noise and the person's own left out), is served only
 *   `ahead_triage`, and its picks start as mail checks one at a time; triage passes have their own budget and gap;
 * - mail that matches a matter the person asked for (`ahead_watch`) is checked at once and told in their thread beyond
 *   the day's findings, never at night; “Stop checking for this” under it closes the matter;
 * - a mail check opens a matter matched only by the mail's thread and sender, within the caps;
 * - a follow-up runs by the clock once per reason and closes a matter the check says is done;
 * - Settings shows matters and recent rows in the values older apps know, and the person removes a matter;
 * - no mail slips between two passes, mail matches a matter by its sender's address within the day's cap, what the
 *   person asked for starts beyond the day's findings, a failed follow-up is tried once more, and a thread several
 *   matters share answers to the finding said last there;
 * - a sender word is a whole address or a site, read from the whole From line; a matter's daily cap applies after it is
 *   chosen; a pick only linked to the person's matter is an ordinary finding; a failed mail check is tried once more;
 *   mail a pass has no room for waits for the next; a second matter with an open one's title isn't opened; only a
 *   thread Looks ahead began is settled, and Settings opens a finding's thread.
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
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { issueDispatchToken } from '../auth/agent-tokens';
import { sendMessage } from '../commands/messages';
import type { FakeGoogleState, FakeGoogleWorkspace } from '../connectors/workspace-fake';
import { aheadChecks, aheadMatters, burrows, dispatches, messages } from '../db/schema/index';
import { buildDispatchContext } from '../runtime/context';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent, FAKE_ACCESS_TOKEN, type PersonalSetup } from '../test/personal';
import {
  aheadInboxFeedback,
  aheadSettingsOf,
  findingsSince,
  promoteAheadFinding,
  startAheadCheck,
  tidyAhead,
  updateLooksAhead,
} from './commands';
import { looksAheadNeedsYou } from './inbox';
import { looksAheadView } from './settings';
import { aheadWatchServed } from './turn';
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

/** Ends a triage pass with these picks. */
async function finishTriage(id: string, picks: { mail: string; matter?: string }[] = []) {
  const mcp = await inTurn((await row(id)).dispatchId);
  await mcp.client.callTool({ name: 'ahead_triage', arguments: { picks } });
  await mcp.close();
  await endTurns();
}

/** Ends a check's turn with nothing found (or this report). */
async function finishQuietly(id: string, report: Record<string, unknown> = { found: false }) {
  const mcp = await inTurn((await row(id)).dispatchId);
  const res = await mcp.client.callTool({ name: 'ahead_report', arguments: report });
  await mcp.close();
  await endTurns();
  return res;
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
        senders: ['Notaris-Jansen.example'],
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
      arguments: { action: 'start', title: 'answer from the notary', senders: ['notaris-jansen.example'] },
    });
    expect((again.structuredContent as { matter: { id: string } }).matter.id).toBe(asked);
    // A sender word is a whole address or a site, never a public provider's; a date from today to a year ahead.
    for (const [sender, kind] of [
      ['klm', 'not'],
      ['info@', 'not'],
      ['@notaris-jansen.example', 'not'],
      ['gmail.com', 'public'],
      ['gmx.de', 'public'],
    ] as const) {
      const refused = await mcp.client.callTool({
        name: 'ahead_watch',
        arguments: { action: 'start', title: 'Answer from someone', senders: [sender] },
      });
      expect(refused.isError, sender).toBe(true);
      expect(said(refused)).toContain(sender);
      expect(said(refused)).toContain(kind === 'public' ? 'public' : 'isn’t');
    }
    for (const due of ['2026-12-14', '2027-12-17', '2026-02-30']) {
      const refused = await mcp.client.callTool({
        name: 'ahead_watch',
        arguments: { action: 'start', title: 'Answer from someone', senders: ['someone.example'], due },
      });
      expect(refused.isError, due).toBe(true);
      expect(said(refused)).toContain('YYYY-MM-DD');
    }
    const fine = await mcp.client.callTool({
      name: 'ahead_watch',
      arguments: { action: 'start', title: 'Answer from Jan', senders: ['jan@gmail.com'], due: '2027-12-16' },
    });
    expect(fine.structuredContent).toMatchObject({ status: 'ok', matter: { asked: true } });
    await mcp.client.callTool({
      name: 'ahead_watch',
      arguments: { action: 'stop', id: (fine.structuredContent as { matter: { id: string } }).matter.id },
    });
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
      match: { threads: [], senders: ['notaris-jansen.example'], words: [] },
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
    // A mail check speaks only about its own mail, read first, and names that mail, not the matter.
    const unread = await mcp.client.callTool({
      name: 'ahead_report',
      arguments: { found: true, kind: 'other', text: 'The notary replied.', sources: [{ calendar: true }] },
    });
    expect(unread.isError).toBe(true);
    expect(said(unread)).toContain('mail_read');
    await mcp.client.callTool({ name: 'mail_read', arguments: { messageId: 'm_notary' } });
    const byMatter = await mcp.client.callTool({
      name: 'ahead_report',
      arguments: { found: true, kind: 'other', text: 'The notary replied.', sources: [{ matter: true }] },
    });
    expect(byMatter.isError).toBe(true);
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
    // Person-asked watch news stays in Chat and never appears in Inbox.
    const inbox = await looksAheadNeedsYou({
      db: t.services.db,
      burrowId: TEST_BURROW_ID,
      personId: IDS.mara,
      now,
    });
    expect(inbox.some((i) => i.ref.id === r.id)).toBe(false);
  });

  it('tells a watched sender’s mail about something else as an ordinary Inbox finding, outside the watch thread', async () => {
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
        title: 'Notary invoice is overdue',
        text: 'The notary’s invoice is overdue.',
        sources: [{ mailId: 'm_other' }],
        unrelated: true,
      },
    });
    expect(told.structuredContent).toMatchObject({ status: 'ok', told: true });
    await mcp.close();
    await endTurns();
    // Unsolicited finding lands in Inbox rather than opening a Chat thread.
    expect(await t.services.db.select().from(messages).where(eq(messages.id, r.threadRootId))).toEqual([]);
    expect(await row(r.id)).toMatchObject({ state: 'told', matterId: null, promotedAt: null });
    const inbox = await looksAheadNeedsYou({
      db: t.services.db,
      burrowId: TEST_BURROW_ID,
      personId: IDS.mara,
      now,
    });
    expect(inbox.find((i) => i.ref.id === r.id)).toMatchObject({
      kind: 'ahead',
      title: 'Notary invoice is overdue',
    });
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
      createdAt: new Date('2026-12-15T12:00:00Z'),
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
    // The display name holds another address: the matter keeps the sender's own.
    mail(
      'm_refund',
      '"Refund <boss@company.example>" <Service@Shop.example>',
      'Your refund request',
      '2026-12-16T08:00:00Z',
      { threadId: 'thr_refund' },
    );
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
    // Opening a matter needs the mail read first.
    const unread = await mcp.client.callTool({
      name: 'ahead_report',
      arguments: { found: false, matter: { title: 'Refund for the kettle', waitingOn: 'them' } },
    });
    expect(unread.isError).toBe(true);
    expect(said(unread)).toContain('mail_read');
    await mcp.client.callTool({ name: 'mail_read', arguments: { messageId: 'm_refund' } });
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
    await mcp2.client.callTool({ name: 'mail_read', arguments: { messageId: 'm_other' } });
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
      arguments: { action: 'start', title: 'Answer from the plumber', senders: ['plumber.example'] },
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
    // A reason counts as followed up once its check reported, not when it began.
    expect((await matter(quiet)).followedUp).toEqual([]);
    const ctx = await buildDispatchContext(t.services, await turnOf(r.dispatchId));
    expect(ctx.ahead).toMatchObject({ source: 'matter', matter: { ref: 'k1', reason: 'no_answer' } });
    const mcp = await inTurn(r.dispatchId);
    const told = await mcp.client.callTool({
      name: 'ahead_report',
      arguments: {
        found: true,
        kind: 'other',
        title: 'Still no reply on kettle refund',
        text: 'Still nothing from the shop about your refund since the 11th.',
        sources: [{ matter: true }],
        action: 'Draft a reminder',
      },
    });
    expect(told.structuredContent).toMatchObject({ status: 'ok', told: true });
    await mcp.close();
    await endTurns();
    // Unsolicited follow-up lands in Inbox until promoted.
    expect(await t.services.db.select().from(messages).where(eq(messages.id, r.threadRootId))).toEqual([]);
    const inbox = await looksAheadNeedsYou({
      db: t.services.db,
      burrowId: TEST_BURROW_ID,
      personId: IDS.mara,
      now,
    });
    expect(inbox.find((i) => i.ref.id === r.id)).toMatchObject({
      kind: 'ahead',
      title: 'Still no reply on kettle refund',
      ahead: {
        checkId: r.id,
        source: 'matter',
        action: 'Draft a reminder',
        matter: true,
        matterTitle: 'Refund for the kettle',
        sources: [{ label: LOOKS_AHEAD_WORDS.matters }],
      },
    });
    expect((await matter(quiet)).threadRootId).toBeNull();
    expect((await matter(quiet)).followedUp).toEqual(['no_answer']);
    // Once per reason.
    expect(await pass()).toBeNull();

    const due = await insertMatter({
      title: 'Answer the school about the trip',
      waitingOn: 'you',
      dueAt: new Date('2026-12-18T09:00:00Z'),
      createdAt: new Date('2026-12-15T09:00:00Z'),
      lastNewsAt: new Date('2026-12-15T09:00:00Z'),
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

describe('Looks ahead: nothing slips, matching, follow-ups and shared threads (looks-ahead.md)', () => {
  it('covers mail that came between a pass’s inbox read and its start, and a failed pass loses nothing', async () => {
    await clean();
    now = new Date('2026-12-18T08:50:00Z');
    mail('s_first', 'Ann <ann@example.org>', 'Can we meet on Monday?', '2026-12-18T08:40:00Z');
    // The day's findings are used: with nothing the person asked for open, nothing is read at all.
    const used: string[] = [];
    for (let i = 0; i < AHEAD_FINDINGS_PER_DAY; i++)
      used.push(await insertRow({ state: 'told', kind: 'other' }));
    google.calls = [];
    expect(await pass(false)).toBeNull();
    expect(google.calls).toEqual([]);
    // With one open, the inbox is read (and kept a while) for news on it, but no pass starts.
    await insertMatter({ origin: 'person', match: { threads: [], senders: ['nobody.example'], words: [] } });
    expect(await pass(false)).toBeNull();
    expect(google.calls).toContain('mailSearch');
    await t.services.db.delete(aheadChecks).where(inArray(aheadChecks.id, used));
    // It arrives after that read and before the pass begins.
    mail('s_between', 'Ben <ben@example.org>', 'Are you coming on Friday?', '2026-12-18T08:55:00Z');
    now = new Date('2026-12-18T09:00:00Z');
    const first = await row(await pass(false));
    expect(first.source).toBe('triage');
    expect(first.event.triage?.mails.map((m) => m.messageId)).toEqual(['s_first']);
    expect(first.event.triage?.sweptAt).toBe('2026-12-18T08:50:00.000Z');
    await finishTriage(first.id);
    now = new Date('2026-12-18T13:40:00Z');
    const second = await row(await pass(false));
    expect(second.event.triage?.mails.map((m) => m.messageId)).toEqual(['s_between']);
    // Its turn ends without picking: it failed, moves nothing, and the next pass needn't wait the gap.
    await endTurns();
    now = new Date('2026-12-18T13:45:00Z');
    const third = await row(await pass(false));
    expect(await row(second.id)).toMatchObject({ state: 'failed' });
    expect(third.source).toBe('triage');
    expect(third.event.triage?.mails.map((m) => m.messageId)).toEqual(['s_between']);
    await finishTriage(third.id);
  });

  it('holds the gap inside the commit too, unless Check now or the last pass failed', async () => {
    await clean();
    now = new Date('2026-12-19T12:00:00Z');
    const recent = await insertRow({
      source: 'triage',
      stage: 'triage',
      eventKey: 'triage:recent',
      summary: 'New mail',
      startedAt: new Date('2026-12-19T10:30:00Z'),
    });
    const at = now.toISOString();
    const event = {
      source: 'triage' as const,
      stage: 'triage' as const,
      key: 'triage:race',
      version: 'pass:triage',
      connectionId: '',
      eventId: '',
      summary: 'New mail',
      location: '',
      description: '',
      calendar: '',
      start: at,
      end: at,
      timeZone: 'UTC',
      triage: { since: at, count: 1, mails: [], matters: [] },
    };
    const start = async (fresh?: boolean) => {
      const res = await t.commit(mine.agentId, startAheadCheck, {
        event,
        personId: IDS.mara,
        ...(fresh ? { fresh: true } : {}),
      });
      if (res.status !== 'ok') throw new Error(res.status);
      return res.result;
    };
    expect(await start()).toBeNull();
    const asked = await start(true);
    expect(asked?.checkId).toBeTruthy();
    await endTurns();
    await t.services.db.delete(aheadChecks).where(eq(aheadChecks.id, asked?.checkId ?? ''));
    await t.services.db.update(aheadChecks).set({ state: 'failed' }).where(eq(aheadChecks.id, recent));
    expect((await start())?.checkId).toBeTruthy();
    await endTurns();
  });

  it('matches mail by the sender’s address after the matter began, bulk only for the person’s, three a day', async () => {
    await clean();
    now = new Date('2026-12-20T09:00:00Z');
    const began = new Date('2026-12-20T08:00:00Z');
    const theirs = await insertMatter({
      origin: 'person',
      title: 'Answer from the notary',
      match: { threads: [], senders: ['notaris-jansen.example'], words: [] },
      createdAt: began,
      lastNewsAt: began,
    });
    await insertMatter({
      title: 'Refund from the shop',
      match: { threads: [], senders: ['news@shop.example'], words: [] },
      createdAt: began,
      lastNewsAt: began,
    });
    const notary = 'Notaris Jansen <office@notaris-jansen.example>';
    mail('c_early', notary, 'Re: deed', '2026-12-20T07:30:00Z');
    mail('c_first', notary, 'Re: deed', '2026-12-20T08:10:00Z');
    mail('c_forged', '"office@notaris-jansen.example" <x@evil.example>', 'Re: deed', '2026-12-20T08:15:00Z');
    mail('c_second', notary, 'Re: deed, the draft', '2026-12-20T08:20:00Z');
    mail('c_bulk', notary, 'News from the office', '2026-12-20T08:25:00Z', {
      body: 'Our newsletter. Unsubscribe here.',
    });
    mail('c_shop', 'Shop <news@shop.example>', 'Weekly digest', '2026-12-20T08:30:00Z', {
      body: 'Our newsletter. Unsubscribe here.',
    });
    mail('c_fourth', notary, 'Re: deed, one more thing', '2026-12-20T08:40:00Z');
    const checked: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await row(await pass());
      expect(r).toMatchObject({ source: 'mail', matterId: theirs });
      const id = r.event.mail?.messageId ?? '';
      checked.push(id);
      if (i === 0) {
        // Told: news on it now, and the second reply already in the inbox still matches.
        const mcp = await inTurn(r.dispatchId);
        await mcp.client.callTool({ name: 'mail_read', arguments: { messageId: id } });
        const told = await mcp.client.callTool({
          name: 'ahead_report',
          arguments: { found: true, kind: 'other', text: 'The notary replied.', sources: [{ mailId: id }] },
        });
        expect(told.structuredContent).toMatchObject({ told: true });
        await mcp.close();
        await endTurns();
      } else await finishQuietly(r.id);
      now = new Date(now.getTime() + 60_000);
    }
    expect(checked).toEqual(['c_first', 'c_second', 'c_bulk']);
    // The day's three are used: the next reply waits for a pass, beside a forged name and mail from before it began;
    // the shop's newsletter matches nothing a check opened and isn't listed either.
    const triage = await row(await pass());
    expect(triage.source).toBe('triage');
    expect(triage.event.triage?.mails.map((m) => m.messageId).sort()).toEqual([
      'c_early',
      'c_forged',
      'c_fourth',
    ]);
    await finishTriage(triage.id);
  });

  it('starts what the person asked for beyond the day’s findings, and keeps it open unless told it is done', async () => {
    await clean();
    now = new Date('2026-12-21T10:00:00Z');
    const theirs = await insertMatter({
      origin: 'person',
      title: 'Answer from the plumber',
      match: { threads: [], senders: ['plumber-co.example'], words: [] },
      createdAt: new Date('2026-12-10T10:00:00Z'),
      lastNewsAt: new Date('2026-12-15T10:00:00Z'),
    });
    for (let i = 0; i < AHEAD_FINDINGS_PER_DAY; i++) await insertRow({ state: 'told', kind: 'other' });
    const since = '2026-12-21T08:00:00Z';
    await insertRow({
      source: 'triage',
      stage: 'triage',
      eventKey: 'triage:asked',
      summary: 'New mail',
      startedAt: new Date('2026-12-21T09:00:00Z'),
      event: {
        start: since,
        end: since,
        description: '',
        timeZone: 'UTC',
        connectionId: '',
        calendarId: '',
        eventId: '',
        triage: {
          since,
          count: 1,
          mails: [
            {
              ref: 'm1',
              connectionId: mine.connectionId ?? '',
              provider: 'google',
              account: 'you@example.com',
              messageId: 'p_pick',
              threadId: 'thr_pick',
              from: 'Plumber <desk@plumber-co.example>',
              address: 'desk@plumber-co.example',
              subject: 'Your quote',
              date: '2026-12-21T08:30:00Z',
              snippet: 'Your quote',
            },
          ],
          matters: [{ ref: 'k1', id: theirs }],
          picks: [{ ref: 'm1', matterId: theirs }],
        },
      },
    });
    const pick = await row(await pass());
    expect(pick).toMatchObject({
      source: 'mail',
      matterId: theirs,
      eventKey: `mail:${mine.connectionId}:p_pick`,
    });
    await finishQuietly(pick.id);
    // “Not useful” on a mail finding keeps its kind and reason for later checks, never the mail's subject.
    const yesterday = new Date('2026-12-20T10:00:00Z');
    await insertRow({
      summary: 'Pay now at the evil desk',
      state: 'told',
      kind: 'deadline',
      feedback: 'not_useful',
      feedbackNote: 'I paid it',
      reportedAt: yesterday,
    });
    await insertRow({
      source: 'calendar',
      stage: 'eve',
      summary: 'Concert',
      state: 'told',
      kind: 'time',
      feedback: 'not_useful',
      reportedAt: yesterday,
    });
    const follow = await row(await pass());
    expect(follow).toMatchObject({ source: 'matter', matterId: theirs, version: 'no_answer:matter' });
    // A follow-up is told where to look: the matter's sender and the mail its earlier check was about.
    const ctx = await buildDispatchContext(t.services, await turnOf(follow.dispatchId));
    expect(ctx.ahead?.matter?.anchors).toEqual({ senders: ['plumber-co.example'], messageIds: ['p_pick'] });
    expect(ctx.ahead?.recentDismissed).toEqual(
      expect.arrayContaining([
        { title: '', kind: 'deadline', reason: 'I paid it' },
        { title: 'Concert', kind: 'time' },
      ]),
    );
    // A check doesn't close what the person asked for without telling them.
    const res = await finishQuietly(follow.id, { found: false, matter: { ref: 'k1', close: true } });
    expect(res.structuredContent).toMatchObject({ status: 'ok', told: false });
    expect(await matter(theirs)).toMatchObject({ state: 'open', followedUp: ['no_answer'] });
  });

  it('tries a follow-up whose turn failed once more, not more', async () => {
    await clean();
    now = new Date('2026-12-22T10:00:00Z');
    const id = await insertMatter({
      title: 'Refund for the lamp',
      createdAt: new Date('2026-12-10T10:00:00Z'),
      lastNewsAt: new Date('2026-12-16T10:00:00Z'),
    });
    const first = await row(await pass());
    expect(first.version).toBe('no_answer:matter');
    await endTurns();
    const again = await row(await pass());
    expect(await row(first.id)).toMatchObject({ state: 'failed' });
    expect(again.version).toBe('no_answer.again:matter');
    await endTurns();
    expect(await pass()).toBeNull();
    expect(await row(again.id)).toMatchObject({ state: 'failed' });
    expect((await matter(id)).followedUp).toEqual([]);
  });

  it('makes a matter a check keeps an eye on the person’s when they ask for it, and refuses common senders', async () => {
    await clean();
    now = new Date('2026-12-22T11:00:00Z');
    const kept = await insertMatter({
      title: 'Refund for the kettle',
      who: 'Kettle Shop Customer Care',
      waitingOn: 'you',
      dueAt: new Date('2026-12-30T12:00:00Z'),
      note: 'They said to wait.',
      followedUp: ['no_answer'],
      lastNewsAt: new Date('2026-12-20T11:00:00Z'),
      match: {
        threads: [{ connectionId: mine.connectionId ?? '', threadId: 'thr_kettle' }],
        senders: ['service@shop.example'],
        words: ['urgent'],
      },
      createdAt: new Date('2026-12-20T11:00:00Z'),
    });
    const { messageId, turn } = await personSays('Tell me when the kettle refund comes');
    const mcp = await inTurn(turn.id);
    const common = await mcp.client.callTool({
      name: 'ahead_watch',
      arguments: { action: 'start', title: 'Answer from Jan', senders: ['gmail.com'] },
    });
    expect(common.isError).toBe(true);
    expect(said(common)).toContain('gmail.com');
    const res = await mcp.client.callTool({
      name: 'ahead_watch',
      arguments: {
        action: 'start',
        title: 'Refund for the kettle',
        senders: ['shop.example'],
        words: ['refund'],
        waitingOn: 'them',
      },
    });
    expect(res.structuredContent).toMatchObject({ status: 'ok', matter: { id: kept, asked: true } });
    await mcp.close();
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, turn.id));
    // On their terms: their who (none), waiting on and date (none), their senders and words; the check's thread stays.
    // And afresh: no note from the mail, no follow-up behind it, its time counted from now.
    expect(await matter(kept)).toMatchObject({
      note: null,
      followedUp: [],
      lastNewsAt: now,
      origin: 'person',
      conversationId: mine.dmId,
      threadRootId: messageId,
      who: '',
      waitingOn: 'them',
      dueAt: null,
      match: {
        threads: [{ connectionId: mine.connectionId ?? '', threadId: 'thr_kettle' }],
        senders: ['shop.example'],
        words: ['refund'],
      },
    });
  });

  it('serves ahead_watch only in the person’s own message turn, or Try again on one', async () => {
    const { turn } = await personSays('Tell me when the bank answers');
    expect(await aheadWatchServed(t.services.db, turn)).toBe(true);
    for (const trigger of [
      'expand',
      'schedule',
      'automation',
      'look_fix',
      'undo_requested',
      'notify',
    ] as const)
      expect(await aheadWatchServed(t.services.db, { ...turn, trigger })).toBe(false);
    expect(await aheadWatchServed(t.services.db, { ...turn, trigger: 'retry', retryOfId: turn.id })).toBe(
      true,
    );
    expect(await aheadWatchServed(t.services.db, { ...turn, trigger: 'retry', retryOfId: null })).toBe(false);
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, turn.id));
  });

  it('lets a matter run out after a month without news, not before two weeks past its date', async () => {
    await clean();
    now = new Date('2026-12-22T12:00:00Z');
    const old = new Date('2026-11-10T12:00:00Z');
    const plain = await insertMatter({ lastNewsAt: old, createdAt: old });
    const dated = await insertMatter({
      lastNewsAt: old,
      createdAt: old,
      dueAt: new Date('2026-12-15T12:00:00Z'),
    });
    await t.commit(mine.agentId, tidyAhead, {});
    expect(await matter(plain)).toMatchObject({ state: 'closed', closedReason: 'expired' });
    expect((await matter(dated)).state).toBe('open');
  });

  it('answers to the finding said last in a thread matters share, and never settles the thread the person began', async () => {
    await clean();
    now = new Date('2026-12-23T09:00:00Z');
    const { messageId: asked, turn } = await personSays('Tell me when the two firms answer');
    const ask = await inTurn(turn.id);
    const start = async (title: string, sender: string) => {
      const res = await ask.client.callTool({
        name: 'ahead_watch',
        arguments: { action: 'start', title, senders: [sender] },
      });
      return (res.structuredContent as { matter: { id: string } }).matter.id;
    };
    const first = await start('Answer from the first firm', 'first-firm.example');
    const second = await start('Answer from the second firm', 'second-firm.example');
    await ask.close();
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, turn.id));
    const tell = async (id: string, from: string, at: string) => {
      mail(id, from, 'Re: your question', at);
      const r = await row(await pass());
      const mcp = await inTurn(r.dispatchId);
      await mcp.client.callTool({ name: 'mail_read', arguments: { messageId: id } });
      const told = await mcp.client.callTool({
        name: 'ahead_report',
        arguments: { found: true, kind: 'other', text: 'They answered.', sources: [{ mailId: id }] },
      });
      expect(told.structuredContent).toMatchObject({ told: true });
      await mcp.close();
      await endTurns();
      return r;
    };
    now = new Date('2026-12-23T09:30:00Z');
    const a = await tell('f_first', 'First <desk@first-firm.example>', '2026-12-23T09:20:00Z');
    now = new Date('2026-12-23T10:00:00Z');
    const b = await tell('f_second', 'Second <desk@second-firm.example>', '2026-12-23T09:50:00Z');
    expect([a.matterId, b.matterId]).toEqual([first, second]);
    const settledAt = async () =>
      (await t.services.db.select().from(messages).where(eq(messages.id, asked)))[0]?.settledAt ?? null;
    // Both findings' time passed: the thread is still the person's own ask, so it stays as it is.
    await t.services.db
      .update(aheadChecks)
      .set({ endAt: new Date(now.getTime() - 3 * HOUR) })
      .where(inArray(aheadChecks.id, [a.id, b.id]));
    await t.commit(mine.agentId, tidyAhead, {});
    expect(await settledAt()).toBeNull();
    expect((await row(b.id)).settledAt).not.toBeNull();
    // “Open thread” in Settings opens the person's thread the findings are in, not the reply itself.
    const view = await looksAheadView(t.services, TEST_BURROW_ID);
    expect(view.recent?.find((r) => r.id === b.id)?.threadRootId).toBe(asked);

    // “Stop checking for this” there means the finding said last, and its own matter.
    const { turn: stop } = await personSays('Stop checking for this', asked);
    const mcp = await inTurn(stop.id);
    const res = await mcp.client.callTool({ name: 'ahead_feedback', arguments: { verdict: 'stop_kind' } });
    expect(res.structuredContent).toMatchObject({ status: 'ok' });
    await mcp.close();
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, stop.id));
    expect(await matter(second)).toMatchObject({ state: 'closed', closedReason: 'removed' });
    expect((await matter(first)).state).toBe('open');
    expect(await row(b.id)).toMatchObject({ feedback: 'stop_kind' });
  });
});

describe('Looks ahead: senders, picks, retries, deferred mail and threads (looks-ahead.md)', () => {
  const notary = 'Notaris Jansen <office@notaris-jansen.example>';
  const asks = (senders: string[], over: Partial<typeof aheadMatters.$inferInsert> = {}) =>
    insertMatter({
      origin: 'person',
      title: `Answer ${senders.join(' ')}`,
      match: { threads: [], senders, words: [] },
      createdAt: new Date(now.getTime() - HOUR),
      lastNewsAt: new Date(now.getTime() - HOUR),
      ...over,
    });
  /** A finished triage pass whose pick m1 is this mail, linked to this matter. */
  const pickRow = (
    mailId: string,
    from: string,
    matterId?: string,
    extra: { threadId?: string; address?: string } = {},
  ) =>
    insertRow({
      source: 'triage',
      stage: 'triage',
      eventKey: `triage:${mailId}`,
      summary: 'New mail',
      startedAt: new Date(now.getTime() - 30 * 60_000),
      event: {
        start: now.toISOString(),
        end: now.toISOString(),
        description: '',
        timeZone: 'UTC',
        connectionId: '',
        calendarId: '',
        eventId: '',
        triage: {
          since: now.toISOString(),
          count: 1,
          mails: [
            {
              ref: 'm1',
              connectionId: mine.connectionId ?? '',
              provider: 'google',
              account: 'you@example.com',
              messageId: mailId,
              threadId: extra.threadId ?? `thr_${mailId}`,
              from,
              subject: 'Your question',
              date: new Date(now.getTime() - HOUR).toISOString(),
              snippet: 'Your question',
              ...(extra.address ? { address: extra.address } : {}),
            },
          ],
          matters: matterId ? [{ ref: 'k1', id: matterId }] : [],
          picks: [{ ref: 'm1', ...(matterId ? { matterId } : {}) }],
        },
      },
    });

  it('matches a sender on its boundaries, by the address read from the whole From line', async () => {
    await clean();
    now = new Date('2026-12-24T09:00:00Z');
    const site = await asks(['notaris-jansen.example']);
    await asks(['jan@example.com']);
    mail('b_evil', 'Notaris <x@notaris-jansen.example.evil.example>', 'Re: deed', '2026-12-24T08:10:00Z');
    mail('b_marjan', 'Marjan <marjan@example.com>', 'Hello', '2026-12-24T08:15:00Z');
    mail(
      'b_long',
      `"${'Notaris Jansen '.repeat(22)}" <office@notaris-jansen.example>`,
      'Re: deed',
      '2026-12-24T08:20:00Z',
    );
    const r = await row(await pass());
    expect(r).toMatchObject({ source: 'mail', matterId: site });
    expect(r.event.mail?.messageId).toBe('b_long');
    expect(r.event.mail?.from.length).toBeLessThanOrEqual(320);
    expect(r.event.mail?.address).toBe('office@notaris-jansen.example');
    expect(r.event.matter).toEqual({ id: site, matched: true });
    await finishQuietly(r.id);
    // Neither the longer site nor marjan@ is a match: both wait for a pass.
    const triage = await row(await pass());
    expect(triage.source).toBe('triage');
    expect(triage.event.triage?.mails.map((m) => m.messageId).sort()).toEqual(['b_evil', 'b_marjan']);
    await finishTriage(triage.id);
  });

  it('chooses the matter first: with its three used today the mail goes to a pass, never to another matter', async () => {
    await clean();
    now = new Date('2026-12-24T11:00:00Z');
    const theirs = await asks(['notaris-jansen.example']);
    await insertMatter({
      title: 'Notary invoice',
      match: { threads: [], senders: ['office@notaris-jansen.example'], words: [] },
      createdAt: new Date(now.getTime() - HOUR),
    });
    for (let i = 0; i < 3; i++)
      await insertRow({
        event: {
          start: now.toISOString(),
          end: now.toISOString(),
          description: '',
          timeZone: 'UTC',
          connectionId: '',
          calendarId: '',
          eventId: '',
          matter: { id: theirs, matched: true },
        },
      });
    mail('d_reply', notary, 'Re: deed', '2026-12-24T10:30:00Z');
    const r = await row(await pass());
    expect(r.source).toBe('triage');
    expect(r.event.triage?.mails.map((m) => m.messageId)).toEqual(['d_reply']);
    await finishTriage(r.id);
  });

  it('checks a pick a pass linked to a matter it doesn’t match as any other mail', async () => {
    await clean();
    now = new Date('2026-12-24T12:00:00Z');
    const theirs = await asks(['plumber-co.example']);
    mail('u_pick', 'Other <desk@other.example>', 'Your question', '2026-12-24T11:00:00Z');
    await pickRow('u_pick', 'Other <desk@other.example>', theirs, { address: 'desk@other.example' });
    // With the day's findings used, a pick that doesn't match their matter isn't theirs: it waits.
    const used: string[] = [];
    for (let i = 0; i < AHEAD_FINDINGS_PER_DAY; i++)
      used.push(await insertRow({ state: 'told', kind: 'other' }));
    expect(await pass()).toBeNull();
    await t.services.db.delete(aheadChecks).where(inArray(aheadChecks.id, used));
    const r = await row(await pass());
    expect(r).toMatchObject({ source: 'mail', matterId: null });
    expect(r.event.matter).toBeUndefined();
    const ctx = await buildDispatchContext(t.services, await turnOf(r.dispatchId));
    expect(ctx.ahead?.matter).toBeUndefined();
    const mcp = await inTurn(r.dispatchId);
    await mcp.client.callTool({ name: 'mail_read', arguments: { messageId: 'u_pick' } });
    const told = await mcp.client.callTool({
      name: 'ahead_report',
      arguments: {
        found: true,
        kind: 'other',
        text: 'They asked a question.',
        sources: [{ mailId: 'u_pick' }],
      },
    });
    expect(told.structuredContent).toMatchObject({ told: true });
    await mcp.close();
    await endTurns();
    expect(await findingsSince(t.services.db, TEST_BURROW_ID, new Date('2026-12-24T00:00:00Z'))).toBe(1);
  });

  it('tries a watched reply whose check no runner took once more the next morning, not more', async () => {
    await clean();
    now = new Date('2026-12-24T20:20:00Z');
    const theirs = await asks(['parcel.example']);
    mail('w_parcel', 'Parcel <track@parcel.example>', 'Your parcel', '2026-12-24T20:15:00Z');
    now = new Date('2026-12-24T20:25:00Z');
    const first = await row(await pass());
    expect(first).toMatchObject({ source: 'mail', matterId: theirs });
    await endTurns();
    now = new Date('2026-12-25T08:05:00Z');
    const again = await row(await pass());
    expect(await row(first.id)).toMatchObject({ state: 'failed' });
    expect(again).toMatchObject({
      eventKey: first.eventKey,
      version: `${first.version.split(':')[0]}.again:mail`,
    });
    await endTurns();
    expect(await pass()).toBeNull();
    expect(await row(again.id)).toMatchObject({ state: 'failed' });
  });

  it('defers what a pass has no room for to the next one, and never gives a pass a matter’s note', async () => {
    await clean();
    now = new Date('2026-12-26T09:00:00Z');
    await asks(['nobody.example'], { note: 'Paid on the third' });
    const ws = t.services.google.workspace as FakeGoogleWorkspace;
    const search = ws.mailSearch.bind(ws);
    // The inbox holds more new mail than one pass lists.
    const spy = vi
      .spyOn(ws, 'mailSearch')
      .mockImplementation((token, input) => search(token, { ...input, limit: 100 }));
    try {
      for (let i = 0; i < 65; i++)
        mail(
          `x_${i}`,
          `Person ${i} <p${i}@example.org>`,
          `Hello ${i}`,
          new Date(Date.parse('2026-12-26T07:00:00Z') + i * 60_000).toISOString(),
        );
      const first = await row(await pass());
      expect(first.source).toBe('triage');
      expect(first.event.triage?.count).toBe(60);
      expect(first.event.triage?.mails).toHaveLength(60);
      expect(first.event.triage?.sweptAt).toBe('2026-12-26T07:00:00.000Z');
      const ctx = await buildDispatchContext(t.services, await turnOf(first.dispatchId));
      expect(ctx.ahead?.matters?.[0]).toBeDefined();
      expect(ctx.ahead?.matters?.[0]).not.toHaveProperty('note');
      await finishTriage(first.id);
      now = new Date('2026-12-26T09:05:00Z');
      const second = await row(await pass());
      expect(second.event.triage?.mails.map((m) => m.messageId).sort()).toEqual([
        'x_0',
        'x_1',
        'x_2',
        'x_3',
        'x_4',
      ]);
      await finishTriage(second.id);
    } finally {
      spy.mockRestore();
    }
  });

  it('opens no second matter with the title of an open one, and leaves that one as it is', async () => {
    await clean();
    now = new Date('2026-12-27T09:00:00Z');
    const theirs = await asks(['shop.example'], { title: 'Refund for the kettle', who: 'the shop' });
    mail('r_second', 'Other <desk@other.example>', 'About your kettle', '2026-12-27T08:00:00Z', {
      threadId: 'thr_second',
    });
    await pickRow('r_second', 'Other <desk@other.example>', undefined, { threadId: 'thr_second' });
    const r = await row(await pass());
    expect(r).toMatchObject({ source: 'mail', matterId: null });
    const mcp = await inTurn(r.dispatchId);
    await mcp.client.callTool({ name: 'mail_read', arguments: { messageId: 'r_second' } });
    const res = await mcp.client.callTool({
      name: 'ahead_report',
      arguments: {
        found: false,
        matter: { title: 'Refund for the Kettle', who: 'Someone else', waitingOn: 'you', due: '2026-12-30' },
      },
    });
    expect(res.structuredContent).toMatchObject({ status: 'ok', told: false });
    await mcp.close();
    await endTurns();
    // The check isn't linked to it either: its mail is no mail of that matter.
    expect((await row(r.id)).matterId).toBeNull();
    const open = await t.services.db.select().from(aheadMatters).where(eq(aheadMatters.state, 'open'));
    expect(open.map((m) => m.id)).toEqual([theirs]);
    expect(await matter(theirs)).toMatchObject({
      origin: 'person',
      who: 'the shop',
      waitingOn: 'them',
      dueAt: null,
      match: { threads: [], senders: ['shop.example'] },
    });
  });

  it('takes one mail a day on the sender alone for a matter a check opened', async () => {
    await clean();
    now = new Date('2026-12-28T09:00:00Z');
    const kept = await insertMatter({
      title: 'Order at the shop',
      match: { threads: [], senders: ['info@shop.example'], words: [] },
      createdAt: new Date(now.getTime() - HOUR),
    });
    mail('o_first', 'Shop <info@shop.example>', 'About your order', '2026-12-28T08:30:00Z');
    mail('o_second', 'Shop <info@shop.example>', 'Your delivery', '2026-12-28T08:40:00Z');
    const first = await row(await pass());
    expect(first).toMatchObject({ source: 'mail', matterId: kept });
    await endTurns();
    await t.services.db.update(aheadChecks).set({ state: 'quiet' }).where(eq(aheadChecks.id, first.id));
    // The second goes through a look at the new mail like any other.
    const next = await row(await pass());
    expect(next.source).toBe('triage');
    expect(next.event.triage?.mails.map((m) => m.messageId)).toEqual(['o_second']);
  });

  it('tries a mail check again in the morning when its turn came at night', async () => {
    await clean();
    now = new Date('2026-12-28T20:20:00Z');
    mail('n_pick', 'Ann <ann@example.org>', 'Can you answer by Friday?', '2026-12-28T20:00:00Z');
    await pickRow('n_pick', 'Ann <ann@example.org>');
    const first = await row(await pass());
    expect(first).toMatchObject({ source: 'mail', state: 'checking' });
    // Its turn comes after the day's hours: it may read nothing and says so.
    now = new Date('2026-12-28T21:10:00Z');
    const mcp = await inTurn(first.dispatchId);
    expect(
      (await mcp.client.callTool({ name: 'mail_read', arguments: { messageId: 'n_pick' } })).isError,
    ).toBe(true);
    await mcp.client.callTool({ name: 'ahead_report', arguments: { found: false } });
    await mcp.close();
    await endTurns();
    expect((await row(first.id)).state).toBe('failed');
    now = new Date('2026-12-29T08:05:00Z');
    const again = await row(await pass());
    expect(again).toMatchObject({ source: 'mail', eventKey: first.eventKey, state: 'checking' });
    expect(again.id).not.toBe(first.id);
  });

  it('opens nothing once incoming mail was switched off', async () => {
    await clean();
    now = new Date('2026-12-28T10:00:00Z');
    mail('s_pick', 'Shop <care@shop.example>', 'Your refund request', '2026-12-28T09:30:00Z');
    await pickRow('s_pick', 'Shop <care@shop.example>');
    const r = await row(await pass());
    const mcp = await inTurn(r.dispatchId);
    await mcp.client.callTool({ name: 'mail_read', arguments: { messageId: 's_pick' } });
    await t.commit(IDS.mara, updateLooksAhead, { mailOn: false });
    await mcp.client.callTool({
      name: 'ahead_report',
      arguments: { found: false, matter: { title: 'Refund from the shop', waitingOn: 'them' } },
    });
    await mcp.close();
    await endTurns();
    await t.commit(IDS.mara, updateLooksAhead, { mailOn: true });
    expect(await t.services.db.select().from(aheadMatters)).toHaveLength(0);
    expect((await row(r.id)).matterId).toBeNull();
  });

  it('settles a promoted thread its own finding began, replies in it included, and bundles unpromoted siblings', async () => {
    await clean();
    now = new Date('2026-12-29T09:00:00Z');
    const firmMatter = await insertMatter({
      title: 'Answer from the firm',
      match: {
        threads: [{ connectionId: mine.connectionId ?? '', threadId: 'thr_firm' }],
        senders: ['desk@firm.example'],
        words: [],
      },
      createdAt: new Date(now.getTime() - HOUR),
    });
    const tell = async (id: string, at: string) => {
      mail(id, 'Firm <desk@firm.example>', 'Re: your question', at, { threadId: 'thr_firm' });
      const r = await row(await pass());
      const mcp = await inTurn(r.dispatchId);
      await mcp.client.callTool({ name: 'mail_read', arguments: { messageId: id } });
      await mcp.client.callTool({
        name: 'ahead_report',
        arguments: { found: true, kind: 'other', text: 'They answered.', sources: [{ mailId: id }] },
      });
      await mcp.close();
      await endTurns();
      return row(r.id);
    };
    const a = await tell('g_first', '2026-12-29T08:30:00Z');
    now = new Date('2026-12-29T09:30:00Z');
    const b = await tell('g_second', '2026-12-29T09:20:00Z');
    expect([a.state, b.state]).toEqual(['told', 'told']);
    // Both land in Inbox before promotion.
    expect(await t.services.db.select().from(messages).where(eq(messages.id, a.threadRootId))).toEqual([]);
    expect(await t.services.db.select().from(messages).where(eq(messages.id, b.threadRootId))).toEqual([]);

    // Promoting b without replying pulls sibling a into the same Chat thread chronologically.
    const promoted = await t.commit(IDS.mara, promoteAheadFinding, { checkId: b.id });
    expect(promoted.status).toBe('ok');
    expect((await matter(firmMatter)).threadRootId).toBe(a.threadRootId);
    const [reply] = await t.services.db.select().from(messages).where(eq(messages.id, b.threadRootId));
    expect(reply?.threadRootId).toBe(a.threadRootId);
    await t.services.db
      .update(aheadChecks)
      .set({ endAt: new Date(now.getTime() - 3 * HOUR) })
      .where(inArray(aheadChecks.id, [a.id, b.id]));
    await t.commit(mine.agentId, tidyAhead, {});
    const [root] = await t.services.db.select().from(messages).where(eq(messages.id, a.threadRootId));
    expect(root?.settledAt).not.toBeNull();
    // “Open thread” on the reply opens that thread.
    const view = await looksAheadView(t.services, TEST_BURROW_ID);
    expect(view.recent?.find((r) => r.id === b.id)?.threadRootId).toBe(a.threadRootId);
  });

  it('closes a matter directly from the Inbox on “Stop keeping an eye on this” without stopping the kind', async () => {
    await clean();
    now = new Date('2026-12-29T11:00:00Z');
    const kept = await insertMatter({
      title: 'Refund for the lamp',
      createdAt: new Date('2026-12-23T10:00:00Z'),
      lastNewsAt: new Date('2026-12-23T10:00:00Z'),
    });
    const r = await row(await pass());
    expect(r).toMatchObject({ source: 'matter', matterId: kept });
    const mcp = await inTurn(r.dispatchId);
    await mcp.client.callTool({
      name: 'ahead_report',
      arguments: {
        found: true,
        kind: 'deadline',
        title: 'No answer on lamp refund',
        text: 'Still nothing on the lamp refund.',
        sources: [{ matter: true }],
      },
    });
    await mcp.close();
    await endTurns();

    const fb = await t.commit(IDS.mara, aheadInboxFeedback, { checkId: r.id, verdict: 'stop_kind' });
    expect(fb).toMatchObject({ status: 'ok', result: { ok: true, kind: 'deadline', stopped: 'matter' } });
    expect(await matter(kept)).toMatchObject({ state: 'closed', closedReason: 'removed' });
    expect((await aheadSettingsOf(t.services.db, TEST_BURROW_ID)).stopped).not.toContain('deadline');
    const inbox = await looksAheadNeedsYou({
      db: t.services.db,
      burrowId: TEST_BURROW_ID,
      personId: IDS.mara,
      now,
    });
    expect(inbox.some((i) => i.ref.id === r.id)).toBe(false);
  });

  it('may still try a failed date follow-up again until the evening of its date', async () => {
    await clean();
    now = new Date('2026-12-28T10:00:00Z');
    await insertMatter({
      title: 'Answer the school',
      waitingOn: 'you',
      dueAt: new Date('2026-12-28T12:00:00Z'),
      createdAt: new Date('2026-12-20T10:00:00Z'),
      lastNewsAt: new Date('2026-12-20T10:00:00Z'),
    });
    const first = await row(await pass());
    expect(first.version).toBe('due:matter');
    await endTurns();
    now = new Date('2026-12-28T15:00:00Z');
    const again = await row(await pass());
    expect(await row(first.id)).toMatchObject({ state: 'failed' });
    expect(again.version).toBe('due.again:matter');
    await endTurns();
  });
});
