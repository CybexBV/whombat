/**
 * Looks ahead (docs/decisions/looks-ahead.md), end to end on a real database: the setting reads the person's calendars
 * (a Family calendar on by default), the watcher begins the check of the soonest due event — a quiet turn in a thread
 * that isn't there yet, nothing posted — the check is served only its own tools, nothing found leaves no trace, a
 * finding is posted in its own thread with a push and quick replies and names only what the check saw, the person's
 * word in that thread stops a kind, the thread settles after the event, and the setting switches it off. Postgres
 * because every step is a signed commit and a queued turn.
 */
import { AHEAD_REPLIES, type CalendarEvent } from '@whombat/core';
import { and, eq, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueDispatchToken } from '../auth/agent-tokens';
import { sendMessage } from '../commands/messages';
import type { FakeGoogleWorkspace } from '../connectors/workspace-fake';
import { aheadChecks, burrows, dispatches, messages, notifications } from '../db/schema/index';
import { messageDedupKey } from '../domain/message-notify';
import { AHEAD_TOOLS } from '../mcp/served';
import { buildDispatchContext } from '../runtime/context';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent, FAKE_ACCESS_TOKEN, type PersonalSetup } from '../test/personal';
import { sealWebSearchKey } from '../web-search/store';
import { aheadSettingsOf } from './commands';
import { looksAheadView } from './settings';
import { watchAhead } from './watch';
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
  t.services.clock = realClock;
});

