/**
 * Chat (docs/decisions/chat-channel.md CHT-01…CHT-07; one-agent.md OA-04): a person's Chat is their default DM with
 * the agent, threaded — a top-level message opens a thread the assistant answers in, a reply joins its thread's
 * turn, the opening turn sees the end of the last thread, the turn's topic says what the thread is about, and an ask of
 * the turn lands in its thread. `chats.start` starts a thread in Chat with its subject; `chats.list` lists Chat and the
 * Feedback room (task chats from before only with the archived ones); `chats.threads` pages a room's threads. Task
 * chats from before keep their rules (ONE-DW14…ONE-DW16): only the person renames or archives one, the assistant names
 * it once. Nothing makes new task chats (OA-S48): the tests make them as builds before Chat did.
 */
import { DispatchContext } from '@whombat/core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { requestApproval } from '../commands/approvals';
import { sendMessage } from '../commands/messages';
import {
  catalogConnections,
  conversations,
  deviceSkills,
  dispatches,
  events,
  messages,
} from '../db/schema/index';
import { linkOfConversation } from '../domain/links';
import { personalDmId } from '../domain/personal-dm';
import { registerSubjectResolver, type SubjectResolver, subjectResolverFor } from '../home/registry';
import { mcpToolList } from '../mcp/server';
import { buildDispatchContext } from '../runtime/context';
import { runInDispatchScope } from '../runtime/dispatch-scope';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { taskChatWith } from '../test/task-chats';
import { sessionFor } from '../test/tokens';
import { archiveChat, CHAT_TITLE_SET_TEXT, renameChat, setChatTitle, startChat } from './commands';
import { chatOf, listChats, listThreads } from './read';

const t = useTestServer({ seed: true, app: true });
let mine: PersonalSetup;
let serverResolver: SubjectResolver | null = null;

/** The servers these chats are about; there is no hosts service here (hosts.int.test.ts names real ones). */
const SERVERS: Record<string, string> = { srv_pve02: 'pve-02', srv_reuse: 'reuse-01' };

beforeAll(async () => {
  // No keys: asking for one (“Browse the web”) is an approval whose card shows where it lands.
  mine = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { services: null, grants: [] });
  serverResolver = subjectResolverFor('server');
  registerSubjectResolver('server', async (_ctx, id) => (SERVERS[id] ? { name: SERVERS[id] } : null));
  // Devices still being learned, which a chat may be about.
  const now = new Date();
  const device = (id: string, name: string) => ({
    id,
    burrowId: t.burrowId,
    personId: IDS.mara,
    name,
    profile: { name } as never,
    profileHash: `chats-${id}`,
    host: '192.168.1.41',
    port: 502,
    tested: [],
    testedAt: now,
    status: 'proposed' as const,
    createdAt: now,
    updatedAt: now,
  });
  await t.services.db.insert(deviceSkills).values([device('dev_1', 'Porch'), device('dev_2', 'Garage')]);
});

afterAll(() => {
  if (serverResolver) registerSubjectResolver('server', serverResolver);
});

/** Every turn ends before the next case: each case reads only the turns it queued. */
beforeEach(async () => {
  await t.services.db
    .update(dispatches)
    .set({ state: 'cancelled', finishedAt: new Date() })
    .where(inArray(dispatches.state, ['queued', 'claimed', 'running']));
});

async function start(
  text: string,
  subject?: { kind: 'server' | 'connection' | 'device'; id: string; name: string },
) {
  const res = await t.commit(IDS.mara, startChat, { text, ...(subject ? { subject } : {}) });
  if (res.status !== 'ok') throw new Error(res.status);
  return res.result;
}

async function send(authorId: string, text: string, extra: Record<string, unknown> = {}) {
  const res = await t.commit(authorId, sendMessage, { conversationId: mine.dmId, text, ...extra });
  if (res.status !== 'ok') throw new Error(`send: ${res.status}`);
  return res.result.id as string;
}

