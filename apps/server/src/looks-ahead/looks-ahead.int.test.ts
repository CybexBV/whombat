/**
 * Looks ahead (docs/decisions/looks-ahead.md), end to end on a real database:
 * - reads calendars (own + Family on, Holidays off), incoming mail setting, standing rules and recent checks;
 * - prioritises higher-signal plans, passes same-day schedule context, enforces read-only tool isolation and web closure
 *   on private reads (mail, Drive files, Paperless/Notion docs);
 * - posts findings with verified sources and optional one-tap action chips, replies into the same event thread on a
 *   later check stage with prior-stage notes;
 * - looks through incoming mail and checks its pick on its own (web closed from start, 14-day schedule context);
 * - records “Not useful” feedback with reason into future calibration, stops kinds, settles threads, and supports
 *   `checkAheadNow`.
 * Postgres because every step is a signed commit and a queued turn.
 */
import { AHEAD_REPLIES, type CalendarEvent } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueDispatchToken } from '../auth/agent-tokens';
import { sendMessage } from '../commands/messages';
import type { FakeGoogleWorkspace } from '../connectors/workspace-fake';
import {
  aheadChecks,
  burrows,
  catalogConnections,
  dispatches,
  hermesSessionDrops,
  messages,
  notifications,
} from '../db/schema/index';
import { messageDedupKey } from '../domain/message-notify';
import { useOpenDataForTests } from '../lib/open-data';
import { AHEAD_TOOLS } from '../mcp/served';
import { buildDispatchContext } from '../runtime/context';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { grantKey } from '../test/grants';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { minimalPdf } from '../test/pdf';
import { addPersonalAgent, FAKE_ACCESS_TOKEN, type PersonalSetup } from '../test/personal';
import { metAnswer } from '../weather/testing';
import { sealWebSearchKey } from '../web-search/store';
import { aheadSettingsOf, updateLooksAhead } from './commands';
import { useAheadDocsForTests } from './docs';
import { looksAheadView } from './settings';
import { checkAheadNow, watchAhead } from './watch';
import { useAheadWebForTests } from './web';

const t = useTestServer({ seed: true, listen: true });
let mine: PersonalSetup;
let realClock: () => Date;
let now = new Date('2026-12-13T15:00:00Z');
const ready = { ready: async () => true };

const event = (
  e: Partial<CalendarEvent> & Pick<CalendarEvent, 'id' | 'summary' | 'start' | 'end'>,
): CalendarEvent => ({
  calendarId: 'primary',
  description: '',
  location: '',
  allDay: false,
  guests: [],
  organizer: 'you@example.com',
  webUrl: null,
  meetUrl: null,
  ...e,
});

async function row(id: string) {
  const [r] = await t.services.db.select().from(aheadChecks).where(eq(aheadChecks.id, id));
  if (!r) throw new Error(id);
  return r;
}

async function inTurn(dispatchId: string) {
  const token = await issueDispatchToken(t.services, dispatchId);
  return mcpClient(t.baseUrl, token.token);
}

