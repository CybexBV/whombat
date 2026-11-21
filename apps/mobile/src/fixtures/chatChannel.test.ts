/** Chat in the one-Whombat demo world (chat-channel.md AP-2460): its answers match the contracts, its writes change it. */
import { type AnyEndpoint, api, type ChatThread, type Message, type RealtimeEvent } from '@whombat/core';
import { at, mara } from '@whombat/fixtures';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { startedChatRoute } from '../data/chatRoom';
import { FIXTURE_ORIGIN } from '../data/config';
import { demoClient } from '../demo/session';
import { createClock } from '../lib/time';
import { ASSISTANT_ID, DEFAULT_CHAT_ID, HEAT_PROPOSAL } from './assistant';
import { CHAT_ROOTS, FEATURE_REQUEST_ID, FEEDBACK_ROOM_ID, ZFS_APPROVAL } from './chatChannel';
import { createFixtureServer } from './fixture-server';

const burrow = 'burrow-hq';

function setup(o: { tasks?: boolean; signIns?: boolean } = {}) {
  const timers: { fn: () => void; ms: number }[] = [];
  const now = createClock(new Date(at('14:05')), Date.now());
  const server = createFixtureServer({
    inner: createFixtureFetch(),
    now,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    assistant: true,
    chat: true,
    ...o,
  });
  const client = demoClient(server.fetch);
  const events: { topic: string; event: RealtimeEvent }[] = [];
  server.realtime.onEvent((event, frame) => events.push({ topic: frame.topic, event }));
  server.realtime.connect();
  const flush = () => {
    for (const t of timers.splice(0)) t.fn();
  };
  /** The raw answer, parsed with the endpoint's own response schema (strictly: what a newer app would choke on). */
  const raw = async (ep: AnyEndpoint, path: string, init?: RequestInit) => {
    const res = await server.fetch(`${FIXTURE_ORIGIN}/api/v1/burrows/${burrow}${path}`, init);
    const data = (await res.json()) as unknown;
    const parsed = ep.response.safeParse(data);
    if (!parsed.success) throw new Error(`${ep.id}: ${parsed.error.message}`);
    return { status: res.status, data };
  };
  return { client, events, flush, raw, server };
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('Chat in the demo world (AP-2460)', () => {
  it('answers every read with the contracts’ shapes', async () => {
    const s = setup();
    await s.raw(api.chats.list, '/chats');
    await s.raw(api.chats.threads, '/chats/threads');
    await s.raw(api.chats.threads, '/chats/threads?room=feedback');
    await s.raw(api.chats.threads, '/chats/threads?subjectKind=server&subjectId=pve-02&limit=1');
    await s.raw(api.conversations.get, `/conversations/${DEFAULT_CHAT_ID}`);
    await s.raw(api.conversations.get, `/conversations/${FEEDBACK_ROOM_ID}`);
    await s.raw(api.messages.list, `/conversations/${DEFAULT_CHAT_ID}/messages`);
    await s.raw(api.messages.list, `/conversations/${FEEDBACK_ROOM_ID}/messages`);
    await s.raw(api.messages.thread, `/messages/${CHAT_ROOTS.memory}/thread`);
    await s.raw(api.messages.thread, `/messages/${CHAT_ROOTS.feature}/thread`);
    await s.raw(api.approvals.get, `/approvals/${ZFS_APPROVAL}`);
  });

  it('has Mara’s Chat and Feedback room as her rooms with the agent in the sidebar (OA-04, AP-4964)', async () => {
    const s = setup();
    const b = await s.client.request(api.conversations.bootstrap, { params: { burrow } });
    if (b.status !== 'ok') throw new Error(b.status);
    expect(b.data.sidebar.dms.map((d) => [d.id, d.link])).toEqual([
      [DEFAULT_CHAT_ID, { type: 'dm' }],
      [FEEDBACK_ROOM_ID, { type: 'dm', room: 'feedback' }],
    ]);
  });

  it('lists Chat and Feedback after the fresh start, each thread once with its replies counted', async () => {
    const s = setup();
    const list = await s.client.request(api.chats.list, { params: { burrow } });
    if (list.status !== 'ok') throw new Error(list.status);
    // The badge counts threads with something new: the backup news, pve-02's ask, the plans page; the pricing report.
    expect(list.data.chats.map((c) => [c.id, c.room, c.default, c.unread])).toEqual([
      [DEFAULT_CHAT_ID, 'chat', true, 3],
      [FEEDBACK_ROOM_ID, 'feedback', false, 1],
    ]);
    const top = await s.client.request(api.messages.list, {
      params: { burrow, conversationId: DEFAULT_CHAT_ID },
      query: { limit: 50 },
    });
    if (top.status !== 'ok') throw new Error(top.status);
    // Only the threads' first messages, oldest first; replies are in their threads.
    expect(top.data.messages.map((m) => m.id)).toEqual([
      CHAT_ROOTS.synology,
      CHAT_ROOTS.redirect,
      CHAT_ROOTS.zonneplan,
      CHAT_ROOTS.nas,
      CHAT_ROOTS.backups,
      CHAT_ROOTS.feature,
      CHAT_ROOTS.plans,
      CHAT_ROOTS.shop,
      CHAT_ROOTS.heat,
      CHAT_ROOTS.memory,
      CHAT_ROOTS.firmware,
    ]);
    // The login Mara sent is blanked and says where it went (VS-07; AP-4039).
    expect(
      top.data.messages.find((m) => m.id === CHAT_ROOTS.shop)?.vaultSaved?.map((v) => v.entryId),
    ).toEqual(['vlt_shop']);
    const memory = top.data.messages.find((m) => m.id === CHAT_ROOTS.memory);
    expect(memory).toMatchObject({ replyCount: 3, subject: { kind: 'server', id: 'pve-02' } });
    expect(memory?.threadParticipantIds).toEqual([ASSISTANT_ID, mara.id]);
  });

  it('pages the threads by their last activity and filters them by subject (CT-443)', async () => {
    const s = setup();
    const first = await s.client.request(api.chats.threads, { params: { burrow }, query: { limit: 2 } });
    if (first.status !== 'ok') throw new Error(first.status);
    expect(first.data.threads.map((t) => t.rootId)).toEqual([CHAT_ROOTS.firmware, CHAT_ROOTS.memory]);
    expect(first.data.threads[0]?.working).toBe(true);
    expect(first.data.next).not.toBeNull();
    const next = await s.client.request(api.chats.threads, {
      params: { burrow },
      query: { limit: 2, before: first.data.next ?? undefined },
    });
    if (next.status !== 'ok') throw new Error(next.status);
    expect(next.data.threads.map((t) => t.rootId)).toEqual([CHAT_ROOTS.heat, CHAT_ROOTS.shop]);
    const about = await s.client.request(api.chats.threads, {
      params: { burrow },
      query: { subjectKind: 'server', subjectId: 'pve-02' },
    });
    if (about.status !== 'ok') throw new Error(about.status);
    expect(about.data.threads.map((t: ChatThread) => [t.rootId, t.replyCount])).toEqual([
      [CHAT_ROOTS.memory, 3],
    ]);
  });

  it('lists the open threads and the Settled shelf with its count (chat-settle.md CS-10, AP-6157)', async () => {
    const s = setup();
    const open = await s.raw(api.chats.threads, '/chats/threads?state=open');
    const openData = open.data as { threads: ChatThread[]; settledCount?: number };
    expect(openData.settledCount).toBe(4);
    expect(openData.threads.some((t) => t.settled)).toBe(false);
    // pve-02's yes, the heat pump's choice and the feature request wait for Mara; the firmware question is Neo's.
    const waiting = openData.threads.filter((t) => t.waiting).map((t) => t.rootId);
    expect(waiting).toEqual([CHAT_ROOTS.memory, CHAT_ROOTS.heat, CHAT_ROOTS.feature]);
    const shelf = await s.raw(api.chats.threads, '/chats/threads?state=settled&limit=3');
    const shelfData = shelf.data as { threads: ChatThread[]; next: string | null };
    expect(shelfData.threads.map((t) => [t.rootId, t.settled?.how])).toEqual([
      [CHAT_ROOTS.nas, 'person'],
      [CHAT_ROOTS.zonneplan, 'person'],
      [CHAT_ROOTS.redirect, 'merged'],
    ]);
    const older = await s.raw(
      api.chats.threads,
      `/chats/threads?state=settled&limit=3&before=${shelfData.next}`,
    );
    const olderData = older.data as { threads: ChatThread[]; settledCount?: number };
    expect(olderData.threads.map((t) => t.rootId)).toEqual([CHAT_ROOTS.synology]);
    expect(olderData.settledCount).toBeUndefined();
    // The room's first messages say so too, for the fold.
    const top = await s.raw(api.messages.list, `/conversations/${DEFAULT_CHAT_ID}/messages`);
    const settledRoots = (top.data as { messages: Message[] }).messages
      .filter((m) => m.settled)
      .map((m) => m.id);
    expect(settledRoots).toEqual([
      CHAT_ROOTS.synology,
      CHAT_ROOTS.redirect,
      CHAT_ROOTS.zonneplan,
      CHAT_ROOTS.nas,
    ]);
  });

  it('settles a thread and opens it again, refusing one Neo works on or one that waits (CS-03, CS-05)', async () => {
    const s = setup();
    const put = (rootId: string, settled: boolean) =>
      s.server.fetch(`${FIXTURE_ORIGIN}/api/v1/burrows/${burrow}/chats/threads/${rootId}/settled`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settled }),
      });
    const done = await s.raw(api.chats.settle, `/chats/threads/${CHAT_ROOTS.backups}/settled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settled: true }),
    });
    expect((done.data as { thread: ChatThread }).thread.settled?.how).toBe('person');
    expect(s.events.find((e) => e.event.type === 'chat.settled')).toMatchObject({
      topic: `me:${mara.id}`,
      event: { rootId: CHAT_ROOTS.backups, room: 'chat', settled: { how: 'person' } },
    });
    const busy = await put(CHAT_ROOTS.firmware, true);
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: { message: string } }).error.message).toContain('still working');
    const waits = await put(CHAT_ROOTS.memory, true);
    expect(((await waits.json()) as { error: { message: string } }).error.message).toContain('your answer');
    const back = await put(CHAT_ROOTS.backups, false);
    expect(((await back.json()) as { thread: ChatThread }).thread.settled).toBeNull();
  });

  it('opens a settled thread again when a message lands in it (CS-04)', async () => {
    const s = setup();
    await s.raw(
      api.messages.send,
      `/conversations/${DEFAULT_CHAT_ID}/messages`,
      post({ text: 'And the other NAS?', threadRootId: CHAT_ROOTS.nas }),
    );
    expect(s.events.find((e) => e.event.type === 'chat.settled')?.event).toMatchObject({
      rootId: CHAT_ROOTS.nas,
      settled: null,
    });
    const thread = await s.raw(api.messages.thread, `/messages/${CHAT_ROOTS.nas}/thread`);
    expect((thread.data as { root: Message }).root.settled).toBeNull();
  });

  it('settles every finished thread at once, with one frame for the room (CS-09)', async () => {
    const s = setup();
    const res = await s.raw(api.chats.settleFinished, '/chats/settle', post({ room: 'chat' }));
    // Backups, the plans page and the shop's login; not the firmware (Neo), pve-02, the heat pump or the feature
    // request (Mara's answer).
    expect((res.data as { settled: number }).settled).toBe(3);
    expect(s.events.filter((e) => e.event.type === 'chat.settled').map((e) => e.event)).toEqual([
      { type: 'chat.settled', conversationId: DEFAULT_CHAT_ID, room: 'chat', rootId: null, settled: null },
    ]);
  });

  it('settles only what Mara has read with Settle everything read (CIB-07)', async () => {
    const s = setup();
    const res = await s.raw(
      api.chats.settleFinished,
      '/chats/settle',
      post({ room: 'chat', onlyRead: true }),
    );
    // The shop's login only: the backup news and the plans page are still new to her.
    expect((res.data as { settled: number }).settled).toBe(1);
    const open = await s.raw(api.chats.threads, '/chats/threads?state=open');
    const ids = (open.data as { threads: ChatThread[] }).threads.map((t) => t.rootId);
    expect(ids).toContain(CHAT_ROOTS.backups);
    expect(ids).toContain(CHAT_ROOTS.plans);
    expect(ids).not.toContain(CHAT_ROOTS.shop);
  });

  it('lists what is new, reads a thread and marks it unread again (TU-04, CIB-06)', async () => {
    const s = setup();
    const unread = async () =>
      (
        (await s.raw(api.chats.unread, '/chats/unread?room=chat')).data as {
          threads: { rootId: string; unread: number }[];
        }
      ).threads;
    expect(await unread()).toEqual([
      { rootId: CHAT_ROOTS.memory, unread: 1 },
      { rootId: CHAT_ROOTS.plans, unread: 1 },
      { rootId: CHAT_ROOTS.backups, unread: 1 },
    ]);
    const thread = await s.raw(api.messages.thread, `/messages/${CHAT_ROOTS.plans}/thread`);
    const last = (thread.data as { replies: Message[] }).replies.at(-1)?.id;
    const read = await s.raw(
      api.chats.readThread,
      `/chats/threads/${CHAT_ROOTS.plans}/read`,
      post({ messageId: last }),
    );
    expect(read.data).toMatchObject({ rootId: CHAT_ROOTS.plans, unread: 0, roomUnread: 2 });
    expect(s.events.at(-1)?.event).toMatchObject({ type: 'conversation.unread', unread: 2 });
    const marked = await s.raw(api.chats.markUnread, `/chats/threads/${CHAT_ROOTS.plans}/unread`, post({}));
    expect(marked.data).toMatchObject({ rootId: CHAT_ROOTS.plans, unread: 1, roomUnread: 3 });
    // A thread with nothing from someone else stays as it is.
    const firmware = await s.raw(
      api.chats.markUnread,
      `/chats/threads/${CHAT_ROOTS.firmware}/unread`,
      post({}),
    );
    expect(firmware.data).toMatchObject({ unread: 0 });
  });

  it('gives each thread its newest reply for the inbox’s second line (CIB-03)', async () => {
    const s = setup();
    const open = await s.raw(api.chats.threads, '/chats/threads?state=open');
    const threads = (open.data as { threads: ChatThread[] }).threads;
    expect(threads.find((t) => t.rootId === CHAT_ROOTS.plans)?.last).toMatchObject({
      authorId: ASSISTANT_ID,
    });
    // Before the first reply there is none: the row says the first message's author instead.
    expect(threads.find((t) => t.rootId === CHAT_ROOTS.firmware)?.last).toBeUndefined();
  });

  it('keeps Profile’s CHAT switches (AP-6156)', async () => {
    const s = setup();
    const chat = { settleQuietDays: null, settleMerged: true };
    const saved = await s.client.request(api.me.updatePreferences, { body: { chat } });
    if (saved.status !== 'ok') throw new Error(saved.status);
    const read = await s.client.request(api.me.getPreferences, {});
    if (read.status !== 'ok') throw new Error(read.status);
    expect(read.data.chat).toEqual(chat);
  });

  it('starts a thread from the composer: Neo thinks in it, then answers there', async () => {
    const s = setup();
    const sent = await s.raw(
      api.messages.send,
      `/conversations/${DEFAULT_CHAT_ID}/messages`,
      post({ text: 'Is the NAS backed up?', clientId: 'cli_1' }),
    );
    const root = (sent.data as { message: Message }).message;
    expect(root).toMatchObject({ threadRootId: null, clientId: 'cli_1' });
    const typing = s.events.find((e) => e.event.type === 'typing')?.event;
    expect(typing).toMatchObject({ threadRootId: root.id, principalId: ASSISTANT_ID });
    s.flush();
    const created = s.events.filter((e) => e.event.type === 'message.created').map((e) => e.event);
    expect(created.at(-1)).toMatchObject({ message: { threadRootId: root.id, authorId: ASSISTANT_ID } });
    const updated = s.events.filter((e) => e.event.type === 'message.updated').map((e) => e.event);
    expect(updated.at(-1)).toMatchObject({
      type: 'message.updated',
      message: { id: root.id, replyCount: 1 },
    });
    // Neo's answer is new to Mara: her badge says so.
    expect(s.events.at(-1)?.event).toMatchObject({
      type: 'conversation.unread',
      conversationId: DEFAULT_CHAT_ID,
    });
  });

  it('starts a thread about a thing with chats.start, and the app opens it (CHT-06)', async () => {
    const s = setup();
    const started = await s.raw(
      api.chats.start,
      '/chats',
      post({ text: 'Why is blackbox slow?', subject: { kind: 'server', id: 'blackbox', name: 'blackbox' } }),
    );
    expect(started.status).toBe(201);
    const data = started.data as {
      conversation: { id: string; title: string; chat?: null };
      message: Message;
    };
    expect(data.conversation.id).toBe(DEFAULT_CHAT_ID);
    expect(data.message.subject).toMatchObject({ id: 'blackbox' });
    expect(startedChatRoute(data, 'Watch')).toEqual({
      name: 'Thread',
      params: { messageId: data.message.id, back: 'Watch' },
    });
  });

  it('decides the heat pump in its thread and caps the ZFS cache tonight', async () => {
    const s = setup();
    await s.raw(
      api.deviceSkills.decide,
      `/device-skills/${HEAT_PROPOSAL}/decide`,
      post({ actions: { room_setpoint: { tier: 'can' } }, switchOn: true }),
    );
    const updated = s.events.find(
      (e) => e.topic === `conv:${DEFAULT_CHAT_ID}` && e.event.type === 'message.updated',
    );
    expect(updated?.event).toMatchObject({
      message: { threadRootId: CHAT_ROOTS.heat, card: { status: 'on' } },
    });
    const decided = await s.raw(
      api.approvals.decide,
      `/approvals/${ZFS_APPROVAL}/decide`,
      post({ decision: 'approve', executeAt: at('03:00', 1) }),
    );
    expect(decided.data).toMatchObject({ approval: { state: 'approved', executeAt: at('03:00', 1) } });
  });

  it('puts a feature request to Mara on its card and decides it there, once', async () => {
    const s = setup();
    const thread = await s.raw(api.messages.thread, `/messages/${CHAT_ROOTS.feature}/thread`);
    const card = (thread.data as { replies: Message[] }).replies.at(-1)?.card;
    expect(card).toMatchObject({
      kind: 'feature_request',
      requestId: FEATURE_REQUEST_ID,
      request: { state: 'waiting', value: 7, canBuild: true, number: 21 },
    });
    // A question needs words.
    const empty = await s.server.fetch(
      `${FIXTURE_ORIGIN}/api/v1/burrows/${burrow}/trackers/feature-requests/${FEATURE_REQUEST_ID}/decide`,
      post({ choice: 'ask', note: ' ' }),
    );
    expect(empty.status).toBe(422);
    const decided = await s.raw(
      api.tracker.decide,
      `/trackers/feature-requests/${FEATURE_REQUEST_ID}/decide`,
      post({ choice: 'decline', note: 'Not this year.' }),
    );
    expect(decided.data).toMatchObject({
      request: { state: 'decided', choice: 'decline', note: 'Not this year.', decidedById: mara.id },
    });
    const updated = s.events.find(
      (e) => e.topic === `conv:${DEFAULT_CHAT_ID}` && e.event.type === 'message.updated',
    );
    expect(updated?.event).toMatchObject({
      message: { threadRootId: CHAT_ROOTS.feature, card: { request: { state: 'decided' } } },
    });
    // It no longer waits: the thread can settle, and a second answer is refused in plain words.
    const open = await s.raw(api.chats.threads, '/chats/threads?state=open');
    const waiting = (open.data as { threads: ChatThread[] }).threads.filter((t) => t.waiting);
    expect(waiting.map((t) => t.rootId)).not.toContain(CHAT_ROOTS.feature);
    const again = await s.server.fetch(
      `${FIXTURE_ORIGIN}/api/v1/burrows/${burrow}/trackers/feature-requests/${FEATURE_REQUEST_ID}/decide`,
      post({ choice: 'approve' }),
    );
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { message: string } }).error.message).toContain('isn’t waiting');
  });
});

describe('what answers in Chat, in the demo world (AP-2732)', () => {
  const put = (body: unknown): RequestInit => ({ ...post(body), method: 'PUT' });

  it('answers chats.runtime, Runs on and the threads’ replies with the contracts’ shapes', async () => {
    const s = setup();
    const plain = await s.raw(api.chats.runtime, '/chats/runtime');
    expect(plain.data).toMatchObject({ default: { provider: 'claude' } });
    expect((plain.data as { thread?: unknown }).thread).toBeUndefined();
    const memory = await s.raw(api.chats.runtime, `/chats/runtime?thread=${CHAT_ROOTS.memory}`);
    expect(memory.data).toMatchObject({ thread: { provider: 'codex', effort: 'high', fast: true } });
    await s.raw(api.host.agents, '/host/agents');
    const thread = await s.raw(api.messages.thread, `/messages/${CHAT_ROOTS.memory}/thread`);
    const replies = (thread.data as { replies: Message[] }).replies;
    expect(replies.map((m) => m.ranOn?.provider ?? null)).toEqual(['claude', null, 'codex']);
  });

  it('saves a thread’s choice, tells Mara’s devices, and the next reply runs on it', async () => {
    const s = setup();
    const saved = await s.raw(
      api.chats.setThreadRuntime,
      `/chats/threads/${CHAT_ROOTS.firmware}/runtime`,
      put({ runtime: { provider: 'codex', model: 'gpt-6-luna' } }),
    );
    expect(saved.data).toEqual({ thread: { provider: 'codex', model: 'gpt-6-luna' } });
    expect(s.events.at(-1)).toMatchObject({
      topic: `me:${mara.id}`,
      event: { type: 'chat.thread_runtime', rootId: CHAT_ROOTS.firmware },
    });
    // The same as Neo's own: stored as none.
    const back = await s.raw(
      api.chats.setThreadRuntime,
      `/chats/threads/${CHAT_ROOTS.firmware}/runtime`,
      put({ runtime: { provider: 'claude' } }),
    );
    expect(back.data).toEqual({ thread: null });
    // A new question with a choice: Neo's answer says what answered it.
    const sent = await s.raw(
      api.messages.send,
      `/conversations/${DEFAULT_CHAT_ID}/messages`,
      post({ text: 'Quick one', clientId: 'cli_2', runtime: { provider: 'codex', model: 'gpt-6-luna' } }),
    );
    const root = (sent.data as { message: Message }).message;
    s.flush();
    const answer = s.events
      .map((e) => e.event)
      .filter((e): e is Extract<RealtimeEvent, { type: 'message.created' }> => e.type === 'message.created')
      .at(-1);
    expect(answer?.message).toMatchObject({
      threadRootId: root.id,
      ranOn: { provider: 'codex', model: 'gpt-6-luna', fast: true },
    });
  });

  it('makes a choice Neo’s default', async () => {
    const s = setup();
    await s.client.request(api.agent.update, {
      params: { burrow },
      body: { runtime: { provider: 'codex', effort: 'high' } },
    });
    const view = await s.raw(api.chats.runtime, '/chats/runtime');
    expect(view.data).toMatchObject({ default: { provider: 'codex', effort: 'high' } });
  });
});

describe('tonight’s server work in the demo Chat (AP-4306)', () => {
  it('has a task card per job, and the running one ends on its message', async () => {
    const s = setup({ tasks: true });
    const thread = await s.raw(api.messages.thread, `/messages/${CHAT_ROOTS.tasks}/thread`);
    const cards = (thread.data as { replies: Message[] }).replies.flatMap((m) =>
      m.card?.kind === 'task' ? [m.card] : [],
    );
    expect(cards.map((c) => c.state)).toEqual(['ok', 'warning', 'error', 'running']);
    s.flush();
    const ended = s.events
      .map((e) => e.event)
      .filter((e): e is Extract<RealtimeEvent, { type: 'message.updated' }> => e.type === 'message.updated')
      .find((e) => e.message.card?.kind === 'task');
    expect(ended?.message.card).toMatchObject({ kind: 'task', state: 'ok', serverId: 'the-falcon' });
    const after = await s.raw(api.messages.thread, `/messages/${CHAT_ROOTS.tasks}/thread`);
    expect(
      (after.data as { replies: Message[] }).replies.flatMap((m) =>
        m.card?.kind === 'task' ? [m.card.state] : [],
      ),
    ).not.toContain('running');
  });

  it('has the sign-in cards when asked for: prod-1’s three ways and github.com’s code', async () => {
    const s = setup({ signIns: true });
    const prod = await s.raw(api.messages.thread, `/messages/${CHAT_ROOTS.prod1}/thread`);
    const [server] = (prod.data as { replies: Message[] }).replies.flatMap((m) =>
      m.card?.kind === 'guide' ? [m.card] : [],
    );
    expect(server?.vaultAsk?.kind).toBe('server');
    expect(server?.state).toBe('open');
    const code = await s.raw(api.messages.thread, `/messages/${CHAT_ROOTS.githubCode}/thread`);
    const cards = (code.data as { replies: Message[] }).replies.flatMap((m) =>
      m.card?.kind === 'guide' ? [m.card] : [],
    );
    expect(cards.map((c) => [c.vaultAsk?.kind, c.state])).toEqual([
      ['login', 'done'],
      ['code', 'open'],
    ]);
  });

  it('isn’t there unless asked for', async () => {
    const s = setup();
    const res = await s.raw(api.chats.threads, '/chats/threads');
    expect((res.data as { threads: ChatThread[] }).threads.map((t) => t.rootId)).not.toContain(
      CHAT_ROOTS.tasks,
    );
  });
});
