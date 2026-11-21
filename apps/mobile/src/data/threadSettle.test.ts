/**
 * Settling threads on the phone (chat-settle.md AP-6153…AP-6158, AP-6251, AP-6252): the lines, what a thread offers,
 * Settled's rows, Chat and Feedback without their settled threads, Profile's switches and what a settle does to the
 * cached messages and lists.
 */
import type { InfiniteData } from '@tanstack/query-core';
import {
  type ChatThread,
  type ChatThreadsResponse,
  DEFAULT_CHAT_PREFERENCES,
  type Message,
  type ThreadSettle,
} from '@whombat/core';
import { at, mara, SEED_NOW, SEED_TIME_ZONE } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { worldContext } from '../test/world';
import { messageMenu, messageSwipe } from './messageActions';
import { chatItems } from './messages';
import {
  chatPreferencesOf,
  messageWithSettle,
  SETTLE_COPY,
  settledRowLine,
  settledShelf,
  settledWhen,
  settleOffer,
  threadsWithSettle,
  withMergedSwitch,
  withoutSettledItems,
  withQuietDays,
} from './threadSettle';

const person = (when: string): ThreadSettle => ({ at: when, how: 'person' });

function root(id: string, createdAt: string, text: string, settled: ThreadSettle | null = null): Message {
  return {
    id,
    conversationId: 'cnv_chat',
    authorId: mara.id,
    createdAt,
    editedAt: null,
    text,
    mentions: [],
    card: null,
    suggestions: [],
    more: null,
    attachments: [],
    reactions: [],
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
    settled,
  };
}

function thread(rootId: string, lastAt: string, o: Partial<ChatThread> = {}): ChatThread {
  return {
    conversationId: 'cnv_chat',
    room: 'chat',
    rootId,
    authorId: mara.id,
    text: rootId,
    subject: null,
    createdAt: lastAt,
    replyCount: 0,
    lastAt,
    working: false,
    ...o,
  };
}

const pagesOf = (
  threads: ChatThread[][],
  o: { settledCount?: number; next?: string | null } = {},
): InfiniteData<ChatThreadsResponse> => ({
  pages: threads.map((t, i) => ({
    threads: t,
    next: i < threads.length - 1 ? 'x' : (o.next ?? null),
    ...(i === 0 && o.settledCount !== undefined ? { settledCount: o.settledCount } : {}),
  })),
  pageParams: threads.map(() => undefined),
});

describe('the lines (AP-6153, AP-6154)', () => {
  it('says when a thread was settled, and how one settled by itself', () => {
    const now = SEED_NOW;
    expect(settledWhen(person(at('09:20')), now, SEED_TIME_ZONE)).toBe('Settled 2 hours ago');
    expect(settledWhen(person(at('18:00', -1)), now, SEED_TIME_ZONE)).toBe('Settled yesterday');
    expect(settledRowLine(person(at('18:00', -1)), now, SEED_TIME_ZONE)).toBe('Settled yesterday');
    expect(settledRowLine({ at: at('10:00', -4), how: 'quiet' }, now, SEED_TIME_ZONE)).toContain(
      '3 quiet days',
    );
    expect(settledRowLine({ at: at('10:00', -4), how: 'quiet' }, now, SEED_TIME_ZONE, 1)).toContain(
      'a quiet day',
    );
    expect(settledRowLine({ at: at('10:00', -4), how: 'quiet' }, now, SEED_TIME_ZONE, 7)).toContain(
      'a quiet week',
    );
    expect(settledRowLine({ at: at('10:00', -4), how: 'merged' }, now, SEED_TIME_ZONE)).toContain(
      'pull request',
    );
    expect(settledRowLine({ at: at('10:00', -4), how: 'resolved' }, now, SEED_TIME_ZONE)).toContain(
      'problem went away',
    );
  });

  it('names the assistant in Profile’s note', () => {
    expect(SETTLE_COPY.note({ Name: 'Dusty' })).toContain('Dusty is still working');
  });
});

