/** Contracts 0.93.0, Chat: one threaded room, Feedback beside it, Home called Dashboard (CT-440…CT-448). */
import { describe, expect, it } from 'vitest';
import { ALL_ENDPOINTS, api, MCP_TOOLS } from '../contracts/index.js';
import {
  CHAT_ROOMS,
  CHAT_THREAD_TEXT_MAX,
  CHAT_THREADS_LIMIT_MAX,
  ChatSummary,
  ChatThread,
  chatSubjectLine,
  chatSummaryRoom,
  chatThreadSubjectLine,
} from './conversation.js';
import { chatRoomHref, chatThreadHref, DASHBOARD_HREF, HomeHref, parseChatHref } from './home.js';
import { HOST_ASKS_FIRST_WORDS } from './hosts.js';
import { Message } from './message.js';

const T = '2026-10-18T21:30:00.000Z';
const subject = { kind: 'server', id: 'pve-02', name: 'pve-02' } as const;

const message = {
  id: 'msg_root1',
  conversationId: 'cnv_chat',
  authorId: 'prn_john',
  createdAt: T,
  editedAt: null,
  text: 'Why is pve-02 slow?',
  mentions: [],
  card: null,
  attachments: [],
  reactions: [],
  threadRootId: null,
  replyCount: 0,
  lastReplyAt: null,
  threadParticipantIds: [],
  clientId: null,
};

const thread = {
  conversationId: 'cnv_chat',
  room: 'chat',
  rootId: 'msg_root1',
  authorId: 'prn_john',
  text: 'Why is pve-02 slow?',
  subject,
  createdAt: T,
  replyCount: 3,
  lastAt: T,
  working: true,
};

describe('a thread’s subject on its first message (CT-440)', () => {
  it('round-trips the subject, and parses messages without one', () => {
    expect(Message.parse({ ...message, subject }).subject).toEqual(subject);
    expect(Message.parse({ ...message, subject: null }).subject).toBeNull();
    expect(Message.parse(message).subject).toBeUndefined();
    expect(Message.safeParse({ ...message, subject: { ...subject, kind: 'channel' } }).success).toBe(false);
  });

  it('names the thread’s subject for the turn', () => {
    expect(chatThreadSubjectLine(subject)).toContain('thread is about the server pve-02');
    expect(chatSubjectLine(subject)).toContain('chat is about the server pve-02');
  });
});

describe('the rooms in the chats list (CT-441)', () => {
  const row = { id: 'cnv_chat', title: 'Neo', lastAt: T, unread: 2, default: true };

  it('has two rooms', () => {
    expect([...CHAT_ROOMS]).toEqual(['chat', 'feedback']);
  });

  it('reads a row’s room, absent meaning a task chat unless it is the default chat', () => {
    expect(chatSummaryRoom(ChatSummary.parse(row))).toBe('chat');
    expect(chatSummaryRoom(ChatSummary.parse({ ...row, default: false }))).toBe('task');
    expect(chatSummaryRoom(ChatSummary.parse({ ...row, default: false, room: 'feedback' }))).toBe('feedback');
    expect(ChatSummary.parse({ ...row, room: 'chat' }).room).toBe('chat');
    expect(ChatSummary.safeParse({ ...row, room: 'channel' }).success).toBe(false);
  });
});

describe('threads (CT-442, CT-443)', () => {
  it('round-trips a thread', () => {
    expect(ChatThread.parse(thread)).toEqual(thread);
    expect(ChatThread.parse({ ...thread, subject: undefined, room: 'feedback' }).room).toBe('feedback');
  });

  it('refuses a task room, a long text and a root that isn’t a message', () => {
    expect(ChatThread.safeParse({ ...thread, room: 'task' }).success).toBe(false);
    expect(ChatThread.safeParse({ ...thread, text: 'x'.repeat(CHAT_THREAD_TEXT_MAX + 1) }).success).toBe(
      false,
    );
    expect(ChatThread.safeParse({ ...thread, rootId: 'cnv_chat' }).success).toBe(false);
  });

  it('lists a room’s threads as a read, Chat and 30 by default, at most 50', () => {
    const e = api.chats.threads;
    expect([e.id, e.method, e.path]).toEqual(['chats.threads', 'GET', '/burrows/:burrow/chats/threads']);
    expect(e.query.parse({})).toEqual({ room: 'chat', limit: 30 });
    const q = e.query.parse({
      room: 'feedback',
      subjectKind: 'device',
      subjectId: 'con_x',
      before: T,
      limit: '10',
    });
    expect(q).toMatchObject({ room: 'feedback', subjectKind: 'device', before: T, limit: 10 });
    expect(e.query.safeParse({ limit: CHAT_THREADS_LIMIT_MAX + 1 }).success).toBe(false);
    expect(e.query.safeParse({ room: 'task' }).success).toBe(false);
    expect(e.query.safeParse({ before: 'yesterday' }).success).toBe(false);
    expect(e.response.parse({ threads: [thread], next: null }).threads).toHaveLength(1);
    expect(e.response.parse({ threads: [], next: T }).next).toBe(T);
  });

  it('starts a thread with the same body and answer (CT-444)', () => {
    const e = api.chats.start;
    expect([e.method, e.path]).toEqual(['POST', '/burrows/:burrow/chats']);
    expect(e.body.parse({ text: 'Look into pve-02', subject }).subject).toEqual(subject);
    expect(e.summary).toContain('thread');
    expect(Object.keys(api.chats)).toEqual(
      expect.arrayContaining(['list', 'threads', 'start', 'rename', 'archive', 'unarchive']),
    );
  });
});

