import { QueryClient } from '@tanstack/query-core';
import { api, type ChatSummary } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { applyRealtimeEvent } from '../query/apply';
import { queryKeys } from '../query/keys';
import { conversation, message, t } from '../test/fixtures';

const key = queryKeys.endpoint(api.chats.list, { params: { burrow: 'burrow-hq' } });
const chat = (id: string, lastAt: string): ChatSummary => ({
  id: id as never,
  title: id,
  lastAt,
  unread: 0,
  default: false,
});

describe('task chats stay current from realtime (AP-1270)', () => {
  it('a new message moves its chat to the top; its unread count follows', () => {
    const qc = new QueryClient();
    qc.setQueryData(key, {
      chats: [chat('cnv_a', '2026-09-26T10:00:00Z'), chat('cnv_b', '2026-09-26T09:00:00Z')],
    });
    applyRealtimeEvent(qc, {
      type: 'message.created',
      message: message('msg_new', {
        conversationId: 'cnv_b' as never,
        text: 'Done.',
        createdAt: '2026-09-26T11:00:00Z',
      }),
    } as never);
    const after = qc.getQueryData(key) as { chats: ChatSummary[] };
    expect(after.chats.map((c) => [c.id, c.lastText])).toEqual([
      ['cnv_b', 'Done.'],
      ['cnv_a', undefined],
    ]);
    applyRealtimeEvent(qc, {
      type: 'conversation.unread',
      conversationId: 'cnv_a',
      unread: 2,
      mentions: 0,
    } as never);
    expect((qc.getQueryData(key) as { chats: ChatSummary[] }).chats[1]?.unread).toBe(2);
  });

  it('a chat archived and brought back shows as archived, then as not archived again', () => {
    const qc = new QueryClient();
    qc.setQueryData(key, { chats: [chat('cnv_a', t(0))] });
    const archivedAt = (): string | null | undefined =>
      (qc.getQueryData(key) as { chats: ChatSummary[] }).chats[0]?.archivedAt;
    const updated = (at: number, chatArchivedAt: string | null) =>
      applyRealtimeEvent(
        qc,
        {
          type: 'conversation.updated',
          conversation: conversation({
            id: 'cnv_a' as never,
            chat: { title: 'Fix the NAS', archivedAt: chatArchivedAt },
          }),
        } as never,
        { at: t(at) },
      );
    updated(1, t(1));
    expect(archivedAt()).toBe(t(1));
    updated(2, null);
    expect(archivedAt()).toBeNull();
  });
});
