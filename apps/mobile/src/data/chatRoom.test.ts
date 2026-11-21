/** Chat on the phone (chat-channel.md AP-2450…AP-2460): the tab's badge, the started-chat route, the work line, Threads. */
import { agentWords, chatRoomsOf, threadRows } from '@whombat/client';
import type { ChatSummary, ChatThread } from '@whombat/core';
import { at } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import {
  CHAT_COPY,
  chatTabCount,
  phoneThreadRows,
  roomStage,
  roomWork,
  startedChatRoute,
  threadRoute,
} from './chatRoom';

const row = (id: string, extra: Partial<ChatSummary> = {}): ChatSummary => ({
  id,
  title: id,
  subject: null,
  lastAt: null,
  unread: 0,
  default: false,
  archivedAt: null,
  ...extra,
});

const thread = (rootId: string, extra: Partial<ChatThread> = {}): ChatThread => ({
  conversationId: 'cnv_dm',
  room: 'chat',
  rootId,
  authorId: 'prn_mara',
  text: 'Why is pve-02 using so much memory?',
  createdAt: at('09:41'),
  replyCount: 0,
  lastAt: at('09:41'),
  working: false,
  ...extra,
});

const words = agentWords('Neo');

describe('the Chat tab’s badge (AP-2452)', () => {
  it('counts what is unread in Chat and in Feedback', () => {
    const rooms = chatRoomsOf([
      row('cnv_task', { room: 'task', unread: 9 }),
      row('cnv_fb', { room: 'feedback', unread: 3 }),
      row('cnv_dm', { default: true, unread: 2 }),
    ]);
    expect(chatTabCount(rooms)).toBe(5);
    expect(chatTabCount(chatRoomsOf(undefined))).toBe(0);
  });
});

describe('a started chat (CHT-06, AP-2455)', () => {
  it('opens the new thread in Chat', () => {
    const started = {
      conversation: { id: 'cnv_task', title: 'x', chat: { title: 'Is pve-02 cool?' } },
      message: { id: 'msg_root', threadRootId: null },
    };
    expect(startedChatRoute(started, 'Watch')).toEqual({
      name: 'Thread',
      params: { messageId: 'msg_root', back: 'Watch' },
    });
  });
});

describe('a hand-over’s thread (BPL-15)', () => {
  it('opens the thread a Chat link names, and nothing for another link', () => {
    expect(threadRoute('/chat?thread=msg_1', 'Inbox')).toEqual({
      name: 'Thread',
      params: { messageId: 'msg_1', back: 'Inbox' },
    });
    expect(threadRoute('/things/server%3Ablackbox', 'Inbox')).toBeNull();
    expect(threadRoute(null, 'Inbox')).toBeNull();
  });
});

describe('the work under a thread (AP-2458)', () => {
  const neo = undefined;
  it('says “Looking into it” while the assistant thinks, or the server says it works', () => {
    const thinking = {
      agent: neo,
      name: 'Neo',
      text: 'is thinking',
      progress: null,
      tone: 'live' as const,
    };
    expect(roomWork(thinking, false, neo, words)).toMatchObject({
      line: CHAT_COPY.working,
      spoken: words.lookingIntoIt,
    });
    expect(roomWork(null, true, neo, words)).toMatchObject({ name: 'Neo', line: CHAT_COPY.working });
    expect(roomWork(null, false, neo, words)).toBeNull();
  });

  it('shows what was handed to T3 Code, unless the assistant’s own turn is at work there', () => {
    const handed = {
      agent: neo,
      name: 'T3 Code',
      text: 'is working on it',
      progress: null,
      tone: 'live' as const,
      by: 't3code' as const,
      since: 0,
    };
    expect(roomWork(handed, false, neo, words)).toBe(handed);
    expect(roomWork(handed, true, neo, words)).toMatchObject({ name: 'Neo', line: CHAT_COPY.working });
  });

  it('keeps a run’s progress and a question in their own words', () => {
    const run = {
      agent: neo,
      name: 'Neo',
      text: 'is working · 38%',
      progress: 38,
      tone: 'live' as const,
    };
    const asks = { agent: neo, name: 'Neo', text: 'needs you', progress: null, tone: 'warn' as const };
    expect(roomWork(run, true, neo, words)).toBe(run);
    expect(roomWork(asks, false, neo, words)).toBe(asks);
  });
});

describe('a thread’s row (CHT-07, AP-2454)', () => {
  const people = { name: (id: string) => (id === 'prn_neo' ? 'Neo' : 'Mara Okafor') };
  it('says how many replies and when the last came, or that the assistant looks into it', () => {
    const rows = phoneThreadRows(
      threadRows(
        [
          thread('msg_a', {
            replyCount: 4,
            lastAt: at('10:12'),
            subject: { kind: 'server', id: 'pve-02', name: 'pve-02' },
          }),
          thread('msg_b', { working: true, text: 'Is there new firmware?' }),
          thread('msg_c', { authorId: 'prn_neo', text: '  ' }),
        ],
        new Date(at('10:14')),
        'Europe/Amsterdam',
      ),
      people,
      words,
    );
    expect(rows.map((r) => r.rootId)).toEqual(['msg_a', 'msg_b', 'msg_c']);
    expect(rows[0]?.line).toMatch(/^4 replies · Last reply/);
    expect(rows[0]?.subject?.name).toBe('pve-02');
    expect(rows[0]?.label).toContain('about pve-02');
    expect(rows[1]?.line).toBe(CHAT_COPY.working);
    expect(rows[1]?.label).toContain(words.lookingIntoIt);
    expect(rows[2]?.title).toBe('…');
    expect(rows[2]?.line).toMatch(/^Neo · /);
  });
});

describe('a room thread’s stage (chat-threads-cards.md)', () => {
  const none = { waiting: false, working: false, handedOver: false, settled: null };
  const thinking = {
    agent: undefined,
    name: 'Neo',
    text: 'is thinking',
    progress: null,
    tone: 'live' as const,
  };

  it('comes from the flags, what waits first, and is nothing without one', () => {
    expect(roomStage(none, null)).toBeNull();
    expect(roomStage({ ...none, waiting: true, working: true }, null)).toBe('waiting');
    expect(roomStage({ ...none, handedOver: true }, null)).toBe('handedOver');
    expect(roomStage({ ...none, settled: { at: '2026-09-23T09:00:00Z', how: 'person' } }, null)).toBe(
      'settled',
    );
  });

  it('counts the assistant’s own turn and T3 Code’s work as the flags they are, not a run that needs a look', () => {
    expect(roomStage(none, thinking)).toBe('working');
    expect(roomStage(none, { ...thinking, by: 't3code', since: 0 })).toBe('handedOver');
    expect(roomStage(none, { ...thinking, text: 'needs you', tone: 'warn' })).toBeNull();
  });
});