async function row(id: string) {
  const [r] = await t.services.db.select().from(conversations).where(eq(conversations.id, id));
  if (!r) throw new Error('no chat');
  return r;
}

async function message(id: string) {
  const [m] = await t.services.db.select().from(messages).where(eq(messages.id, id));
  if (!m) throw new Error('no message');
  return m;
}

/** The turns a message queued: agent, trigger and thread. */
async function turnsOf(messageId: string) {
  return t.services.db
    .select({
      id: dispatches.id,
      agentId: dispatches.agentId,
      trigger: dispatches.trigger,
      threadRootId: dispatches.threadRootId,
    })
    .from(dispatches)
    .where(eq(dispatches.messageId, messageId));
}

/** A task chat as builds before Chat made it, with Mara's first message. */
const legacyChat = (text: string) => taskChatWith(t.services, t.burrowId, mine.agentId, IDS.mara, text);

describe('a thread in Chat (CHT-02, CHT-06)', () => {
  it('starts with chats.start: a top-level message in the person’s Chat with its subject, answered in its thread', async () => {
    const before = await t.services.db.select({ id: conversations.id }).from(conversations);
    const { conversationId, messageId } = await start('Why is pve-02 so hot today?\nIt was fine.', {
      kind: 'server',
      id: 'srv_pve02',
      name: 'pve-02',
    });
    expect(conversationId).toBe(mine.dmId);
    // No new conversation, no `chat.started`: it is a message.
    expect(await t.services.db.select({ id: conversations.id }).from(conversations)).toHaveLength(
      before.length,
    );
    const root = await message(messageId);
    expect(root).toMatchObject({
      authorId: IDS.mara,
      threadRootId: null,
      subjectKind: 'server',
      subjectId: 'srv_pve02',
      subjectName: 'pve-02',
    });
    const [posted] = await t.services.db
      .select({ type: events.type })
      .from(events)
      .orderBy(desc(events.seq))
      .limit(1);
    expect(posted?.type).not.toBe('chat.started');
    expect(await turnsOf(messageId)).toEqual([
      expect.objectContaining({ agentId: mine.agentId, trigger: 'dm', threadRootId: messageId }),
    ]);
  });

  it('asked to reuse it, asks in the thing’s newest thread, opening it again; with none it starts one (NYL-06)', async () => {
    const subject = { kind: 'server' as const, id: 'srv_reuse', name: 'reuse-01' };
    const ask = async (text: string) => {
      const res = await t.commit(IDS.mara, startChat, { text, subject, reuseThread: true });
      if (res.status !== 'ok') throw new Error(res.status);
      return res.result;
    };
    const first = await ask('reuse-01 isn’t answering\nCan you look into it?');
    expect(await message(first.messageId)).toMatchObject({ threadRootId: null, subjectId: 'srv_reuse' });
    await t.services.db
      .update(messages)
      .set({ settledAt: new Date(), settledHow: 'resolved' })
      .where(eq(messages.id, first.messageId));
    // Its first turn is over: the question wakes a turn of its own.
    await t.services.db
      .update(dispatches)
      .set({ state: 'cancelled', finishedAt: new Date() })
      .where(inArray(dispatches.state, ['queued', 'claimed', 'running']));
    const again = await ask('reuse-01 isn’t answering\nCan you look into it?');
    expect(again.messageId).not.toBe(first.messageId);
    expect(await message(again.messageId)).toMatchObject({
      threadRootId: first.messageId,
      authorId: IDS.mara,
    });
    // The reply opens the settled thread again and wakes the assistant there.
    expect((await message(first.messageId)).settledAt).toBeNull();
    expect(await turnsOf(again.messageId)).toEqual([
      expect.objectContaining({ agentId: mine.agentId, threadRootId: first.messageId }),
    ]);
    // Without it, a new thread as before.
    const fresh = await start('Another question about reuse-01', subject);
    expect((await message(fresh.messageId)).threadRootId).toBeNull();
  });

  it('a connection subject is checked and named by the connection; an unknown one is refused', async () => {
    const [shared] = await t.services.db
      .insert(catalogConnections)
      .values({
        id: 'con_ha_test',
        catalogId: 'home_assistant',
        burrowId: t.burrowId,
        label: 'Home Assistant · home.lan',
        handle: 'home-assistant',
        transport: 'mcp',
        signIn: 'token',
        baseUrl: 'http://home.lan:8123',
      })
      .returning();
    const { messageId } = await start('Are the lights off?', {
      kind: 'connection',
      id: shared?.id as string,
      name: 'something else',
    });
    expect((await message(messageId)).subjectName).toBe('Home Assistant · home.lan');
    await expect(start('Hi', { kind: 'connection', id: 'con_nope', name: 'Nope' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('a device subject is named by the burrow’s device; an unknown server or device is refused', async () => {
    const { messageId } = await start('Is the garage door shut?', {
      kind: 'device',
      id: 'dev_2',
      name: 'Made up',
    });
    expect((await message(messageId)).subjectName).toBe('Garage');
    await expect(start('Hi', { kind: 'device', id: 'dev_nope', name: 'Nope' })).rejects.toMatchObject({
      code: 'not_found',
      message: 'Device not found.',
    });
    await expect(start('Hi', { kind: 'server', id: 'srv_nope', name: 'Nope' })).rejects.toMatchObject({
      code: 'not_found',
      message: 'Server not found.',
    });
  });

  it('gives each top-level message its own turn; a reply joins its thread’s turn; the assistant’s own post stays at the top', async () => {
    const first = await send(IDS.mara, 'Restart the nas tonight');
    const second = await send(IDS.mara, 'And check the UPS');
    await send(IDS.mara, 'After 23:00 please', { threadRootId: first });
    const queued = await t.services.db
      .select({ threadRootId: dispatches.threadRootId })
      .from(dispatches)
      .where(and(eq(dispatches.agentId, mine.agentId), eq(dispatches.state, 'queued')));
    expect(queued.map((d) => d.threadRootId).sort()).toEqual([first, second].sort());
    // The assistant's post that answers nothing (a scheduled check, an automation's result) starts its own thread; a reply under
    // it wakes the assistant there.
    const own = await t.commit(mine.agentId, sendMessage, {
      conversationId: mine.dmId,
      text: 'Your morning.',
    });
    if (own.status !== 'ok') throw new Error(own.status);
    expect((await message(own.result.id)).threadRootId).toBeNull();
    expect(await turnsOf(own.result.id)).toEqual([]);
    const reply = await send(IDS.mara, 'Thanks, anything about mail?', { threadRootId: own.result.id });
    expect(await turnsOf(reply)).toEqual([expect.objectContaining({ threadRootId: own.result.id })]);
  });

  it('a new thread starts fresh, without the last thread; its topic says whose room it is and what the thread is about', async () => {
    const ask = await send(IDS.mara, 'Is the backup done?');
    const answer = await t.commit(mine.agentId, sendMessage, {
      conversationId: mine.dmId,
      text: 'Yes, it finished at 03:12.',
      threadRootId: ask,
    });
    if (answer.status !== 'ok') throw new Error(answer.status);
    const { messageId } = await start('Try again on pve-02', {
      kind: 'server',
      id: 'srv_pve02',
      name: 'pve-02',
    });
    const [turn] = await turnsOf(messageId);
    const [dispatch] = await t.services.db
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, turn?.id ?? ''));
    if (!dispatch) throw new Error('no turn');
    const ctx = DispatchContext.parse(await buildDispatchContext(t.services, dispatch));
    expect(ctx.thread?.root.id).toBe(messageId);
    expect(ctx.thread?.root.subject).toEqual({ kind: 'server', id: 'srv_pve02', name: 'pve-02' });
    // Nothing of the room comes along, not the last thread's answer nor the earlier question.
    expect(ctx.window).toEqual([]);
    expect(ctx.thread?.replies).toEqual([]);
    expect(ctx.conversation.topic).toContain('Mara');
    expect(ctx.conversation.topic).toContain('This thread is about the server pve-02.');
    // An ask of that turn lands in its thread (RC-14, CA-01): the card is in Mara's Chat, under her message.
    const asked = await runInDispatchScope(
      { dispatchId: dispatch.id, agentId: mine.agentId, onBehalfOfAccountId: dispatch.onBehalfOfAccountId },
      () =>
        t.commit(mine.agentId, requestApproval, {
          conversationId: mine.dmId,
          action: { type: 'grant_key', params: { keyId: 'web.browse' } },
          title: 'Browse the web',
          question: 'May I look it up?',
          whatHappens: ['Dusty may browse the web.'],
          explainer: 'To read the docs.',
          summary: 'Browse the web',
        }),
    );
    if (asked.status !== 'ok') throw new Error(asked.status);
    const card = await message((asked.result as { messageId: string }).messageId);
    expect(card).toMatchObject({ conversationId: mine.dmId, threadRootId: messageId });
  });

  it('the assistant isn’t served set_chat_title: threads have no titles (CHT-S)', async () => {
    expect((await mcpToolList(t.services, mine.agentId)).map((tool) => tool.name)).not.toContain(
      'set_chat_title',
    );
  });
});

describe('Chat’s rooms and threads (CHT-07)', () => {
  it('lists Chat and, once it exists, Feedback; task chats from before only with the archived ones', async () => {
    const legacy = await legacyChat('An old task');
    const rooms = await listChats(t.services.db, { id: IDS.mara, burrowId: t.burrowId }, { rooms: true });
    expect(rooms.map((c) => c.id)).toEqual([mine.dmId]);
    expect(rooms[0]).toMatchObject({ default: true, room: 'chat' });
    expect((await t.commit(IDS.mara, archiveChat, { conversationId: legacy })).status).toBe('ok');
    const all = await listChats(
      t.services.db,
      { id: IDS.mara, burrowId: t.burrowId },
      { rooms: true, archived: true },
    );
    expect(all.find((c) => c.id === legacy)).toMatchObject({ room: 'task', default: false });
  });

  it('pages a room’s threads, newest activity first, about one thing, with whether the assistant works on one', async () => {
    const page = await listThreads(t.services.db, { id: IDS.mara, burrowId: t.burrowId }, { limit: 2 });
    expect(page.threads).toHaveLength(2);
    expect(page.next).not.toBeNull();
    const lastAts = page.threads.map((th) => th.lastAt);
    expect([...lastAts].sort().reverse()).toEqual(lastAts);
    const rest = await listThreads(
      t.services.db,
      { id: IDS.mara, burrowId: t.burrowId },
      { before: page.next as string, limit: 50 },
    );
    expect(rest.next).toBeNull();
    const ids = [...page.threads, ...rest.threads].map((th) => th.rootId);
    expect(new Set(ids).size).toBe(ids.length);
    const about = await listThreads(
      t.services.db,
      { id: IDS.mara, burrowId: t.burrowId },
      { subject: { kind: 'server', id: 'srv_pve02' } },
    );
    expect(about.threads.map((th) => th.text).sort()).toEqual(
      ['Try again on pve-02', 'Why is pve-02 so hot today?'].sort(),
    );
    expect(about.threads[0]).toMatchObject({
      conversationId: mine.dmId,
      room: 'chat',
      authorId: IDS.mara,
      subject: { kind: 'server', id: 'srv_pve02', name: 'pve-02' },
    });
    const { messageId } = await start('Is the heat pump on?');
    const [top] = (await listThreads(t.services.db, { id: IDS.mara, burrowId: t.burrowId })).threads;
    expect(top).toMatchObject({ rootId: messageId, working: true, replyCount: 0 });
    // No Feedback room yet: nothing in it, nothing settled.
    expect(
      await listThreads(t.services.db, { id: IDS.mara, burrowId: t.burrowId }, { room: 'feedback' }),
    ).toEqual({ threads: [], next: null, settledCount: 0 });
  });

  it('REST: start answers the Chat and the thread’s first message; threads and list are the caller’s', async () => {
    const { cookie } = await sessionFor(t.services, IDS.mara);
    const res = await t.api.inject({
      method: 'POST',
      url: '/api/v1/burrows/burrow-hq/chats',
      headers: { cookie },
      payload: {
        text: 'Turn off the porch light at 23:00',
        subject: { kind: 'device', id: 'dev_1', name: 'Porch' },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.conversation.id).toBe(mine.dmId);
    expect(body.conversation.chat).toBeUndefined();
    expect(body.message).toMatchObject({
      text: 'Turn off the porch light at 23:00',
      threadRootId: null,
      subject: { kind: 'device', id: 'dev_1', name: 'Porch' },
    });
    const threads = await t.api.inject({
      method: 'GET',
      url: '/api/v1/burrows/burrow-hq/chats/threads?subjectKind=device&subjectId=dev_1',
      headers: { cookie },
    });
    expect(threads.statusCode, threads.body).toBe(200);
    expect(threads.json().threads.map((th: { rootId: string }) => th.rootId)).toEqual([body.message.id]);
    const list = await t.api.inject({
      method: 'GET',
      url: '/api/v1/burrows/burrow-hq/chats',
      headers: { cookie },
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().chats.map((c: { room: string }) => c.room)).toEqual(['chat']);
  });
});

describe('task chats from before Chat (ONE-DW14…ONE-DW16)', () => {
  it('the assistant improves the title once; a person’s own name for it settles it', async () => {
    const conversationId = await legacyChat('hey can you look at the nas, something with disks maybe');
    const better = await t.commit(mine.agentId, setChatTitle, { conversationId, title: 'NAS disk check' });
    expect(better.status).toBe('ok');
    expect((await row(conversationId)).chatTitle).toBe('NAS disk check');
    await expect(
      t.commit(mine.agentId, setChatTitle, { conversationId, title: 'Again' }),
    ).rejects.toMatchObject({ code: 'conflict', message: CHAT_TITLE_SET_TEXT });
    const other = await legacyChat('Second one');
    expect((await t.commit(IDS.mara, renameChat, { conversationId: other, title: 'Mine' })).status).toBe(
      'ok',
    );
    await expect(
      t.commit(mine.agentId, setChatTitle, { conversationId: other, title: 'Whombat’s' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // Whombat can't name its person's Chat.
    await expect(
      t.commit(mine.agentId, setChatTitle, { conversationId: mine.dmId, title: 'x' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('only the person renames or archives one; Chat is neither; links open the task chat', async () => {
    const conversationId = await legacyChat('Archive me');
    await expect(t.commit(IDS.mara, archiveChat, { conversationId: mine.dmId })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await t.commit(IDS.mara, archiveChat, { conversationId })).status).toBe('ok');
    expect(chatOf(await row(conversationId))?.archivedAt).toBeDefined();
    expect(await linkOfConversation(t.services.db, await row(conversationId))).toEqual({
      type: 'chat',
      id: conversationId,
    });
    expect((await linkOfConversation(t.services.db, await row(mine.dmId))).type).toBe('dm');
    // The default DM is still the one approvals and Vault asks use.
    expect(await personalDmId(t.services.db, mine.agentId, IDS.mara)).toBe(mine.dmId);
  });

  it('a person’s top-level message in a task chat stays flat', async () => {
    const conversationId = await legacyChat('Flat one');
    const res = await t.commit(IDS.mara, sendMessage, { conversationId, text: 'More here' });
    if (res.status !== 'ok') throw new Error(res.status);
    // It joins the turn its first message queued: one turn, at the top level.
    const turns = await t.services.db
      .select({ threadRootId: dispatches.threadRootId })
      .from(dispatches)
      .where(and(eq(dispatches.conversationId, conversationId), eq(dispatches.state, 'queued')));
    expect(turns).toEqual([{ threadRootId: null }]);
  });
});