describe('Looks ahead (looks-ahead.md)', () => {
  let first = '';
  let second = '';

  it('reads the person’s calendars: their own and a Family calendar on, a holidays calendar off', async () => {
    const view = await looksAheadView(t.services, TEST_BURROW_ID);
    expect(view).toMatchObject({ on: true, hasCalendar: true, calendarsRead: true, stopped: [] });
    const byName = new Map(view.calendars.map((c) => [c.name, c.on]));
    expect(byName.get('you@example.com')).toBe(true);
    expect(byName.get('Family')).toBe(true);
    expect(byName.get('Holidays')).toBe(false);
  });

  it('begins the soonest due event’s check: a quiet turn in a thread that isn’t there yet', async () => {
    first = (await watchAhead(t.services, TEST_BURROW_ID, ready)) ?? '';
    expect(first).toMatch(/^ahc_/);
    const check = await row(first);
    expect(check).toMatchObject({ state: 'checking', summary: 'Parents’ evening', calendar: 'Family' });
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
    // The turn is told the event, as data.
    const context = await buildDispatchContext(t.services, turn as NonNullable<typeof turn>);
    expect(context.ahead).toMatchObject({
      summary: 'Parents’ evening',
      calendar: 'Family',
      location: 'School, Utrecht',
    });
    expect(context.thread).toBeNull();
    expect(context.webSearch ?? null).toBeNull();
  });

  it('serves the check only its own tools, and nothing found leaves no trace', async () => {
    const check = await row(first);
    const mcp = await inTurn(check.dispatchId ?? '');
    const names = (await mcp.client.listTools()).tools.map((x) => x.name).sort();
    expect(names).toEqual([...AHEAD_TOOLS].sort());
    const posting = await mcp.client.callTool({
      name: 'post_message',
      arguments: { conversationId: mine.dmId, text: 'hi' },
    });
    expect(posting.isError).toBe(true);
    // No Brave key yet: it goes on without the web.
    const search = await mcp.client.callTool({ name: 'search_web', arguments: { query: 'School Utrecht' } });
    expect(search.isError).toBe(true);
    // Only links it saw.
    const made = await mcp.client.callTool({
      name: 'read_web_page',
      arguments: { url: 'https://evil.example.net/?q=parents-evening' },
    });
    expect(made.isError).toBe(true);
    const quiet = await mcp.client.callTool({ name: 'ahead_report', arguments: { found: false } });
    expect(quiet.isError).toBeFalsy();
    expect(quiet.structuredContent).toMatchObject({ status: 'ok', told: false });
    expect(await row(first)).toMatchObject({ state: 'quiet', kind: null, text: null });
    expect(await t.services.db.select().from(messages).where(eq(messages.id, check.threadRootId))).toEqual(
      [],
    );
    // Once only.
    const again = await mcp.client.callTool({ name: 'ahead_report', arguments: { found: false } });
    expect(again.isError).toBe(true);
    await mcp.close();
    await t.services.db
      .update(dispatches)
      .set({ state: 'done' })
      .where(eq(dispatches.id, check.dispatchId ?? ''));
  });

  it('posts a finding in its own thread with a push, naming only what the check saw', async () => {
    const custody = t.services.custody;
    await t.services.db
      .update(burrows)
      .set({
        webSearch: { provider: 'brave', check: null, updatedAt: now.toISOString() },
        webSearchKeyEnc: sealWebSearchKey(custody, TEST_BURROW_ID, 'brave-test-key'),
      })
      .where(eq(burrows.id, TEST_BURROW_ID));
    second = (await watchAhead(t.services, TEST_BURROW_ID, ready)) ?? '';
    const check = await row(second);
    expect(check).toMatchObject({ summary: 'The Script', state: 'checking' });
    const mcp = await inTurn(check.dispatchId ?? '');
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
    // A source it never saw is refused.
    const unseen = await mcp.client.callTool({
      name: 'ahead_report',
      arguments: {
        found: true,
        kind: 'time',
        text: 'It starts at 20:45.',
        sources: [{ url: 'https://other.example.org/', title: 'other' }],
      },
    });
    expect(unseen.isError).toBe(true);
    const told = await mcp.client.callTool({
      name: 'ahead_report',
      arguments: {
        found: true,
        kind: 'time',
        text: 'The Script starts at 20:45, not 20:00 as in your calendar.',
        sources: [{ url: 'https://venue.example.com/the-script', title: 'venue.example.com' }],
      },
    });
    expect(told.structuredContent).toMatchObject({ status: 'ok', told: true });
    await mcp.close();
    const after = await row(second);
    expect(after).toMatchObject({ state: 'told', kind: 'time' });
    const [root] = await t.services.db.select().from(messages).where(eq(messages.id, after.threadRootId));
    expect(root).toMatchObject({ authorId: mine.agentId, conversationId: mine.dmId, threadRootId: null });
    expect(root?.text).toContain('20:45');
    expect(root?.text).toContain('(https://venue.example.com/the-script)');
    expect(root?.suggestions).toEqual([...AHEAD_REPLIES]);
    await t.services.db
      .update(dispatches)
      .set({ state: 'done' })
      .where(eq(dispatches.id, check.dispatchId ?? ''));
    // The person is told: inbox and push, as any message of the assistant's in their Chat.
    await t.services.background.settle();
    const inbox = await t.services.db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupKey, messageDedupKey(after.threadRootId)));
    expect(inbox.map((n) => n.kind)).toEqual(['agent_update']);
  });

  it('keeps the person’s word on a finding: their turn in its thread stops that kind', async () => {
    const check = await row(second);
    const res = await t.commit(IDS.mara, sendMessage, {
      conversationId: mine.dmId,
      threadRootId: check.threadRootId,
      text: 'Stop checking for this',
    });
    const messageId = (res as { result: { id: string } }).result.id;
    const [turn] = await t.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.messageId, messageId), eq(dispatches.agentId, mine.agentId)));
    expect(turn).toBeDefined();
    const context = await buildDispatchContext(t.services, turn as NonNullable<typeof turn>);
    expect(context.ahead?.found).toMatchObject({ kind: 'time' });
    const mcp = await inTurn(turn?.id ?? '');
    const names = (await mcp.client.listTools()).tools.map((x) => x.name);
    expect(names).toContain('ahead_feedback');
    expect(names).not.toContain('ahead_report');
    const stopped = await mcp.client.callTool({
      name: 'ahead_feedback',
      arguments: { verdict: 'stop_kind' },
    });
    expect(stopped.structuredContent).toMatchObject({ status: 'ok', kind: 'time' });
    await mcp.close();
    expect((await aheadSettingsOf(t.services.db, TEST_BURROW_ID)).stopped).toEqual(['time']);
    expect((await row(second)).feedback).toBe('stop_kind');
    await t.services.db
      .update(dispatches)
      .set({ state: 'done' })
      .where(eq(dispatches.id, turn?.id ?? ''));
  });

  it('settles a quiet finding’s thread after its event, and the setting switches it off', async () => {
    // A finding the person didn't write in: its thread settles once the event passed.
    const check = await row(second);
    await t.services.db
      .delete(messages)
      .where(
        and(
          eq(messages.threadRootId, check.threadRootId),
          or(eq(messages.authorId, IDS.mara), eq(messages.authorId, mine.agentId)),
        ),
      );
    now = new Date('2026-12-15T02:00:00Z');
    await watchAhead(t.services, TEST_BURROW_ID, ready);
    const [root] = await t.services.db.select().from(messages).where(eq(messages.id, check.threadRootId));
    expect(root?.settledAt).not.toBeNull();
    expect((await row(second)).settledAt).not.toBeNull();

    // Off: nothing is checked.
    now = new Date('2026-12-14T15:00:00Z');
    await t.services.db.delete(aheadChecks).where(eq(aheadChecks.burrowId, TEST_BURROW_ID));
    const res = await t.commit(IDS.mara, (await import('./commands')).updateLooksAhead, { on: false });
    expect(res.status).toBe('ok');
    expect(await watchAhead(t.services, TEST_BURROW_ID, ready)).toBeNull();
    expect((await looksAheadView(t.services, TEST_BURROW_ID)).on).toBe(false);
  });
});
