/**
 * A server task's card changes on its message (contracts 0.116, CT-880; task-feedback.md AP-4303): the runtime updates
 * the card in place when the task ends and publishes the whole message as `message.updated`, which reaches the
 * conversation's list and the thread without a reload; a late frame of the running card can't bring it back.
 */
import { QueryClient } from '@tanstack/query-core';
import { api, type Message, type MessagePage, type TaskCard, type ThreadView } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { BURROW, message, t } from '../test/fixtures';
import { decodeRealtimeEvent } from '../tolerant';
import { applyRealtimeEvent, createCacheSyncState } from './apply';
import { endpointKey } from './keys';

const CONV = 'cnv_chat';
const B = { burrow: BURROW };
const keys = {
  list: endpointKey(api.messages.list, { params: { ...B, conversationId: CONV } }),
  thread: endpointKey(api.messages.thread, { params: { ...B, messageId: 'msg_root' } }),
};

const running: TaskCard = {
  kind: 'task',
  followedTaskId: 'ftk_ha0updates01' as TaskCard['followedTaskId'],
  serverId: 'home-assistant',
  server: 'Home Assistant',
  title: 'Installing 23 updates on Home Assistant',
  state: 'running',
  startedAt: t(1),
  endedAt: null,
  result: null,
};
const ended: TaskCard = {
  ...running,
  state: 'ok',
  endedAt: t(5),
  result: 'Home Assistant is up to date: 23 updates installed.',
};

const root = message('msg_root', { text: 'Update Home Assistant please', replyCount: 1 });
const reply = (card: TaskCard): Message =>
  message('msg_task', {
    authorId: 'prn_neo',
    createdAt: t(1),
    threadRootId: 'msg_root',
    text: 'Installing 23 updates on Home Assistant · 0 s',
    card,
  });

function seeded(): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData(keys.list, { messages: [root], hasMore: false, before: null } satisfies MessagePage);
  qc.setQueryData(keys.thread, {
    root,
    replies: [reply(running)],
    conversationId: CONV,
    where: 'Chat',
    topic: null,
    more: null,
  } as unknown as ThreadView);
  return qc;
}

describe('a task card that ends (AP-4303)', () => {
  it('decodes as a task card, not the newer-app placeholder', () => {
    const r = decodeRealtimeEvent({ type: 'message.updated', message: reply(ended) });
    expect(r.kind).toBe('event');
    if (r.kind !== 'event' || r.event.type !== 'message.updated') throw new Error('not decoded');
    expect(r.event.message.card?.kind).toBe('task');
  });

  it('replaces the running card in the thread, and an older frame doesn’t undo it', () => {
    const qc = seeded();
    const state = createCacheSyncState(() => Date.parse(t(30)));
    expect(
      applyRealtimeEvent(qc, { type: 'message.updated', message: reply(ended) }, { at: t(5) }, state),
    ).toBe(true);
    const card = () => qc.getQueryData<ThreadView>(keys.thread)?.replies[0]?.card;
    expect(card()).toMatchObject({ kind: 'task', state: 'ok', endedAt: t(5) });
    expect(
      applyRealtimeEvent(qc, { type: 'message.updated', message: reply(running) }, { at: t(2) }, state),
    ).toBe(false);
    expect(card()).toMatchObject({ state: 'ok' });
  });
});