function said(result: object): string {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

beforeAll(async () => {
  realClock = t.services.clock;
  t.services.clock = () => now;
  mine = await addPersonalAgent(t.services, TEST_BURROW_ID, IDS.mara);
  await t.services.db.update(burrows).set({ timeZone: 'UTC' }).where(eq(burrows.id, TEST_BURROW_ID));
  const google = (t.services.google.workspace as FakeGoogleWorkspace).stateFor(FAKE_ACCESS_TOKEN);
  google.calendarNames = { family: 'Family', holidays: 'Holidays' };
  google.readOnlyCalendars = ['holidays'];
  // Keep fake mail quiet for the initial calendar tests; dedicated mail test adds a booking email later.
  google.messages = google.messages.map((m) => ({
    ...m,
    date: new Date('2026-12-01T10:00:00Z'),
  }));
  google.events = [
    event({
      id: 'script',
      summary: 'The Script',
      start: '2026-12-14T20:00:00Z',
      end: '2026-12-14T23:00:00Z',
      location: 'Ziggo Dome, Amsterdam',
      description: 'Tickets: https://tickets.example.com/order/77',
      response: 'accepted',
    }),
    event({
      id: 'evening',
      calendarId: 'family',
      summary: 'Parents’ evening',
      start: '2026-12-14T19:00:00Z',
      end: '2026-12-14T19:30:00Z',
      location: 'School, Utrecht',
    }),
    event({
      id: 'hockey',
      summary: 'Hockey practice',
      start: '2026-12-14T18:00:00Z',
      end: '2026-12-14T19:00:00Z',
      location: 'Sportpark',
      recurring: true,
    }),
    event({
      id: 'call',
      summary: 'Team call',
      start: '2026-12-14T10:00:00Z',
      end: '2026-12-14T10:30:00Z',
      location: 'Microsoft Teams Meeting',
    }),
    event({
      id: 'stranger',
      summary: 'Free cruise',
      start: '2026-12-14T12:00:00Z',
      end: '2026-12-14T13:00:00Z',
      location: 'Harbour',
      organizer: 'spam@example.net',
      response: 'needs_action',
    }),
    event({
      id: 'kingsday',
      calendarId: 'holidays',
      summary: 'Some holiday',
      start: '2026-12-14T09:00:00Z',
      end: '2026-12-14T11:00:00Z',
      location: 'Everywhere',
    }),
  ];
  useAheadWebForTests(t.services, async (url) => {
    if (url.startsWith('https://api.search.brave.com/'))
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            web: {
              results: [
                {
                  title: 'The Script · Ziggo Dome',
                  url: 'https://venue.example.com/the-script',
                  description: '20:45',
                },
              ],
            },
          }),
        ),
      };
    return {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from('<title>The Script</title><p>Doors 19:30, show 20:45.</p>'),
    };
  });
});

afterAll(() => {
  useAheadDocsForTests(t.services, null);
  t.services.clock = realClock;
});

