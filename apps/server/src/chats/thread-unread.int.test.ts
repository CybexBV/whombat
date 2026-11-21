/**
 * Which threads of the person's Chat have something new (docs/decisions/thread-unread.md): the agent's reply makes a
 * thread new, reading it or writing in it clears it on every device, the agent's own first message is passed once the
 * room is read past it, and settled threads count for nothing. Needs Postgres: what is new is counted in SQL from the
 * thread markers, the room's marker and the messages.
 */
import type { RealtimeEvent } from '@whombat/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deleteMessage } from '../commands/message-edits';
import { sendMessage } from '../commands/messages';
import { dispatches, messages } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, app: true });
let mine: PersonalSetup;
let cookie: string;

beforeAll(async () => {
  mine = await addPersonalAgent(t.services, t.burrowId, IDS.mara, {
    name: 'Dusty',
    services: null,
    grants: [],
  });
  ({ cookie } = await sessionFor(t.services, IDS.mara));
});

/** Every turn ended: a thread the agent works on doesn't settle. */
async function finishTurns() {
  await t.services.db
    .update(dispatches)
    .set({ state: 'done', finishedAt: new Date() })
    .where(inArray(dispatches.state, ['queued', 'claimed', 'running']));
}

/** Each case starts with the threads of earlier cases settled, so only its own count. */
beforeEach(async () => {
  await t.services.background.settle();
  await finishTurns();
  await t.services.db
    .update(messages)
    .set({ settledAt: new Date(), settledHow: 'person', keptOpenAt: null })
    .where(
      and(
        eq(messages.conversationId, mine.dmId),
        sql`${messages.threadRootId} is null and ${messages.settledAt} is null`,
      ),
    );
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

async function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
  return t.api.inject({ method, url: `/api/v1/burrows/burrow-hq${url}`, headers: { cookie }, payload });
}

async function unread() {
  const res = await call('GET', '/chats/unread?room=chat');
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { conversationId: string | null; threads: { rootId: string; unread: number }[] };
}

async function badge() {
  const res = await call('GET', '/chats');
  expect(res.statusCode, res.body).toBe(200);
  const chats = (res.json() as { chats: { id: string; unread: number }[] }).chats;
  return chats.find((c) => c.id === mine.dmId)?.unread;
}

async function readThread(rootId: string, messageId: string) {
  const res = await call('POST', `/chats/threads/${rootId}/read`, { messageId });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { unread: number; roomUnread: number };
}

describe('threads with something new', () => {
  it('shows the agent’s replies as new until the thread is read, on every device', async () => {
    const root = await send(IDS.mara, 'Is pve-02 healthy?');
    expect((await unread()).threads).toEqual([]);
    await send(mine.agentId, 'Looking now.', root);
    const answer = await send(mine.agentId, 'Yes, all green.', root);

    expect(await unread()).toEqual({ conversationId: mine.dmId, threads: [{ rootId: root, unread: 2 }] });
    expect(await badge()).toBe(1);

    const frames: RealtimeEvent[] = [];
    const off = t.services.bus.onFrame((f) => {
      if (f.topic === `me:${IDS.mara}`) frames.push(f.event);
    });
    try {
      expect(await readThread(root, answer)).toMatchObject({ unread: 0, roomUnread: 0 });
      await t.services.background.settle();
    } finally {
      off();
    }
    // The person's other devices hear the room's badge drop.
    expect(frames).toContainEqual(
      expect.objectContaining({ type: 'conversation.unread', conversationId: mine.dmId, unread: 0 }),
    );
    expect((await unread()).threads).toEqual([]);
    // Reading never moves back.
    const first = await send(mine.agentId, 'One more thing.', root);
    await readThread(root, answer);
    expect((await unread()).threads).toEqual([{ rootId: root, unread: 1 }]);
    await readThread(root, first);
  });

  it('drops the room’s badge on every device when the only new reply is deleted', async () => {
    const root = await send(IDS.mara, 'Is the backup done?');
    const reply = await send(mine.agentId, 'Not yet.', root);
    expect(await badge()).toBe(1);
    const frames: RealtimeEvent[] = [];
    const off = t.services.bus.onFrame((f) => {
      if (f.topic === `me:${IDS.mara}`) frames.push(f.event);
    });
    try {
      const res = await t.commit(IDS.mara, deleteMessage, { messageId: reply });
      expect(res.status).toBe('ok');
      await t.services.background.settle();
    } finally {
      off();
    }
    expect(await badge()).toBe(0);
    expect(frames).toContainEqual(
      expect.objectContaining({ type: 'conversation.unread', conversationId: mine.dmId, unread: 0 }),
    );
  });

  it('counts a thread as read once the person writes in it', async () => {
    const root = await send(IDS.mara, 'Restart Plex?');
    await send(mine.agentId, 'Done, it is back.', root);
    expect((await unread()).threads).toHaveLength(1);
    await send(IDS.mara, 'Thanks!', root);
    expect((await unread()).threads).toEqual([]);
  });

  it('passes the agent’s own first message once the room is read past it', async () => {
    const post = await send(mine.agentId, 'Morning briefing: all quiet.');
    expect((await unread()).threads).toEqual([{ rootId: post, unread: 1 }]);
    const res = await call('POST', `/conversations/${mine.dmId}/read`, { messageId: post });
    expect(res.statusCode, res.body).toBe(200);
    expect((await unread()).threads).toEqual([]);
    // A reply under it is new again.
    await send(mine.agentId, 'Update: one backup is late.', post);
    expect((await unread()).threads).toEqual([{ rootId: post, unread: 1 }]);
  });

  it('leaves settled threads out, and settling by hand reads the thread', async () => {
    const root = await send(IDS.mara, 'Check the disks');
    await send(mine.agentId, 'All disks fine.', root);
    expect(await badge()).toBe(1);
    await finishTurns();
    const settled = await call('POST', '/chats/settle', { room: 'chat' });
    expect(settled.statusCode, settled.body).toBe(200);
    await t.services.background.settle();
    expect(await badge()).toBe(0);
    // Opened again by hand, nothing in it is new.
    const opened = await t.api.inject({
      method: 'PUT',
      url: `/api/v1/burrows/burrow-hq/chats/threads/${root}/settled`,
      headers: { cookie },
      payload: { settled: false },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    expect((await unread()).threads).toEqual([]);
  });

  it('refuses a message that isn’t in the named thread', async () => {
    const a = await send(IDS.mara, 'Thread A');
    const b = await send(IDS.mara, 'Thread B');
    const reply = await send(mine.agentId, 'In B', b);
    const res = await call('POST', `/chats/threads/${a}/read`, { messageId: reply });
    expect(res.statusCode).toBe(404);
  });
});

/** Chat as an inbox (docs/decisions/chat-inbox.md). */
describe('the inbox', () => {
  async function markUnread(rootId: string) {
    return call('POST', `/chats/threads/${rootId}/unread`);
  }

  it('marks a read thread unread again, its newest message from the agent new', async () => {
    const root = await send(IDS.mara, 'How full is the NAS?');
    await send(mine.agentId, 'Looking.', root);
    const answer = await send(mine.agentId, '71 % full.', root);
    await readThread(root, answer);
    expect(await badge()).toBe(0);

    const res = await markUnread(root);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ rootId: root, unread: 1, roomUnread: 1 });
    expect((await unread()).threads).toEqual([{ rootId: root, unread: 1 }]);
    // Reading it again moves forward as before.
    await readThread(root, answer);
    expect((await unread()).threads).toEqual([]);
  });

  it('leaves a thread with nothing from someone else as it is, and refuses a reply or another room', async () => {
    const root = await send(IDS.mara, 'Just a note to self');
    const res = await markUnread(root);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ unread: 0 });
    const reply = await send(mine.agentId, 'Noted.', root);
    expect((await markUnread(reply)).statusCode).toBe(404);
  });

  it('settles everything read, leaving what has something new', async () => {
    const read = await send(IDS.mara, 'Restart the router?');
    const done = await send(mine.agentId, 'Restarted.', read);
    await readThread(read, done);
    const fresh = await send(IDS.mara, 'Any updates?');
    await send(mine.agentId, 'Two, for pve-01.', fresh);
    await finishTurns();

    const res = await call('POST', '/chats/settle', { room: 'chat', onlyRead: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ settled: 1 });
    const open = await call('GET', '/chats/threads?room=chat&state=open');
    expect((open.json() as { threads: { rootId: string }[] }).threads.map((x) => x.rootId)).toEqual([fresh]);
  });

  it('lists each thread with its newest reply for the row’s second line', async () => {
    const root = await send(IDS.mara, 'Look at https://github.com/acme/shop/pull/412');
    const before = await call('GET', '/chats/threads?room=chat&state=open');
    const listed = (before.json() as { threads: { rootId: string; last?: unknown }[] }).threads;
    expect(listed.find((x) => x.rootId === root)?.last).toBeUndefined();
    await send(mine.agentId, 'Looks good.\nTwo small things.', root);
    const after = await call('GET', '/chats/threads?room=chat&state=open');
    const row = (
      after.json() as { threads: { rootId: string; last?: { authorId: string; text: string } }[] }
    ).threads.find((x) => x.rootId === root);
    // The row reads past a short first line.
    expect(row?.last).toMatchObject({ authorId: mine.agentId, text: 'Looks good. Two small things.' });
  });
});
