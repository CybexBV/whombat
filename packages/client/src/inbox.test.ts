import type { InboxResponse } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { inboxItemShown, unreadMentionCount } from './inbox';
import { reduceNotificationRead } from './query/reducers';
import { inboxItem, t } from './test/fixtures';

const inbox = (): InboxResponse => ({
  sections: [
    { kind: 'needs_you', title: 'NEEDS YOU', items: [inboxItem('ntf_1')] },
    {
      kind: 'mention',
      title: 'MENTIONS',
      items: [inboxItem('ntf_2', { kind: 'mention' }), inboxItem('ntf_3', { kind: 'mention', readAt: t(1) })],
    },
    { kind: 'reply', title: 'REPLIES', items: [inboxItem('ntf_4', { kind: 'reply' })] },
    { kind: 'agent_update', title: 'FROM AGENTS', items: [inboxItem('ntf_5', { kind: 'agent_update' })] },
  ],
  counts: { all: 5, needs_you: 1, mentions: 3, agents: 1 },
  unread: 4,
});

describe('the inbox as the clients read it (WE-11)', () => {
  it('a read mention or reply leaves; NEEDS YOU and agents’ updates stay', () => {
    expect(inboxItemShown({ kind: 'mention', readAt: t(1) })).toBe(false);
    expect(inboxItemShown({ kind: 'reply', readAt: null })).toBe(true);
    expect(inboxItemShown({ kind: 'needs_you', readAt: t(1) })).toBe(true);
    expect(inboxItemShown({ kind: 'agent_update', readAt: t(1) })).toBe(true);
  });

  it('counts unread mentions, direct messages and replies for the sidebar', () => {
    expect(unreadMentionCount(inbox())).toBe(2);
    expect(unreadMentionCount(undefined)).toBe(0);
  });

  it('notification.read: by ids, all, or up to a time; the server’s count when it is the latest', () => {
    const byId = reduceNotificationRead(inbox(), { ids: ['ntf_2', 'ntf_3'], unread: 3 }, t(2));
    expect(byId.unread).toBe(3);
    expect(unreadMentionCount(byId)).toBe(1);
    // ntf_3 was read earlier: it keeps its time.
    expect(byId.sections[1]?.items.map((i) => i.readAt)).toEqual([t(2), t(1)]);
    // Again: nothing changes.
    expect(reduceNotificationRead(byId, { ids: ['ntf_2', 'ntf_3'], unread: 3 }, t(2))).toBe(byId);

    const all = reduceNotificationRead(inbox(), { ids: null }, t(3));
    expect(all.unread).toBe(0);
    expect(all.sections.every((s) => s.items.every((i) => i.readAt !== null))).toBe(true);

    const upTo = reduceNotificationRead(
      {
        ...inbox(),
        sections: [
          {
            kind: 'mention',
            title: 'MENTIONS',
            items: [
              inboxItem('ntf_a', { kind: 'mention', createdAt: t(1) }),
              inboxItem('ntf_b', { kind: 'mention', createdAt: t(5) }),
            ],
          },
        ],
        unread: 2,
      },
      { ids: null, before: t(2) },
      t(6),
    );
    expect(upTo.sections[0]?.items.map((i) => i.readAt)).toEqual([t(6), null]);
    expect(upTo.unread).toBe(1);

    // An older event arriving late marks its rows but doesn't put its stale count back.
    const late = reduceNotificationRead(all, { ids: ['ntf_2'], unread: 3 }, t(2), false);
    expect(late.unread).toBe(0);
  });
});