describe('Looks ahead (looks-ahead.md)', () => {
  let first = '';
  let second = '';

  it('reads calendars, incoming mail flag, rules and recent checks', async () => {
    const view = await looksAheadView(t.services, TEST_BURROW_ID);
    expect(view).toMatchObject({
      on: true,
      hasCalendar: true,
      calendarsRead: true,
      mailOn: true,
      hasMail: true,
      rules: [],
      stopped: [],
    });
    const byName = new Map(view.calendars.map((c) => [c.name, c.on]));
    expect(byName.get('Calendar')).toBe(true);
    expect(byName.get('Family')).toBe(true);
    expect(byName.get('Holidays')).toBe(false);
  });

  it('searches no web while “Browse the web” isn’t Allowed', async () => {
    await grantKey(t, mine.agentId, 'web.browse', 'ask');
    await t.services.db
      .update(burrows)
      .set({
        webSearch: { provider: 'brave', check: null, updatedAt: now.toISOString() },
        webSearchKeyEnc: sealWebSearchKey(t.services.custody, TEST_BURROW_ID, 'brave-test-key'),
      })
      .where(eq(burrows.id, TEST_BURROW_ID));
    const id = (await watchAhead(t.services, TEST_BURROW_ID, ready)) ?? '';
    const mcp = await inTurn((await row(id)).dispatchId ?? '');
    const search = await mcp.client.callTool({ name: 'search_web', arguments: { query: 'Ziggo Dome' } });
    expect(search.isError).toBe(true);
    await mcp.client.callTool({ name: 'ahead_report', arguments: { found: false } });
    await mcp.close();
    await grantKey(t, mine.agentId, 'web.browse', 'can');
    await t.services.db
      .update(burrows)
      .set({ webSearch: null, webSearchKeyEnc: null })
      .where(eq(burrows.id, TEST_BURROW_ID));
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.trigger, 'ahead'));
    await t.services.db.delete(aheadChecks).where(eq(aheadChecks.burrowId, TEST_BURROW_ID));
  });

  it('reads no calendar or mail when both keys ask first', async () => {
    await grantKey(t, mine.agentId, 'calendar.read', 'ask');
    await grantKey(t, mine.agentId, 'mail.read', 'ask');
    expect(await watchAhead(t.services, TEST_BURROW_ID, ready)).toBeNull();
    await grantKey(t, mine.agentId, 'calendar.read', 'can');
    await grantKey(t, mine.agentId, 'mail.read', 'can');
  });

  it('prioritises the high-signal venue event, carries same-day trusted schedule, and hides stranger invites', async () => {
    // Save a standing rule first so it flows into DispatchContext.
    await t.commit(IDS.mara, updateLooksAhead, { addRule: 'I live in Utrecht and usually drive' });
    first = (await watchAhead(t.services, TEST_BURROW_ID, ready)) ?? '';
    expect(first).toMatch(/^ahc_/);
    const check = await row(first);
    // The Script beats Parents’ evening because of higher signal priority (venue + notes).
    expect(check).toMatchObject({
      state: 'checking',
      summary: 'The Script',
      source: 'calendar',
      stage: 'eve',
    });
    const [turn] = await t.services.db
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, check.dispatchId ?? ''));
    expect(turn).toMatchObject({
      trigger: 'ahead',
      state: 'queued',
      threadRootId: check.threadRootId,
      conversationId: mine.dmId,
    });
    // Nothing posted, nothing in the inbox.
    expect(await t.services.db.select().from(messages).where(eq(messages.id, check.threadRootId))).toEqual(
      [],
    );
    // One at a time.
    expect(await watchAhead(t.services, TEST_BURROW_ID, ready)).toBeNull();
    // Context includes same-day trusted schedule (Parents’ evening, Hockey, Team call) and standing rules, NEVER stranger invite.
    const context = await buildDispatchContext(t.services, turn as NonNullable<typeof turn>);
    expect(context.ahead).toMatchObject({
      summary: 'The Script',
      location: 'Ziggo Dome, Amsterdam',
      stage: 'eve',
      rules: ['I live in Utrecht and drive'.length ? 'I live in Utrecht and usually drive' : ''],
    });
    expect(context.ahead?.daySchedule?.map((s) => s.summary)).toContain('Parents’ evening');
    expect(context.ahead?.daySchedule?.map((s) => s.summary)).not.toContain('Free cruise');
    expect(context.thread).toBeNull();
  });

  it('serves only ahead tools, posts a finding with one-tap action chip and verified web/mail/file/doc sources, and replies into the same thread on a later stage', async () => {
    const custody = t.services.custody;
    await t.services.db
      .update(burrows)
      .set({
        webSearch: { provider: 'brave', check: null, updatedAt: now.toISOString() },
        webSearchKeyEnc: sealWebSearchKey(custody, TEST_BURROW_ID, 'brave-test-key'),
      })
      .where(eq(burrows.id, TEST_BURROW_ID));
    // Add an active Paperless catalog connection so ahead_read_docs is listed and works.
    await t.services.db.insert(catalogConnections).values({
      id: 'ccn_paperless_ahead',
      catalogId: 'paperless',
      burrowId: TEST_BURROW_ID,
      label: 'Paperless',
      handle: 'paperless',
      transport: 'rest',
      signIn: 'token',
      baseUrl: 'https://paperless.example.com',
      status: 'active',
      access: 'read',
    });
    useAheadDocsForTests(t.services, async () => [
      {
        docId: 'paperless:ccn_paperless_ahead:42',
        source: 'Paperless',
        title: 'Ziggo Dome Ticket',
        excerpt: 'Row 4 Seat 12',
      },
    ]);

    const check = await row(first);
    const mcp = await inTurn(check.dispatchId ?? '');
    const names = (await mcp.client.listTools()).tools.map((x) => x.name).sort();
    // A calendar check: everything but the triage pass's own end.
    expect(names).toEqual(AHEAD_TOOLS.filter((n) => n !== 'ahead_triage').sort());
    const posting = await mcp.client.callTool({
      name: 'post_message',
      arguments: { conversationId: mine.dmId, text: 'hi' },
    });
    expect(posting.isError).toBe(true);
    // Links from the event notes cannot be opened.
    const ticket = await mcp.client.callTool({
      name: 'read_web_page',
      arguments: { url: 'https://tickets.example.com/order/77' },
    });
    expect(ticket.isError).toBe(true);
    // Private numbers refused in web search.
    const leaky = await mcp.client.callTool({
      name: 'search_web',
      arguments: { query: 'The Script order 4471929' },
    });
    expect(leaky.isError).toBe(true);
    // Web first.
    const results = await mcp.client.callTool({
      name: 'search_web',
      arguments: { query: 'The Script Ziggo Dome' },
    });
    expect(results.isError).toBeFalsy();
    const page = await mcp.client.callTool({
      name: 'read_web_page',
      arguments: { url: 'https://venue.example.com/the-script' },
    });
    expect(said(page)).toContain('20:45');
    // Private docs (Paperless) + mail close the web.
    const docs = await mcp.client.callTool({
      name: 'ahead_read_docs',
      arguments: { query: 'Ziggo Dome' },
    });
    expect(docs.isError).toBeFalsy();
    const lateWeb = await mcp.client.callTool({ name: 'search_web', arguments: { query: 'Ziggo Dome' } });
    expect(lateWeb.isError).toBe(true);
    expect((await row(first)).mailReadAt).not.toBeNull();
    const box = await mcp.client.callTool({ name: 'mail_search', arguments: { query: '' } });
    const mailId = (box.structuredContent as { messages: { id: string }[] }).messages[0]?.id ?? '';
    await mcp.client.callTool({ name: 'mail_read', arguments: { messageId: mailId } });
    // The weather where the Whombat is, and the person's news (weather-news.md): another place only while the web is
    // open, and no site on.
    await t.services.db
      .update(burrows)
      .set({ place: { name: 'Utrecht', lat: 52.09, lon: 5.12, country: 'NL', region: 'NL-UT' } })
      .where(eq(burrows.id, TEST_BURROW_ID));
    useOpenDataForTests(t.services, async (url) =>
      url.startsWith('https://api.met.no/')
        ? { status: 200, headers: {}, body: Buffer.from(JSON.stringify(metAnswer('2026-12-13T15:00:00Z'))) }
        : { status: 404, headers: {}, body: Buffer.alloc(0) },
    );
    const weather = await mcp.client.callTool({ name: 'weather_forecast', arguments: { days: 2 } });
    expect(weather.structuredContent).toMatchObject({ status: 'ok', place: { name: 'Utrecht' } });
    const elsewhere = await mcp.client.callTool({
      name: 'weather_forecast',
      arguments: { place: 'Amsterdam' },
    });
    expect(elsewhere.isError).toBe(true);
    const headlines = await mcp.client.callTool({ name: 'news_headlines', arguments: {} });
    expect(headlines.structuredContent).toMatchObject({ status: 'none' });

    // Report with primary kind, extraKinds, one-tap action chip, note, and multiple verified sources.
    const told = await mcp.client.callTool({
      name: 'ahead_report',
      arguments: {
        found: true,
        kind: 'time',
        extraKinds: ['crowds'],
        text: 'The Script starts at 20:45, not 20:00. Ajax plays nearby. See https://evil.example.net/x',
        action: 'Update event to 20:45',
        note: 'Verified 20:45 on venue site and tickets in Paperless.',
        sources: [
          { url: 'https://venue.example.com/the-script' },
          { mailId },
          { docId: 'paperless:ccn_paperless_ahead:42' },
          { weather: true },
        ],
      },
    });
    expect(told.structuredContent).toMatchObject({ status: 'ok', told: true });
    await mcp.close();

    const after = await row(first);
    expect(after).toMatchObject({
      state: 'told',
      kind: 'time',
      extraKinds: ['crowds'],
      actionLabel: 'Update event to 20:45',
      note: 'Verified 20:45 on venue site and tickets in Paperless.',
    });
    const [root] = await t.services.db.select().from(messages).where(eq(messages.id, after.threadRootId));
    expect(root).toMatchObject({ authorId: mine.agentId, conversationId: mine.dmId, threadRootId: null });
    expect(root?.text).toContain('20:45');
    expect(root?.text).toContain('[venue.example.com](https://venue.example.com/the-script)');
    expect(root?.text).toContain('(mail)');
    expect(root?.text).toContain('Paperless');
    expect(root?.text).toContain('Data from MET Norway');
    expect(root?.text).not.toContain('evil.example.net');
    expect(root?.suggestions).toEqual(['Update event to 20:45', ...AHEAD_REPLIES]);

    await t.services.db
      .update(dispatches)
      .set({ state: 'done' })
      .where(eq(dispatches.id, check.dispatchId ?? ''));
    await t.services.background.settle();
    const inbox = await t.services.db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupKey, messageDedupKey(after.threadRootId)));
    expect(inbox.map((n) => n.kind)).toEqual(['agent_update']);

    // Morning-of stage (3 hours before start) runs as a later stage, carries priorChecks note, and replies in the SAME thread!
    now = new Date('2026-12-14T17:00:00Z');
    const morningId = (await watchAhead(t.services, TEST_BURROW_ID, { ...ready, fresh: true })) ?? '';
    expect(morningId).toMatch(/^ahc_/);
    const morningRow = await row(morningId);
    expect(morningRow).toMatchObject({ summary: 'The Script', stage: 'morning' });
    const [mTurn] = await t.services.db
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, morningRow.dispatchId ?? ''));
    const mCtx = await buildDispatchContext(t.services, mTurn as NonNullable<typeof mTurn>);
    expect(mCtx.ahead?.priorChecks?.[0]).toMatchObject({
      stage: 'eve',
      state: 'told',
      note: 'Verified 20:45 on venue site and tickets in Paperless.',
    });
    const mMcp = await inTurn(morningRow.dispatchId ?? '');
    const mTold = await mMcp.client.callTool({
      name: 'ahead_report',
      arguments: {
        found: true,
        kind: 'conflict',
        text: 'Parents’ evening in Utrecht ends at 19:30, leaving tight travel to Amsterdam.',
        sources: [{ calendar: true }],
      },
    });
    expect(mTold.structuredContent).toMatchObject({ status: 'ok', told: true });
    await mMcp.close();
    const [replyMsg] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, morningRow.threadRootId));
    // Posted as a reply in the existing event thread!
    expect(replyMsg?.threadRootId).toBe(after.threadRootId);
    expect(replyMsg?.text).toContain('Your calendar');
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.trigger, 'ahead'));
    now = new Date('2026-12-13T15:00:00Z');
  });

  it('records “Not useful” with reason for future calibration and supports “Stop checking for this”', async () => {
    const check = await row(first);
    const res = await t.commit(IDS.mara, sendMessage, {
      conversationId: mine.dmId,
      threadRootId: check.threadRootId,
      text: 'Not useful, I already planned the drive',
    });
    const messageId = (res as { result: { id: string } }).result.id;
    const [turn] = await t.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.messageId, messageId), eq(dispatches.agentId, mine.agentId)));
    const mcp = await inTurn(turn?.id ?? '');
    const fb = await mcp.client.callTool({
      name: 'ahead_feedback',
      arguments: { verdict: 'not_useful', reason: 'Already planned the drive' },
    });
    expect(fb.structuredContent).toMatchObject({ status: 'ok' });
    const stop = await mcp.client.callTool({
      name: 'ahead_feedback',
      arguments: { verdict: 'stop_kind' },
    });
    expect(stop.structuredContent).toMatchObject({ status: 'ok' });
    await mcp.close();
    expect((await aheadSettingsOf(t.services.db, TEST_BURROW_ID)).stopped).toContain('conflict');
    await t.services.db
      .update(dispatches)
      .set({ state: 'done' })
      .where(eq(dispatches.id, turn?.id ?? ''));
  });

  it('checks incoming mail proactively with web closed from the start and 14-day schedule context', async () => {
    const booking = minimalPdf(['Hotel Chiado', 'Check-in 22 December 2026 from 15:00', 'Room 214']);
    const terms = Buffer.from('Terms. '.repeat(5000));
    await t.services.db.delete(aheadChecks).where(eq(aheadChecks.burrowId, TEST_BURROW_ID));
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.trigger, 'ahead'));
    const google = (t.services.google.workspace as FakeGoogleWorkspace).stateFor(FAKE_ACCESS_TOKEN);
    // Clear calendar events in the next 7 days so the mail candidate runs next; keep one event 10 days out.
    google.events = [
      event({
        id: 'later_flight',
        summary: 'Conference Lisbon',
        start: '2026-12-23T09:00:00Z',
        end: '2026-12-23T17:00:00Z',
        location: 'Lisbon',
      }),
    ];
    google.messages.unshift({
      id: 'msg_hotel_booking',
      threadId: 'thr_hotel_booking',
      from: 'bookings@hotel.example',
      to: ['mara@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hotel reservation confirmation — Lisbon Dec 22',
      date: new Date('2026-12-13T12:00:00Z'),
      body: 'Booking confirmed for 22 Dec 2026 at Hotel Chiado, Lisbon.',
      labelIds: ['INBOX', 'UNREAD'],
      attachments: [
        {
          id: 'att_booking',
          name: 'booking.pdf',
          mimeType: 'application/pdf',
          size: booking.length,
          contentBase64: booking.toString('base64'),
        },
        {
          id: 'att_terms',
          name: 'terms.txt',
          mimeType: 'text/plain',
          size: terms.length,
          contentBase64: terms.toString('base64'),
        },
      ],
    });

    // New mail is looked through as a whole first; its pick is checked on its own on the next pass.
    const look = await row((await watchAhead(t.services, TEST_BURROW_ID, { ...ready, fresh: true })) ?? '');
    expect(look).toMatchObject({ source: 'triage', state: 'checking' });
    expect(look.event.triage?.mails.map((m) => m.messageId)).toEqual(['msg_hotel_booking']);
    const triage = await inTurn(look.dispatchId ?? '');
    await triage.client.callTool({ name: 'ahead_triage', arguments: { picks: [{ mail: 'm1' }] } });
    await triage.close();
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.trigger, 'ahead'));
    second = (await watchAhead(t.services, TEST_BURROW_ID, ready)) ?? '';
    expect(second).toMatch(/^ahc_/);
    const mailRow = await row(second);
    expect(mailRow).toMatchObject({ source: 'mail', stage: 'mail', state: 'checking' });
    // Web is closed from the very start on mail-triggered checks!
    expect(mailRow.mailReadAt).not.toBeNull();
    const [turn] = await t.services.db
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, mailRow.dispatchId ?? ''));
    const ctx = await buildDispatchContext(t.services, turn as NonNullable<typeof turn>);
    expect(ctx.ahead?.source).toBe('mail');
    expect(ctx.ahead?.mail?.subject).toContain('Hotel reservation');
    expect(ctx.ahead?.daySchedule?.map((s) => s.summary)).toContain('Conference Lisbon');

    const mcp = await inTurn(mailRow.dispatchId ?? '');
    const webBlocked = await mcp.client.callTool({
      name: 'search_web',
      arguments: { query: 'Hotel Chiado' },
    });
    expect(webBlocked.isError).toBe(true);
    await mcp.client.callTool({ name: 'mail_read', arguments: { messageId: 'msg_hotel_booking' } });
    // What the mail's attachments say is read too: a PDF's text, a text file's cut as a mail body is.
    const pdf = await mcp.client.callTool({
      name: 'mail_attachment_open',
      arguments: { messageId: 'msg_hotel_booking', attachmentId: 'att_booking' },
    });
    expect(pdf.structuredContent).toMatchObject({ status: 'ok', attachment: { shows: 'text', pages: 1 } });
    expect(said(pdf)).toContain('Room 214');
    const long = await mcp.client.callTool({
      name: 'mail_attachment_open',
      arguments: { messageId: 'msg_hotel_booking', attachmentId: 'att_terms' },
    });
    const cut = (long.structuredContent as { attachment: { text: string; truncated: boolean } }).attachment;
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBeLessThan(terms.length / 3);
    const reported = await mcp.client.callTool({
      name: 'ahead_report',
      arguments: {
        found: true,
        kind: 'missing_event',
        text: 'Your Hotel Chiado booking for 22 Dec is confirmed in mail but not on your calendar.',
        action: 'Add hotel stay to calendar',
        sources: [{ mailId: 'msg_hotel_booking' }],
      },
    });
    expect(reported.structuredContent).toMatchObject({ status: 'ok', told: true });
    await mcp.close();
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.trigger, 'ahead'));

    // Recent checks in Settings view shows the mail check and its thread link, and the look as a mail row.
    const view = await looksAheadView(t.services, TEST_BURROW_ID);
    const shown = view.recent?.find((r) => r.id === second);
    expect(shown).toMatchObject({
      source: 'mail',
      stage: 'mail',
      state: 'told',
      kind: 'missing_event',
    });
    expect(shown?.threadRootId).toBeTruthy();
    expect(view.recent?.find((r) => r.id === look.id)).toMatchObject({
      source: 'mail',
      stage: 'mail',
      of: 'triage',
      count: 1,
      picked: 1,
    });

    // checkAheadNow returns false when nothing more is due, and respects switching mailOn off.
    expect(await checkAheadNow(t.services, TEST_BURROW_ID, ready)).toBe(false);
  });

  it('cancels stale checks, drops Hermes sessions and respects night hours', async () => {
    await t.services.db.delete(aheadChecks).where(eq(aheadChecks.burrowId, TEST_BURROW_ID));
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.trigger, 'ahead'));
    const google = (t.services.google.workspace as FakeGoogleWorkspace).stateFor(FAKE_ACCESS_TOKEN);
    google.events = [
      event({
        id: 'plain_plan',
        summary: 'Coldplay',
        start: '2026-12-14T20:00:00Z',
        end: '2026-12-14T23:00:00Z',
        location: '',
      }),
    ];
    now = new Date('2026-12-14T10:00:00Z');
    const stale = (await watchAhead(t.services, TEST_BURROW_ID, { ...ready, fresh: true })) ?? '';
    expect((await row(stale)).summary).toBe('Coldplay');
    const staleTurn = (await row(stale)).dispatchId ?? '';
    now = new Date('2026-12-14T12:01:00Z');
    await watchAhead(t.services, TEST_BURROW_ID, ready);
    expect((await row(stale)).state).toBe('failed');
    const [cancelled] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, staleTurn));
    expect(cancelled?.state).toBe('cancelled');

    await t.services.db
      .update(dispatches)
      .set({ providerSessionId: 'hermes:ahead-session-1' })
      .where(eq(dispatches.id, staleTurn));
    await watchAhead(t.services, TEST_BURROW_ID, ready);
    const drops = await t.services.db
      .select()
      .from(hermesSessionDrops)
      .where(eq(hermesSessionDrops.sessionId, 'ahead-session-1'));
    expect(drops).toHaveLength(1);
    const [forgotten] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, staleTurn));
    expect(forgotten?.providerSessionId).toBeNull();

    // Nothing begins after 20:30.
    now = new Date('2026-12-13T20:35:00Z');
    expect(await watchAhead(t.services, TEST_BURROW_ID, ready)).toBeNull();
  });
});
