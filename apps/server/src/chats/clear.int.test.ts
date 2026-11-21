/**
 * Clearing Chat (docs/decisions/chat-clear.md CHC-01…CHC-07): the room's top-level messages leave its timeline and its
 * assistant's window, its badge clears, and every thread stays readable and listed. Needs Postgres: the read mark, the
 * filtered timeline and the turn's window are queries over real rows (docs/decisions/test-speed.md).
 */
import { DispatchContext } from '@whombat/core';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { conversations, dispatches, events, messages, readStates } from '../db/schema/index';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { sessionFor } from '../test/tokens';
import { CHAT_CLEARED_EVENT, clearChat } from './clear';
import { listThreads } from './read';

const t = useTestServer({ seed: true, app: true });
let mine: PersonalSetup;

beforeAll(async () => {
  mine = await addPersonalAgent(t.services, t.burrowId, IDS.mara, {
    name: 'Dusty',
    services: null,
    grants: [],
  });
});

async function send(authorId: string, text: string, threadRootId?: string) {
  const res = await t.commit(authorId, sendMessage, {
    conversationId: mine.dmId,
    text,
    ...(threadRootId ? { threadRootId } : {}),
  });
  if (res.status !== 'ok') throw new Error(`send: ${res.status}`);
  return res.result.id as string;
}

async function timeline(cookie: string): Promise<string[]> {
  const res = await t.api.inject({
    method: 'GET',
    url: `/api/v1/burrows/burrow-hq/conversations/${mine.dmId}/messages`,
    headers: { cookie },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().messages.map((m: { id: string }) => m.id);
}

async function clear(cookie: string, room?: 'chat' | 'feedback') {
  return t.api.inject({
    method: 'POST',
    url: '/api/v1/burrows/burrow-hq/chats/clear',
    headers: { cookie },
    payload: room ? { room } : {},
  });
}

describe('clearing Chat (CHC-01…CHC-06)', () => {
  it('empties the room’s timeline and badge, keeps every thread, and the assistant starts fresh', async () => {
    const { cookie } = await sessionFor(t.services, IDS.mara);
    const first = await send(IDS.mara, 'Is pve-02 hot?');
    const reply = await send(mine.agentId, 'It runs at 71 °C, a bit warm.', first);
    const second = await send(mine.agentId, 'Your backup finished.');
    const shown = await t.services.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, mine.dmId), isNull(messages.threadRootId)));
    expect(await timeline(cookie)).toEqual(expect.arrayContaining([first, second]));

    const res = await clear(cookie);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ room: 'chat', conversationId: mine.dmId, cleared: shown.length });
    const [room] = await t.services.db.select().from(conversations).where(eq(conversations.id, mine.dmId));
    expect(room?.roomClearedAt?.toISOString()).toBe(body.clearedAt);

    // Nothing is removed: the timeline is empty, the thread still opens and is still listed (CHC-01).
    expect(await timeline(cookie)).toEqual([]);
    const thread = await t.api.inject({
      method: 'GET',
      url: `/api/v1/burrows/burrow-hq/messages/${first}/thread`,
      headers: { cookie },
    });
    expect(thread.statusCode, thread.body).toBe(200);
    expect(thread.json().replies.map((m: { id: string }) => m.id)).toContain(reply);
    const listed = await listThreads(
      t.services.db,
      { id: IDS.mara, burrowId: t.burrowId },
      { room: 'chat', limit: 50 },
    );
    expect(listed.threads.map((th) => th.rootId)).toEqual(expect.arrayContaining([first, second]));
    // Chat is an inbox: what could settle did, so it leaves the open list (chat-inbox.md CIB-13).
    const open = await listThreads(
      t.services.db,
      { id: IDS.mara, burrowId: t.burrowId },
      { room: 'chat', state: 'open', limit: 50 },
    );
    expect(open.threads.map((th) => th.rootId)).not.toContain(second);

    // Read up to the newest top-level message (CHC-05).
    const [read] = await t.services.db
      .select({ id: readStates.lastReadMessageId })
      .from(readStates)
      .where(and(eq(readStates.conversationId, mine.dmId), eq(readStates.principalId, IDS.mara)));
    expect(read?.id).toBe(second);

    // One signed event with ids and counts, never words (CHC-06).
    const [event] = await t.services.db
      .select({ type: events.type, payload: events.payload })
      .from(events)
      .orderBy(desc(events.seq))
      .limit(1);
    expect(event).toMatchObject({
      type: CHAT_CLEARED_EVENT,
      payload: { conversationId: mine.dmId, room: 'chat' },
    });
    expect(JSON.stringify(event?.payload)).not.toContain('pve-02');

    // What comes after shows, and the next question's turn doesn't see what was cleared (CHC-03).
    const next = await send(IDS.mara, 'And now?');
    expect(await timeline(cookie)).toEqual([next]);
    const [turn] = await t.services.db
      .select()
      .from(dispatches)
      .where(eq(dispatches.messageId, next))
      .orderBy(desc(dispatches.createdAt))
      .limit(1);
    if (!turn) throw new Error('no turn');
    const ctx = DispatchContext.parse(await buildDispatchContext(t.services, turn));
    const seen = [...ctx.window, ...(ctx.thread?.replies ?? [])].map((m) => m.id);
    expect(seen).not.toContain(first);
    expect(seen).not.toContain(reply);
    expect(seen).not.toContain(second);
  });

  it('answers 0 for a room with nothing to clear, without signing anything', async () => {
    const { cookie } = await sessionFor(t.services, IDS.mara);
    expect((await clear(cookie)).statusCode).toBe(200);
    const [before] = await t.services.db
      .select({ seq: events.seq })
      .from(events)
      .orderBy(desc(events.seq))
      .limit(1);
    const again = await clear(cookie);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().cleared).toBe(0);
    const [after] = await t.services.db
      .select({ seq: events.seq })
      .from(events)
      .orderBy(desc(events.seq))
      .limit(1);
    expect(after?.seq).toBe(before?.seq);
  });

  it('is the person’s own: agents can’t clear, and a Feedback room that doesn’t exist isn’t found', async () => {
    await expect(t.commit(mine.agentId, clearChat, { room: 'chat' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    const { cookie } = await sessionFor(t.services, IDS.mara);
    expect((await clear(cookie, 'feedback')).statusCode).toBe(404);
  });
});
