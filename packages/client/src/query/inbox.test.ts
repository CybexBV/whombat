import type { InboxResponse } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { inboxItem, t } from '../test/fixtures';
import { markInboxRead } from './reducers';

const inbox = (): InboxResponse => ({
  sections: [
    {
      kind: 'needs_you',
      title: 'NEEDS YOU',
      items: [inboxItem('ntf_1'), inboxItem('ntf_2', { readAt: t(1) })],
    },
    { kind: 'mention', title: 'MENTIONS', items: [inboxItem('ntf_3', { kind: 'mention' })] },
  ],
  counts: { all: 3, needs_you: 2, mentions: 1, agents: 0 },
  unread: 2,
});

describe('markInboxRead', () => {
  it('leaves the inbox alone when nothing changes, and takes the server’s count when given', () => {
    const before = inbox();
    expect(markInboxRead(before, ['ntf_2'], t(5))).toBe(before);
    expect(markInboxRead(before, ['ntf_2'], t(5), 0).unread).toBe(0);
    const all = markInboxRead(before, 'all', t(6));
    expect(all.sections.flatMap((s) => s.items).every((i) => i.readAt !== null)).toBe(true);
    expect(all.unread).toBe(0);
  });
});