describe('links to rooms, threads and the Dashboard (CT-445)', () => {
  it('makes the rooms’, a thread’s and the Dashboard’s paths', () => {
    expect(chatRoomHref('chat')).toBe('/chat');
    expect(chatRoomHref('feedback')).toBe('/feedback');
    expect(chatThreadHref('chat', 'msg_root1')).toBe('/chat?thread=msg_root1');
    expect(chatThreadHref('feedback', 'msg_r-2')).toBe('/feedback?thread=msg_r-2');
    expect(DASHBOARD_HREF).toBe('/dashboard');
    for (const href of [chatThreadHref('chat', 'msg_root1'), chatRoomHref('feedback'), DASHBOARD_HREF])
      expect(HomeHref.safeParse(href).success, href).toBe(true);
  });

  it('parses a room and its thread back', () => {
    for (const room of CHAT_ROOMS) {
      expect(parseChatHref(chatRoomHref(room))).toEqual({ room, thread: null });
      expect(parseChatHref(chatThreadHref(room, 'msg_root1'))).toEqual({ room, thread: 'msg_root1' });
    }
    expect(parseChatHref('/chat/')).toEqual({ room: 'chat', thread: null });
    expect(parseChatHref('/feedback?x=1&thread=msg_r2#end')).toEqual({ room: 'feedback', thread: 'msg_r2' });
    expect(parseChatHref('/chat#top')).toEqual({ room: 'chat', thread: null });
  });

  it('opens the room without a thread that isn’t a message id', () => {
    expect(parseChatHref('/chat?thread=')).toEqual({ room: 'chat', thread: null });
    expect(parseChatHref('/chat?thread=cnv_x')).toEqual({ room: 'chat', thread: null });
    expect(parseChatHref('/chat?thread=%E0%A4%A')).toEqual({ room: 'chat', thread: null });
    expect(parseChatHref('/chat?threads=msg_x')).toEqual({ room: 'chat', thread: null });
  });

  it('leaves every other path alone', () => {
    for (const href of [
      '/chats',
      '/chats/cnv_x',
      '/dashboard',
      '/chatx',
      '/chat/x',
      '/c/general',
      '',
      'chat',
    ])
      expect(parseChatHref(href), href).toBeNull();
  });
});

describe('Home is called Dashboard (CT-447), then Connections (CT-451), then Overview (sidebar-tabs.md)', () => {
  const homeWord = /\bHome\b(?! Assistant)|Done recently|\bDashboard\b/;

  it('says Overview in the endpoints’ and tools’ words', () => {
    expect(api.home.overview.summary).toContain('Overview');
    expect(api.widgets.list.summary).toContain('Overview');
    // A pin goes on a page: the Overview is gone (servers-connections-places.md).
    expect(MCP_TOOLS.pin_widget.description).not.toContain('Overview');
    expect(MCP_TOOLS.pin_widget.description).toContain('thingId');
    expect(MCP_TOOLS.report_change.description).toContain('Changes here');
    expect(HOST_ASKS_FIRST_WORDS.hint.never).toContain('Changes here');
  });

  it('names neither Home, Done recently nor Dashboard anywhere a person or an agent reads it', () => {
    for (const e of ALL_ENDPOINTS) expect(e.summary, e.id).not.toMatch(homeWord);
    for (const t of Object.values(MCP_TOOLS)) {
      expect(t.title, t.name).not.toMatch(homeWord);
      expect(t.description, t.name).not.toMatch(homeWord);
    }
    for (const hint of Object.values(HOST_ASKS_FIRST_WORDS.hint)) expect(hint).not.toMatch(homeWord);
  });
});
