import { type InfiniteData, QueryClient } from '@tanstack/query-core';
import {
  api,
  type ChatThread,
  type ChatThreadsResponse,
  type MessagePage,
  type ThreadSettledHow,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { applyRealtimeEvent, applyThreadSettle, upsertMessageEverywhere } from '../query/apply';
import { infiniteEndpointKey, queryKeys } from '../query/keys';
import { message, t } from '../test/fixtures';
import {
  canSettle,
  settledLine,
  settledMeta,
  settleFinishedToast,
  shownUnreadFrom,
  threadPagesSettled,
  withoutSettled,
} from './settle';

const TZ = 'Europe/Amsterdam';
const NOW = Date.parse(t(0));
const settled = (minutes: number, how: ThreadSettledHow = 'person') => ({ at: t(minutes), how });

const thread = (rootId: string, o: Partial<ChatThread> = {}): ChatThread => ({
  conversationId: 'cnv_chat' as never,
  room: 'chat',
  rootId: rootId as never,
  authorId: 'prn_mara' as never,
  text: `About ${rootId}`,
  subject: null,
  createdAt: t(0),
  replyCount: 0,
  lastAt: t(0),
  working: false,
  ...o,
});

describe('the words (AP-6151…AP-6155)', () => {
  it('counts what Settle finished threads did', () => {
    expect(settleFinishedToast(0)).toBe('Nothing to settle.');
    expect(settleFinishedToast(1)).toBe('Settled 1 thread.');
    expect(settleFinishedToast(4)).toBe('Settled 4 threads.');
  });

  it('says when and how a thread settled', () => {
    expect(settledLine(t(-120), NOW, TZ)).toBe('Settled 2 hours ago');
    expect(settledLine(t(-24 * 60), NOW, TZ)).toBe('Settled yesterday');
    expect(settledLine(t(-60 * 24 * 40), NOW, TZ)).toMatch(/^Settled on \d+ \w+/);
    expect(settledMeta(settled(-120), NOW, TZ, 3)).toBe('Settled 2 hours ago');
    expect(settledMeta(settled(-120, 'quiet'), NOW, TZ, 5)).toContain('5 quiet days');
    // Turned off since: it settled after the default.
    expect(settledMeta(settled(-120, 'quiet'), NOW, TZ, null)).toContain('3 quiet days');
    expect(settledMeta(settled(-120, 'merged'), NOW, TZ, 3)).toContain('pull request merged');
    expect(settledMeta(settled(-120, 'resolved'), NOW, TZ, 3)).toContain('problem went away');
  });
});

describe('whether a thread may settle (CS-03)', () => {
  it('only an open thread nobody works on and that waits for nobody', () => {
    expect(canSettle(thread('msg_a'))).toBe(true);
    expect(canSettle(thread('msg_a', { working: true }))).toBe(false);
    expect(canSettle(thread('msg_a', { waiting: true }))).toBe(false);
    expect(canSettle(thread('msg_a', { settled: settled(0) }))).toBe(false);
    expect(canSettle(undefined)).toBe(false);
  });
});

describe('the room without its settled threads (AP-6251)', () => {
  const root = (id: string, s: ReturnType<typeof settled> | null = null) => message(id, { settled: s });
  const ids = (ms: readonly { id: string }[]) => ms.map((m) => m.id);

  it('leaves settled first messages out, in time order, and keeps the one a link points at', () => {
    const room = [root('a', settled(0)), root('b'), root('c', settled(1)), root('d')];
    expect(ids(withoutSettled(room))).toEqual(['b', 'd']);
    expect(ids(withoutSettled(room, 'c'))).toEqual(['b', 'c', 'd']);
  });

  it('keeps replies, messages still being sent, and the same array when nothing is settled', () => {
    const room = [
      message('r', { threadRootId: 'a' as never, settled: settled(0) }),
      message('msg_local-1', { settled: settled(0) }),
    ];
    expect(withoutSettled(room)).toBe(room);
  });

  it('moves the “New” line to the first message still shown after it', () => {
    const room = [root('a'), root('b', settled(0)), root('c', settled(1)), root('d')];
    const shown = withoutSettled(room);
    expect(shownUnreadFrom(room, shown, 'b')).toBe('d');
    expect(shownUnreadFrom(room, shown, 'a')).toBe('a');
    expect(shownUnreadFrom(room, withoutSettled(room.slice(0, 3)), 'b')).toBeNull();
    expect(shownUnreadFrom(room, room, 'b')).toBe('b');
  });
});

describe('a settle in a cached list (CS-10)', () => {
  const ids = (pages: ChatThread[][] | null) => pages?.map((p) => p.map((x) => x.rootId));

  it('changes the row in place in a list of every thread', () => {
    const pages = [[thread('msg_a'), thread('msg_b')]];
    const next = threadPagesSettled(pages, { rootId: 'msg_b', settled: settled(5) }, { room: 'chat' }, true);
    expect(next?.[0]?.[1]?.settled).toEqual(settled(5));
    expect(
      threadPagesSettled(next ?? [], { rootId: 'msg_b', settled: settled(5) }, { room: 'chat' }, true),
    ).toBe(next);
  });

  it('moves it out of the open list and into the settled one by when it settled, and back', () => {
    const open = [
      [
        thread('msg_a', { lastAt: t(9) }),
        thread('msg_b', { lastAt: t(5) }),
        thread('msg_c', { lastAt: t(1) }),
      ],
    ];
    const shelf = [[thread('msg_x', { settled: settled(8) }), thread('msg_y', { settled: settled(2) })]];
    const b = thread('msg_b', { lastAt: t(5) });
    const scope = (state: 'open' | 'settled') => ({ room: 'chat' as const, state });
    const settledB = { rootId: 'msg_b', settled: settled(4), thread: b };
    expect(ids(threadPagesSettled(open, settledB, scope('open'), true))).toEqual([['msg_a', 'msg_c']]);
    expect(ids(threadPagesSettled(shelf, settledB, scope('settled'), true))).toEqual([
      ['msg_x', 'msg_b', 'msg_y'],
    ]);
    const opened = { rootId: 'msg_b', settled: null, thread: b };
    const without = [[thread('msg_a', { lastAt: t(9) }), thread('msg_c', { lastAt: t(1) })]];
    expect(ids(threadPagesSettled(without, opened, scope('open'), true))).toEqual([
      ['msg_a', 'msg_b', 'msg_c'],
    ]);
    expect(ids(threadPagesSettled(shelf, { ...opened, rootId: 'msg_x' }, scope('settled'), true))).toEqual([
      ['msg_y'],
    ]);
  });

  it('leaves out a thread that belongs on a page not loaded, and asks again for one it doesn’t know', () => {
    const shelf = [[thread('msg_x', { settled: settled(8) })]];
    const old = { rootId: 'msg_old', settled: settled(1), thread: thread('msg_old') };
    expect(threadPagesSettled(shelf, old, { room: 'chat', state: 'settled' }, false)).toEqual(shelf);
    expect(ids(threadPagesSettled(shelf, old, { room: 'chat', state: 'settled' }, true))).toEqual([
      ['msg_x', 'msg_old'],
    ]);
    expect(
      threadPagesSettled(
        shelf,
        { rootId: 'msg_q', settled: settled(9) },
        { room: 'chat', state: 'settled' },
        true,
      ),
    ).toBeNull();
  });

  it('keeps a subject’s list to threads about it', () => {
    const about = {
      room: 'chat' as const,
      state: 'open' as const,
      subjectKind: 'server',
      subjectId: 'pve-02',
    };
    const pages = [[thread('msg_a')]];
    expect(
      threadPagesSettled(pages, { rootId: 'msg_b', settled: null, thread: thread('msg_b') }, about, true),
    ).toBe(pages);
  });
});

describe('a settle in every cached read (AP-6158)', () => {
  const burrow = 'burrow-hq';
  const key = (state?: 'open' | 'settled') =>
    infiniteEndpointKey(api.chats.threads, {
      params: { burrow },
      query: { room: 'chat', ...(state ? { state } : {}) },
    });
  const listKey = queryKeys.endpoint(api.messages.list, {
    params: { burrow, conversationId: 'cnv_chat' },
    query: {},
  });

  function world() {
    const qc = new QueryClient();
    qc.setQueryData<InfiniteData<ChatThreadsResponse>>(key('open'), {
      pages: [
        {
          threads: [thread('msg_a', { lastAt: t(9) }), thread('msg_b', { lastAt: t(5) })],
          next: null,
          settledCount: 3,
        },
      ],
      pageParams: [undefined],
    });
    qc.setQueryData<InfiniteData<ChatThreadsResponse>>(key('settled'), {
      pages: [{ threads: [thread('msg_x', { settled: settled(-60) })], next: null, settledCount: 3 }],
      pageParams: [undefined],
    });
    qc.setQueryData<MessagePage>(listKey, {
      messages: [
        message('msg_b', { conversationId: 'cnv_chat' as never }),
        message('msg_a', { conversationId: 'cnv_chat' as never }),
      ],
      hasMore: false,
      before: null,
    } as never);
    const open = () => qc.getQueryData<InfiniteData<ChatThreadsResponse>>(key('open'))?.pages[0];
    const shelf = () => qc.getQueryData<InfiniteData<ChatThreadsResponse>>(key('settled'))?.pages[0];
    const root = (id: string) => qc.getQueryData<MessagePage>(listKey)?.messages.find((m) => m.id === id);
    return { qc, open, shelf, root };
  }

  it('settles at once and the frame that follows changes nothing more', () => {
    const { qc, open, shelf, root } = world();
    applyThreadSettle(qc, { room: 'chat', rootId: 'msg_b', settled: settled(10) });
    expect(open()?.threads.map((x) => x.rootId)).toEqual(['msg_a']);
    expect(shelf()?.threads.map((x) => x.rootId)).toEqual(['msg_b', 'msg_x']);
    expect([open()?.settledCount, shelf()?.settledCount]).toEqual([4, 4]);
    expect(root('msg_b')?.settled).toEqual(settled(10));
    applyRealtimeEvent(qc, {
      type: 'chat.settled',
      conversationId: 'cnv_chat',
      room: 'chat',
      rootId: 'msg_b',
      settled: settled(10),
    } as never);
    expect([open()?.threads.length, shelf()?.threads.length, open()?.settledCount]).toEqual([1, 2, 4]);
  });

  it('opens it again from a frame (a new message in it, another device), the count down once', () => {
    const { qc, open, shelf } = world();
    applyThreadSettle(qc, { room: 'chat', rootId: 'msg_b', settled: settled(10) });
    const frame = {
      type: 'chat.settled',
      conversationId: 'cnv_chat',
      room: 'chat',
      rootId: 'msg_b',
      settled: null,
    };
    applyRealtimeEvent(qc, frame as never);
    applyRealtimeEvent(qc, frame as never);
    expect(open()?.threads.map((x) => x.rootId)).toEqual(['msg_a', 'msg_b']);
    expect(shelf()?.threads.map((x) => x.rootId)).toEqual(['msg_x']);
    expect(open()?.settledCount).toBe(3);
  });

  it('counts a settle only in a thing’s list the thread is about', () => {
    const { qc, open } = world();
    const about = (subjectId: string) =>
      infiniteEndpointKey(api.chats.threads, {
        params: { burrow },
        query: { room: 'chat', subjectKind: 'server', subjectId },
      });
    const subject = { kind: 'server' as const, id: 'pve-02', name: 'pve-02' };
    for (const id of ['pve-02', 'nas'])
      qc.setQueryData<InfiniteData<ChatThreadsResponse>>(about(id), {
        pages: [
          {
            threads: id === 'pve-02' ? [thread('msg_p', { subject, lastAt: t(7) })] : [],
            next: null,
            settledCount: 1,
          },
        ],
        pageParams: [undefined],
      });
    const count = (id: string) =>
      qc.getQueryData<InfiniteData<ChatThreadsResponse>>(about(id))?.pages[0]?.settledCount;
    // A thread about nothing: neither thing's “Settled” moves.
    applyThreadSettle(qc, { room: 'chat', rootId: 'msg_b', settled: settled(10) });
    expect([open()?.settledCount, count('pve-02'), count('nas')]).toEqual([4, 1, 1]);
    // A thread about pve-02: only its list's count moves.
    applyThreadSettle(qc, { room: 'chat', rootId: 'msg_p', settled: settled(11) });
    expect([count('pve-02'), count('nas')]).toEqual([2, 1]);
  });

  it('leaves a settled list alone for a reply: the frame opens the thread again', () => {
    const { qc, shelf } = world();
    upsertMessageEverywhere(
      qc,
      message('msg_r', {
        conversationId: 'cnv_chat' as never,
        threadRootId: 'msg_x' as never,
        createdAt: t(20),
      }),
    );
    upsertMessageEverywhere(
      qc,
      message('msg_new', { conversationId: 'cnv_chat' as never, createdAt: t(21) }),
    );
    expect(shelf()?.threads.map((x) => [x.rootId, x.replyCount])).toEqual([['msg_x', 0]]);
  });

  it('reads the room and its lists again when several threads changed at once', async () => {
    const { qc } = world();
    applyRealtimeEvent(qc, {
      type: 'chat.settled',
      conversationId: 'cnv_chat',
      room: 'chat',
      rootId: null,
      settled: null,
    } as never);
    expect(qc.getQueryState(key('open'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(listKey)?.isInvalidated).toBe(true);
  });
});
