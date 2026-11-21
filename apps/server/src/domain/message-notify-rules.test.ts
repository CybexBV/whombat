import { describe, expect, it } from 'vitest';
import {
  type MessageFacts,
  type NotifyRecipient,
  notificationKindFor,
  planMessageNotifications,
} from './message-notify-rules';

const person = (id: string, over: Partial<NotifyRecipient> = {}): NotifyRecipient => ({
  id,
  notify: null,
  threadReplies: true,
  inThread: false,
  ...over,
});

const facts = (over: Partial<MessageFacts> = {}): MessageFacts => ({
  kind: 'branch',
  authorId: 'mara',
  authorKind: 'person',
  mentionIds: [],
  isReply: false,
  ...over,
});

const who = (list: { principalId: string; kind: string }[]) => list.map((p) => `${p.principalId}:${p.kind}`);

describe('who a message notifies (essentials-people.md EP-11…EP-13)', () => {
  it('a branch room at its default (mentions): only the people it mentions, never the author', () => {
    const plan = planMessageNotifications(facts({ mentionIds: ['joris', 'mara'] }), [
      person('mara'),
      person('joris'),
      person('priya'),
    ]);
    expect(who(plan)).toEqual(['joris:mention']);
  });

  it('`none` gets nothing, not even a mention; another person’s top-level message makes no row (OA-S60)', () => {
    const plan = planMessageNotifications(facts({ mentionIds: ['priya'] }), [
      person('joris', { notify: 'all' }),
      person('priya', { notify: 'none' }),
      person('tom'),
    ]);
    expect(who(plan)).toEqual([]);
  });

  it('a thread reply reaches the people in the thread unless they turned thread replies off', () => {
    const plan = planMessageNotifications(facts({ isReply: true }), [
      person('joris', { inThread: true }),
      person('priya', { inThread: true, threadReplies: false }),
      person('tom'),
      person('mara', { inThread: true }),
    ]);
    expect(who(plan)).toEqual(['joris:reply']);
  });

  it('a top-level message never counts as a reply, whoever was in some thread', () => {
    expect(planMessageNotifications(facts(), [person('joris', { inThread: true })])).toEqual([]);
  });

  it('an agent’s DM message is an agent update for its person (default `all`), unless told not to', () => {
    const dm = facts({ kind: 'dm', authorId: 'dusty', authorKind: 'agent' });
    expect(who(planMessageNotifications(dm, [person('mara')]))).toEqual(['mara:agent_update']);
    expect(planMessageNotifications(dm, [person('mara')], { notifyDmPerson: false })).toEqual([]);
    expect(planMessageNotifications(dm, [person('mara', { notify: 'mentions' })])).toEqual([]);
  });

  it('a handoff’s lane root tells the people it mentions nothing (they get a needs-you row instead)', () => {
    const plan = planMessageNotifications(
      facts({ mentionIds: ['joris'] }),
      [person('joris', { notify: 'all' })],
      {
        notifyMentions: false,
      },
    );
    expect(plan).toEqual([]);
  });

  it('an edit tells only the people it newly mentions, as a mention, respecting `none`', () => {
    const edited = facts({ mentionIds: ['joris', 'priya', 'tom'] });
    const plan = planMessageNotifications(
      edited,
      [
        person('joris'),
        person('priya', { notify: 'none' }),
        person('tom'),
        person('lena', { notify: 'all' }),
      ],
      { addedMentions: ['joris', 'priya'] },
    );
    expect(who(plan)).toEqual(['joris:mention']);
  });

  it('maps reasons to inbox kinds: thread replies are replies, agents’ messages agent updates', () => {
    expect(notificationKindFor('all', { isReply: true, authorKind: 'person' })).toBe('reply');
    expect(notificationKindFor('all', { isReply: false, authorKind: 'agent' })).toBe('agent_update');
    expect(notificationKindFor('all', { isReply: false, authorKind: 'person' })).toBeNull();
  });
});
