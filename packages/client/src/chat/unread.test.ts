import { QueryClient } from '@tanstack/query-core';
import { api, type ChatUnreadResponse } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { applyRealtimeEvent } from '../query/apply';
import { queryKeys } from '../query/keys';
import { threadShowsNew, threadUnreadCounts, withThreadRead } from './unread';

const list = (conversationId: string | null, threads: [string, number][]): ChatUnreadResponse => ({
  conversationId: conversationId as never,
  threads: threads.map(([rootId, unread]) => ({ rootId: rootId as never, unread })),
});

describe('threads with something new', () => {
  it('counts by thread, and a read thread leaves the list', () => {
    const data = list('cnv_chat', [
      ['msg_a', 2],
      ['msg_b', 1],
    ]);
    expect(threadUnreadCounts(data).get('msg_a')).toBe(2);
    expect(threadUnreadCounts(undefined).size).toBe(0);
    expect(threadUnreadCounts(withThreadRead(data, 'msg_a'))).toEqual(new Map([['msg_b', 1]]));
    expect(withThreadRead(data, 'msg_x')).toBe(data);
  });

  it('never shows the thread on screen as new', () => {
    const counts = threadUnreadCounts(list('cnv_chat', [['msg_a', 1]]));
    expect(threadShowsNew(counts, 'msg_a', null)).toBe(true);
    expect(threadShowsNew(counts, 'msg_a', 'msg_a')).toBe(false);
    expect(threadShowsNew(counts, 'msg_b', null)).toBe(false);
  });

  it('asks again when the room’s badge moves, and only for that room', () => {
    const qc = new QueryClient();
    const chat = queryKeys.endpoint(api.chats.unread, {
      params: { burrow: 'burrow-hq' },
      query: { room: 'chat' },
    });
    const feedback = queryKeys.endpoint(api.chats.unread, {
      params: { burrow: 'burrow-hq' },
      query: { room: 'feedback' },
    });
    qc.setQueryData(chat, list('cnv_chat', []));
    qc.setQueryData(feedback, list('cnv_feedback', []));
    applyRealtimeEvent(qc, {
      type: 'conversation.unread',
      conversationId: 'cnv_chat',
      unread: 1,
      mentions: 0,
    } as never);
    expect(qc.getQueryState(chat)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(feedback)?.isInvalidated).toBe(false);
  });
});
