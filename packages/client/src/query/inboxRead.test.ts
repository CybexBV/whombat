import { QueryClient } from '@tanstack/query-core';
import type { InboxResponse } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import { BURROW, bootstrap, inboxItem, summary, t } from '../test/fixtures';
import {
  cachedConversationLink,
  inboxIdsReadAt,
  markInboxReadAt,
  placeOfLink,
  sameConversationLink,
} from './inboxRead';
import { endpointKey } from './keys';

const chat = { type: 'dm', room: 'chat' } as const;
const feedback = { type: 'dm', room: 'feedback' } as const;

const inbox = (): InboxResponse => ({
  sections: [
    {
      kind: 'needs_you',
      title: 'NEEDS YOU',
      items: [inboxItem('ntf_ask', { link: { type: 'approval', number: 12 } })],
    },
    {
      kind: 'mention',
      title: 'MENTIONS',
      items: [
        inboxItem('ntf_top', { kind: 'mention', link: { type: 'message', in: chat, messageId: 'msg_1' } }),
        inboxItem('ntf_thread', {
          kind: 'mention',
          link: { type: 'message', in: chat, messageId: 'msg_3', threadRootId: 'msg_1' },
        }),
        inboxItem('ntf_old', {
          kind: 'mention',
          link: { type: 'message', in: chat, messageId: 'msg_0' },
          readAt: t(1),
        }),
      ],
    },
    { kind: 'reply', title: 'REPLIES', items: [inboxItem('ntf_fb', { kind: 'reply', link: feedback })] },
    {
      kind: 'agent_update',
      title: 'FROM AGENTS',
      items: [
        inboxItem('ntf_agent', {
          kind: 'agent_update',
          link: { type: 'message', in: chat, messageId: 'msg_2' },
        }),
      ],
    },
  ],
  counts: { all: 6, needs_you: 1, mentions: 4, agents: 1 },
  unread: 5,
});

describe('reading a conversation reads its inbox rows (AP-704)', () => {
  it('matches conversations by their link', () => {
    expect(sameConversationLink(chat, { type: 'dm' })).toBe(true);
    expect(sameConversationLink(chat, feedback)).toBe(false);
    expect(sameConversationLink({ type: 'chat', id: 'cnv_a' }, { type: 'chat', id: 'cnv_b' })).toBe(false);
    // A branch room's repository counts only when both say it.
    expect(sameConversationLink({ type: 'pr', number: 4 }, { type: 'pr', number: 4, repo: 'acme/web' })).toBe(
      true,
    );
    expect(
      sameConversationLink(
        { type: 'pr', number: 4, repo: 'acme/api' },
        { type: 'pr', number: 4, repo: 'acme/web' },
      ),
    ).toBe(false);
    expect(placeOfLink({ type: 'run', number: 1 })).toBeNull();
    expect(placeOfLink({ type: 'message', in: chat, messageId: 'msg_3', threadRootId: 'msg_1' })).toEqual({
      link: chat,
      threadRootId: 'msg_1',
    });
  });

  it('the top level reads its unread mentions; a thread reads its own; agents’ updates and NEEDS YOU stay', () => {
    expect(inboxIdsReadAt(inbox(), { link: chat, threadRootId: null })).toEqual(['ntf_top']);
    expect(inboxIdsReadAt(inbox(), { link: chat, threadRootId: 'msg_1' })).toEqual(['ntf_thread']);
    expect(inboxIdsReadAt(inbox(), { link: feedback, threadRootId: null })).toEqual(['ntf_fb']);
    expect(inboxIdsReadAt(inbox(), { link: { type: 'pr', number: 482 }, threadRootId: null })).toEqual([]);
  });

  it('marks the cached rows of the conversation it finds in the sidebar, in that burrow only', () => {
    const qc = new QueryClient();
    const B = { burrow: BURROW };
    const key = endpointKey(api.notifications.inbox, { params: B });
    qc.setQueryData(endpointKey(api.conversations.bootstrap, { params: B }), bootstrap());
    qc.setQueryData(key, inbox());
    expect(cachedConversationLink(qc, summary().id)).toEqual(chat);
    expect(cachedConversationLink(qc, 'cnv_unknown')).toBeNull();
    expect(markInboxReadAt(qc, 'cnv_unknown', null, t(5), BURROW)).toEqual([]);
    expect(markInboxReadAt(qc, summary().id, null, t(5), 'other-burrow')).toEqual([]);
    expect(markInboxReadAt(qc, summary().id, null, t(5), BURROW)).toEqual(['ntf_top']);
    const after = qc.getQueryData(key) as InboxResponse;
    expect(after.unread).toBe(4);
    expect(after.sections[1]?.items[0]?.readAt).toBe(t(5));
    // Nothing left to read there.
    expect(markInboxReadAt(qc, summary().id, null, t(6), BURROW)).toEqual([]);
  });
});