describe('what a thread offers (CS-03)', () => {
  it('settles an open thread, opens a settled one again, and offers nothing while it works, waits or work goes on', () => {
    expect(settleOffer({})).toBe('settle');
    expect(settleOffer({ settled: person(at('09:00')) })).toBe('open_again');
    expect(settleOffer({ working: true })).toBeNull();
    expect(settleOffer({ waiting: true })).toBeNull();
    // Work handed over from it goes on (T3 Code, a council, a delegation): the server would refuse it.
    expect(settleOffer({ handedOver: true })).toBeNull();
    // A settled thread can always come back.
    expect(settleOffer({ settled: person(at('09:00')), waiting: true })).toBe('open_again');
  });

  it('puts Settle thread or Open again first in a room’s long-press menu, never in a thread or on a reply', () => {
    const viewer = { id: mara.id, kind: 'person' as const };
    const features = { edit: true, pins: true };
    const open = root('msg_a', at('09:00'), 'Why is pve-02 slow?');
    const kinds = (m: Message, inThread = false, offer = settleOffer) =>
      messageMenu(m, viewer, {
        inThread,
        features,
        settle: (x) => offer({ settled: x.settled }),
      })?.actions.map((a) => a.kind);
    expect(kinds(open)?.[0]).toBe('settle');
    expect(kinds({ ...open, settled: person(at('10:00')) })?.[0]).toBe('open_again');
    expect(kinds(open, true)).not.toContain('settle');
    expect(kinds({ ...open, threadRootId: 'msg_root' })).not.toContain('settle');
    expect(kinds(open, false, () => null)).not.toContain('settle');
    expect(messageMenu(open, viewer, { inThread: false, features })?.actions[0]?.kind).toBe('reply_thread');
  });

  it('swipes a room’s thread to Settle or Open again with More, only More while it works or waits', () => {
    const viewer = { id: mara.id, kind: 'person' as const };
    const open = root('msg_a', at('09:00'), 'Why is pve-02 slow?');
    const swipe = (m: Message, roomTop = true, offer = settleOffer) =>
      messageSwipe(
        messageMenu(m, viewer, {
          inThread: false,
          features: { edit: true, pins: true },
          settle: (x) => offer({ settled: x.settled }),
        }),
        roomTop,
      );
    expect(swipe(open)).toBe('settle');
    expect(swipe({ ...open, settled: person(at('10:00')) })).toBe('open_again');
    expect(swipe(open, true, () => null)).toBe('more');
    // Not in a thread or a pull request's room, nor on a message still on its way.
    expect(swipe(open, false)).toBeNull();
    expect(swipe({ ...open, id: 'msg_local-1' })).toBeNull();
  });
});

describe('Settled (AP-6252)', () => {
  it('lists settled rows only, the latest settled first', () => {
    const shelf = settledShelf([
      thread('a', at('08:00'), { settled: person(at('09:00', -2)) }),
      thread('b', at('11:00')),
      thread('c', at('07:00'), { settled: person(at('10:00')) }),
    ]);
    expect(shelf.map((t) => t.rootId)).toEqual(['c', 'a']);
  });
});

describe('Chat and Feedback without their settled threads (AP-6251)', () => {
  const ctx = worldContext();
  const items = (messages: Message[]) => chatItems(messages, ctx, { authors: true, everyAuthor: true });
  const room = [
    root(
      'msg_1',
      at('20:00', -1),
      'Is the Zonneplan integration still doing anything?',
      person(at('21:00', -1)),
    ),
    root('msg_2', at('20:30', -1), 'Renew the certificate on the NAS', person(at('21:10', -1))),
    root('msg_3', at('07:00'), 'Last night’s backups ran.', person(at('07:30'))),
    root('msg_4', at('09:00'), 'Why is pve-02 using so much memory?'),
    root('msg_5', at('09:30'), 'Close the old issue', person(at('10:00'))),
  ];

  it('leaves settled threads out, a day of only settled ones without its divider', () => {
    const all = items(room);
    const today = all.find((i) => i.id === 'msg_3')?.day;
    const shown = withoutSettledItems(all);
    expect(shown.map((i) => i.id)).toEqual(['msg_4']);
    // Today's divider moves from the settled first thread to the next one shown.
    expect(shown[0]?.day).toBe(today);
  });

  it('moves the “New” line to the next thread shown', () => {
    const marked = items(room).map((i) => (i.id === 'msg_2' ? { ...i, unread: true } : i));
    expect(withoutSettledItems(marked)[0]).toMatchObject({ id: 'msg_4', unread: true });
  });

  it('keeps the thread a link opens at, and leaves a room without settled threads alone', () => {
    expect(withoutSettledItems(items(room), 'msg_5').map((i) => i.id)).toEqual(['msg_4', 'msg_5']);
    const plain = items(room.slice(3, 4));
    expect(withoutSettledItems(plain)).toBe(plain);
  });

  it('leaves nothing out inside a thread', () => {
    const inThread = chatItems(room.slice(0, 1), ctx, { authors: true, threads: false });
    expect(inThread[0]?.settled).toBe(false);
  });
});

