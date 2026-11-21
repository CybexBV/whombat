import { type InfiniteData, QueryClient } from '@tanstack/query-core';
import { api, type ChatSummary, type ChatThread, type ChatThreadsResponse } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { applyRealtimeEvent, upsertMessageEverywhere } from '../query/apply';
import { infiniteEndpointKey, queryKeys } from '../query/keys';
import { message, t } from '../test/fixtures';
import {
  CHAT_SHELL_PATHS,
  CHAT_WORDS,
  chatRedirectPath,
  chatRoomsOf,
  parseChatShellLink,
  roomOfConversation,
  startedChatPath,
} from './rooms';
import {
  newestThreadAbout,
  threadPagesWithMessage,
  threadPagesWithout,
  threadRows,
  threadTitle,
} from './threads';

const TZ = 'Europe/Amsterdam';

const summary = (id: string, o: Partial<ChatSummary> = {}): ChatSummary => ({
  id: id as never,
  title: id,
  lastAt: t(0),
  unread: 0,
  default: false,
  ...o,
});

const thread = (rootId: string, o: Partial<ChatThread> = {}): ChatThread => ({
  conversationId: 'cnv_chat' as never,
  room: 'chat',
  rootId: rootId as never,
  authorId: 'prn_mara' as never,
  text: `About ${rootId}`,
  subject: null,
  createdAt: t(0),
  replyCount: 0,
  lastAt: t(0),
  working: false,
  ...o,
});

describe('the rooms (app chat-channel.md AP-2400)', () => {
  it('finds the Chat and the Feedback room by their room, an older default chat as the Chat', () => {
    const rooms = chatRoomsOf([
      summary('cnv_task', { room: 'task' }),
      summary('cnv_fb', { room: 'feedback', unread: 2 }),
      summary('cnv_chat', { room: 'chat', default: true, unread: 1 }),
    ]);
    expect([rooms.chat?.id, rooms.chat?.unread, rooms.feedback?.id, rooms.feedback?.unread]).toEqual([
      'cnv_chat',
      1,
      'cnv_fb',
      2,
    ]);
    expect(chatRoomsOf([summary('cnv_dm', { default: true })]).chat?.id).toBe('cnv_dm');
    expect(chatRoomsOf([summary('cnv_fb', { room: 'feedback', archivedAt: t(1) })]).feedback).toBeNull();
    expect(roomOfConversation(rooms, 'cnv_fb')).toBe('feedback');
    expect(roomOfConversation(rooms, 'cnv_task')).toBeNull();
  });

  it('opens a started chat as its thread beside Chat', () => {
    const started = { conversation: { id: 'cnv_chat' }, message: { id: 'msg_root', threadRootId: null } };
    expect(startedChatPath(started)).toBe('/chat?thread=msg_root');
  });

  it('sends old chat addresses to the room they are now', () => {
    const rooms = chatRoomsOf([
      summary('cnv_fb', { room: 'feedback' }),
      summary('cnv_chat', { default: true }),
    ]);
    expect(chatRedirectPath(rooms, 'cnv_fb')).toBe('/feedback');
    expect(chatRedirectPath(rooms, 'cnv_old')).toBe('/chat');
    expect(chatRedirectPath(rooms, null)).toBe('/chat');
    expect(chatRedirectPath(rooms, 'cnv_fb', 'msg_r')).toBe('/feedback?thread=msg_r');
  });

  it('reads the Chat shell’s links', () => {
    expect(parseChatShellLink('/chat?thread=msg_a')).toEqual({
      place: 'room',
      room: 'chat',
      thread: 'msg_a',
    });
    expect(parseChatShellLink('/feedback')).toEqual({ place: 'room', room: 'feedback', thread: null });
    expect(parseChatShellLink('/connections?x=1')).toEqual({ place: 'dashboard' });
    // The Dashboard's address in older messages opens Connections (AP-2501).
    expect(parseChatShellLink('/dashboard/')).toEqual({ place: 'dashboard' });
    expect(CHAT_SHELL_PATHS.dashboard).toBe('/connections');
    expect(CHAT_WORDS.dashboard).toBe('Overview');
    expect(parseChatShellLink('/chats/cnv_a')).toBeNull();
  });
});

describe('the Threads list (AP-2407)', () => {
  it('says replies and the last one, or when it was asked', () => {
    const now = Date.parse(t(30));
    const [replied, fresh] = threadRows(
      [
        thread('msg_a', { replyCount: 4, lastAt: t(28), text: '**Why** is pve-02 warm?\nmore' }),
        thread('msg_b', { createdAt: t(25), lastAt: t(25), working: true }),
      ],
      now,
      TZ,
    );
    expect([replied?.href, replied?.text, replied?.replies]).toEqual([
      '/chat?thread=msg_a',
      'Why is pve-02 warm?',
      '4 replies',
    ]);
    expect(replied?.when).toMatch(/^Last reply/);
    expect([fresh?.replies, fresh?.when, fresh?.working]).toEqual([null, '11:25', true]);
    expect(threadTitle('\n# Title\nrest')).toBe('Title');
  });

  it('finds the newest thread about a thing', () => {
    const list = [
      thread('msg_a'),
      thread('msg_b', { subject: { kind: 'server', id: 'pve-02', name: 'pve-02' } }),
    ];
    expect(newestThreadAbout(list, { kind: 'server', id: 'pve-02' })?.rootId).toBe('msg_b');
    expect(newestThreadAbout(list, { kind: 'device', id: 'x' })).toBeNull();
  });
});