describe('Profile → CHAT (AP-6156)', () => {
  it('reads the defaults, and turns a choice or the switch into the whole `chat` to save', () => {
    const p = chatPreferencesOf({});
    expect(p).toEqual(DEFAULT_CHAT_PREFERENCES);
    const never = withQuietDays(p, null);
    expect(never).toEqual({ settleQuietDays: null, settleMerged: true });
    expect(withQuietDays(never, 7).settleQuietDays).toBe(7);
    expect(withMergedSwitch(p, false)).toEqual({ settleQuietDays: 3, settleMerged: false });
  });
});

describe('the cache after a settle (AP-6158)', () => {
  const settle = person(at('11:20'));

  it('marks only the thread’s first message', () => {
    const m = root('msg_a', at('09:00'), 'Hi');
    expect(messageWithSettle(m, 'msg_a', settle).settled).toEqual(settle);
    expect(messageWithSettle(m, 'msg_b', settle)).toBe(m);
    const settledOne = messageWithSettle(m, 'msg_a', settle);
    expect(messageWithSettle(settledOne, 'msg_a', { ...settle })).toBe(settledOne);
    expect(messageWithSettle(settledOne, 'msg_a', null).settled).toBeNull();
  });

  it('marks the row in a list of every thread', () => {
    const data = pagesOf([[thread('a', at('11:00')), thread('b', at('10:00'))]]);
    const next = threadsWithSettle(data, undefined, { rootId: 'b', settled: settle, delta: 1 });
    expect(next?.pages[0]?.threads.map((t) => t.settled ?? null)).toEqual([null, settle]);
  });

  it('takes a settled thread out of the open list and onto the shelf, with the count', () => {
    const t = thread('b', at('10:00'));
    const open = pagesOf([[thread('a', at('11:00')), t]], { settledCount: 4 });
    const shelf = pagesOf([[thread('z', at('08:00'), { settled: person(at('09:00')) })]], {
      settledCount: 4,
    });
    const change = { rootId: 'b', settled: settle, thread: t, delta: 1 as const };
    const afterOpen = threadsWithSettle(open, 'open', change);
    expect(afterOpen?.pages[0]?.threads.map((x) => x.rootId)).toEqual(['a']);
    expect(afterOpen?.pages[0]?.settledCount).toBe(5);
    const afterShelf = threadsWithSettle(shelf, 'settled', change);
    expect(afterShelf?.pages[0]?.threads.map((x) => [x.rootId, x.settled?.at])).toEqual([
      ['b', settle.at],
      ['z', at('09:00')],
    ]);
    expect(afterShelf?.pages[0]?.settledCount).toBe(5);
  });

  it('puts a thread opened again back where its last activity is, and off the shelf', () => {
    const t = thread('b', at('10:00'), { settled: settle });
    const open = pagesOf([[thread('a', at('11:00')), thread('c', at('09:00'))]], { settledCount: 1 });
    const change = { rootId: 'b', settled: null, thread: t, delta: -1 as const };
    const back = threadsWithSettle(open, 'open', change);
    expect(back?.pages[0]?.threads.map((x) => x.rootId)).toEqual(['a', 'b', 'c']);
    expect(back?.pages[0]?.threads[1]?.settled).toBeNull();
    expect(back?.pages[0]?.settledCount).toBe(0);
    const shelf = pagesOf([[t]], { settledCount: 1 });
    expect(threadsWithSettle(shelf, 'settled', change)?.pages[0]?.threads).toEqual([]);
  });

  it('leaves a thread older than what an open list has loaded to its next read', () => {
    const open = pagesOf([[thread('a', at('11:00'))]], { next: at('11:00') });
    const t = thread('b', at('09:00'));
    expect(threadsWithSettle(open, 'open', { rootId: 'b', settled: null, thread: t, delta: 0 })).toBeNull();
    // Without the thread itself, a list by state that should take it is read again too.
    expect(threadsWithSettle(open, 'open', { rootId: 'b', settled: null, delta: 0 })).toBeNull();
  });

  it('changes nothing it doesn’t have to', () => {
    const data = pagesOf([[thread('a', at('11:00'))]]);
    expect(threadsWithSettle(data, 'open', { rootId: 'x', settled: settle, delta: 0 })).toBe(data);
    expect(threadsWithSettle(data, undefined, { rootId: 'x', settled: settle, delta: 0 })).toBe(data);
  });
});