describe('a new message in a Threads list (AP-2408)', () => {
  const scope = { room: 'chat' as const };

  it('starts a thread at the top for a new top-level message of the room, about the list’s subject only', () => {
    const pages = [[thread('msg_a')]];
    const m = message('msg_new', { conversationId: 'cnv_chat' as never, text: 'Firmware?', createdAt: t(5) });
    expect(threadPagesWithMessage(pages, m, scope, 'chat')?.[0]?.map((x) => x.rootId)).toEqual([
      'msg_new',
      'msg_a',
    ]);
    expect(threadPagesWithMessage(pages, m, scope, 'feedback')).toBe(pages);
    const about = { ...scope, subjectKind: 'server', subjectId: 'pve-02' };
    expect(threadPagesWithMessage(pages, m, about, 'chat')).toBe(pages);
    const onPve = { ...m, subject: { kind: 'server' as const, id: 'pve-02', name: 'pve-02' } };
    expect(threadPagesWithMessage(pages, onPve, about, 'chat')?.[0]?.[0]?.subject?.id).toBe('pve-02');
  });

  it('moves a replied thread to the top once, and an agent’s reply ends its work', () => {
    const pages = [[thread('msg_a')], [thread('msg_b', { working: true })]];
    const reply = message('msg_r', {
      conversationId: 'cnv_chat' as never,
      threadRootId: 'msg_b' as never,
      authorId: 'prn_neo' as never,
      createdAt: t(3),
    });
    const next = threadPagesWithMessage(pages, reply, scope, 'chat', (id) => id === 'prn_neo');
    expect(next?.map((p) => p.map((x) => [x.rootId, x.replyCount, x.working]))).toEqual([
      [
        ['msg_b', 1, false],
        ['msg_a', 0, false],
      ],
      [],
    ]);
    // The same reply again (the send's answer, then the event) changes nothing.
    expect(threadPagesWithMessage(next ?? [], reply, scope, 'chat')).toBe(next);
  });

  it('asks again for a reply to a thread it hasn’t loaded', () => {
    const reply = message('msg_r', { threadRootId: 'msg_old' as never, createdAt: t(3) });
    expect(threadPagesWithMessage([[thread('msg_a')]], reply, scope, 'chat')).toBeNull();
    expect(threadPagesWithMessage([[thread('msg_a')]], reply, scope, null)).toEqual([[thread('msg_a')]]);
  });

  it('keeps untouched pages when a thread is added, edited, moved or removed', () => {
    const pages = [[thread('msg_a')], [thread('msg_b')], [thread('msg_c')], [thread('msg_d')]];
    const original = structuredClone(pages);
    const added = threadPagesWithMessage(pages, message('msg_new'), scope, 'chat');
    expect(added?.[0]?.[0]?.rootId).toBe('msg_new');
    expect(added?.slice(1).every((page, i) => page === pages[i + 1])).toBe(true);
    const edited = threadPagesWithMessage(pages, message('msg_c', { text: 'New title' }), scope, 'chat');
    expect(edited?.[2]?.[0]?.text).toBe('New title');
    expect(edited?.[0]).toBe(pages[0]);
    expect(edited?.[1]).toBe(pages[1]);
    expect(edited?.[3]).toBe(pages[3]);
    const replied = threadPagesWithMessage(
      pages,
      message('msg_r', { threadRootId: 'msg_c' as never, createdAt: t(3) }),
      scope,
      'chat',
    );
    expect(replied?.[0]?.[0]).toMatchObject({ rootId: 'msg_c', replyCount: 1 });
    expect(replied?.[2]).toEqual([]);
    expect(replied?.[1]).toBe(pages[1]);
    expect(replied?.[3]).toBe(pages[3]);
    const removed = threadPagesWithout(pages, 'msg_c');
    expect(removed?.[2]).toEqual([]);
    expect(removed?.[0]).toBe(pages[0]);
    expect(removed?.[1]).toBe(pages[1]);
    expect(removed?.[3]).toBe(pages[3]);
    expect(threadPagesWithout(pages, 'msg_unknown')).toBeNull();
    expect(pages).toEqual(original);
  });

  it('removes overlapping copies while moving a thread, and edits every loaded copy', () => {
    const duplicate = thread('msg_b');
    const pages = [[thread('msg_a'), duplicate], [duplicate, thread('msg_c')], [thread('msg_d')]];
    const edited = threadPagesWithMessage(pages, message('msg_b', { text: 'Updated' }), scope, 'chat');
    expect(edited?.[0]?.[1]?.text).toBe('Updated');
    expect(edited?.[1]?.[0]?.text).toBe('Updated');
    expect(edited?.[2]).toBe(pages[2]);
    const reply = message('msg_r', { threadRootId: 'msg_b' as never, createdAt: t(3) });
    const moved = threadPagesWithMessage(pages, reply, scope, 'chat');
    expect(moved?.flat().map((t) => t.rootId)).toEqual(['msg_b', 'msg_a', 'msg_c', 'msg_d']);
    expect(moved?.[2]).toBe(pages[2]);
    expect(threadPagesWithMessage(moved ?? [], reply, scope, 'chat')).toBe(moved);
    const removed = threadPagesWithout(pages, 'msg_b');
    expect(removed?.flat().map((t) => t.rootId)).toEqual(['msg_a', 'msg_c', 'msg_d']);
    expect(removed?.[2]).toBe(pages[2]);
  });

  it('keeps settled lists still except for an existing root’s title', () => {
    const pages = [[thread('msg_a')], [thread('msg_b')]];
    const settled = { ...scope, state: 'settled' as const };
    expect(threadPagesWithMessage(pages, message('msg_new'), settled, 'chat')).toBe(pages);
    expect(
      threadPagesWithMessage(
        pages,
        message('msg_r', { threadRootId: 'msg_b' as never, createdAt: t(3) }),
        settled,
        'chat',
      ),
    ).toBe(pages);
    const edited = threadPagesWithMessage(pages, message('msg_b', { text: 'Updated' }), settled, 'chat');
    expect(edited?.[1]?.[0]?.text).toBe('Updated');
    expect(edited?.[0]).toBe(pages[0]);
    expect(threadPagesWithMessage([], message('msg_new'), scope, 'chat')?.[0]?.[0]?.rootId).toBe('msg_new');
  });

  it('places an older root it hasn’t loaded by its last activity, not at the top (a reaction or an edit of it)', () => {
    const pages = [[thread('msg_a', { lastAt: t(10) }), thread('msg_b', { lastAt: t(8) })]];
    const old = message('msg_old', { createdAt: t(1), text: 'Old question' });
    // More threads wait on the next page: an older thread belongs there, not on this one.
    expect(threadPagesWithMessage(pages, old, scope, 'chat')).toBe(pages);
    // The whole list is loaded: it goes where its last activity puts it.
    const all = threadPagesWithMessage(pages, old, scope, 'chat', undefined, true);
    expect(all?.flat().map((x) => x.rootId)).toEqual(['msg_a', 'msg_b', 'msg_old']);
    const between = message('msg_mid', { createdAt: t(1), lastReplyAt: t(9), replyCount: 2 });
    expect(
      threadPagesWithMessage(pages, between, scope, 'chat')
        ?.flat()
        .map((x) => x.rootId),
    ).toEqual(['msg_a', 'msg_mid', 'msg_b']);
    // A new question is the newest activity: it starts at the top.
    const fresh = message('msg_new', { createdAt: t(11) });
    expect(threadPagesWithMessage(pages, fresh, scope, 'chat')?.[0]?.[0]?.rootId).toBe('msg_new');
  });

  it('leaves out a settled root the open list no longer has', () => {
    const pages = [[thread('msg_a')]];
    const open = { ...scope, state: 'open' as const };
    const root = message('msg_b', { settled: { at: t(4), how: 'person' } });
    expect(threadPagesWithMessage(pages, root, open, 'chat')).toBe(pages);
  });

  it('keeps every cached list current from realtime and drops a deleted root', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.endpoint(api.chats.list, { params: { burrow: 'burrow-hq' } }), {
      chats: [summary('cnv_chat', { default: true, room: 'chat' })],
    });
    const key = infiniteEndpointKey(api.chats.threads, {
      params: { burrow: 'burrow-hq' },
      query: { room: 'chat' },
    });
    qc.setQueryData<InfiniteData<ChatThreadsResponse>>(key, {
      pages: [{ threads: [thread('msg_a')], next: null }],
      pageParams: [undefined],
    });
    applyRealtimeEvent(qc, {
      type: 'message.created',
      message: message('msg_new', { conversationId: 'cnv_chat' as never, createdAt: t(9) }),
    } as never);
    const roots = () =>
      qc.getQueryData<InfiniteData<ChatThreadsResponse>>(key)?.pages[0]?.threads.map((x) => x.rootId);
    expect(roots()).toEqual(['msg_new', 'msg_a']);
    // `chats.start`'s answer (and the send's) go the same way: no second copy.
    upsertMessageEverywhere(qc, message('msg_new', { conversationId: 'cnv_chat' as never, createdAt: t(9) }));
    expect(roots()).toEqual(['msg_new', 'msg_a']);
    applyRealtimeEvent(qc, {
      type: 'message.deleted',
      conversationId: 'cnv_chat',
      messageId: 'msg_a',
    } as never);
    expect(roots()).toEqual(['msg_new']);
  });
});
