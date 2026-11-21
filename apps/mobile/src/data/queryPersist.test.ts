/** The last-seen burrow kept between launches (AP-717): what is kept, and for whom. */
import { defaultCrypto } from '@libp2p/noise/crypto';
import { QueryClient, QueryObserver } from '@tanstack/query-core';
import { describe, expect, it, vi } from 'vitest';
import {
  createQueryPersister,
  KEPT_CONVERSATIONS,
  MAX_AGE_MS,
  MAX_CHARS,
  type PersistedQueries,
  QUERY_CACHE_NAME,
  SAVE_EVERY_MS,
  shouldPersistQuery,
  snapshotJson,
  usableSnapshot,
} from './queryPersist';
import { type BoxCrypto, createSecureBox, memoryBoxDeps } from './secureBox';

const key = (id: string, params: object = { burrow: 'burrow-hq' }, query: object = {}) => [
  'whombat',
  id,
  params,
  query,
];

function snapshotQueries(qc: QueryClient, account: string | null, now: number): PersistedQueries | null {
  const json = snapshotJson(qc, account, now);
  return json === null ? null : (JSON.parse(json) as PersistedQueries);
}

function seeded() {
  const qc = new QueryClient();
  qc.setQueryData(key('notifications.inbox'), { sections: [{ items: [{ id: 'nt_1' }] }] });
  qc.setQueryData(key('conversations.bootstrap'), { sidebar: { channels: [] } });
  qc.setQueryData(key('agent.get'), { agent: { handle: 'neo' } });
  qc.setQueryData(key('vault.list'), { entries: [{ id: 've_1', name: 'Stripe' }] });
  qc.setQueryData(key('signins.list'), { signins: [] });
  qc.setQueryData([...key('messages.list', { burrow: 'burrow-hq', conversationId: 'cv_1' }), 'infinite'], {
    pages: [
      { messages: [{ id: 'msg_2' }, { id: 'msg_local-abc', clientId: 'abc' }] },
      { messages: [{ id: 'msg_1' }] },
    ],
    pageParams: [undefined, 'msg_2'],
  });
  return qc;
}

describe('the last-seen burrow (AP-717)', () => {
  it('keeps the inbox, sidebar, conversations and the agent — nothing from the Vault or sign-ins', () => {
    const snap = snapshotQueries(seeded(), 'org/dev/acc/1', 1000);
    const ids = snap?.state.queries.map((q) => q.queryKey[1]).sort();
    expect(ids).toEqual(['agent.get', 'conversations.bootstrap', 'messages.list', 'notifications.inbox']);
    expect(JSON.stringify(snap)).not.toContain('Stripe');
  });

  it('keeps a conversation’s newest page, without messages still on their way', () => {
    const snap = snapshotQueries(seeded(), 'acc', 1000);
    const list = snap?.state.queries.find((q) => q.queryKey[1] === 'messages.list');
    // As JSON keeps it: the first page's param (undefined) is null.
    expect(list?.state.data).toEqual({ pages: [{ messages: [{ id: 'msg_2' }] }], pageParams: [null] });
  });

  it('keeps only reads with an answer', () => {
    expect(shouldPersistQuery({ queryKey: key('agent.get'), state: { status: 'error' } } as never)).toBe(
      false,
    );
    expect(shouldPersistQuery({ queryKey: ['other'], state: { status: 'success' } } as never)).toBe(false);
  });

  it('keeps a read whose refresh failed while live updates kept it current, as an answer', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(key('conversations.bootstrap'), { sidebar: { channels: ['general'] } });
    await qc
      .fetchQuery({
        queryKey: key('conversations.bootstrap'),
        queryFn: () => Promise.reject(new Error('lost')),
      })
      .catch(() => {});
    expect(qc.getQueryState(key('conversations.bootstrap'))?.status).toBe('error');
    const kept = snapshotQueries(qc, 'acc', 1000)?.state.queries.find(
      (q) => q.queryKey[1] === 'conversations.bootstrap',
    );
    expect(kept?.state).toMatchObject({
      status: 'success',
      error: null,
      data: { sidebar: { channels: ['general'] } },
    });
  });

  it('shows no copy older than a week, or of another format', () => {
    const snap = snapshotQueries(seeded(), 'acc', 0);
    expect(usableSnapshot(snap, MAX_AGE_MS - 1)).toBe(snap);
    expect(usableSnapshot(snap, MAX_AGE_MS)).toBeNull();
    expect(usableSnapshot({ ...(snap as NonNullable<typeof snap>), v: 2 as 1 }, 1)).toBeNull();
  });

  it('saves only once the session said whose data it is, and restores it on the next launch', async () => {
    const deps = memoryBoxDeps(defaultCrypto as unknown as BoxCrypto);
    const box = createSecureBox(deps);
    let account: string | null = null;
    const qc = seeded();
    const persister = createQueryPersister({ qc, box, scope: 'managed:org/dev', account: () => account });
    await persister.flush();
    expect(deps.stored.size).toBe(0);
    account = 'org/dev/acc_1/3';
    await persister.flush();
    expect(deps.stored.size).toBe(1);

    const next = new QueryClient();
    const again = createQueryPersister({ qc: next, box, scope: 'managed:org/dev', account: () => null });
    expect(await again.restore()).toBe('org/dev/acc_1/3');
    expect(next.getQueryData(key('agent.get'))).toEqual({ agent: { handle: 'neo' } });
    expect(next.getQueryData(key('vault.list'))).toBeUndefined();
    // Another Whombat on this phone has none.
    const other = createQueryPersister({
      qc: new QueryClient(),
      box,
      scope: 'managed:org/dev_2',
      account: () => null,
    });
    expect(await other.restore()).toBeNull();
    expect(await box.load('managed:org/dev', QUERY_CACHE_NAME)).not.toBeNull();
  });

  it('saves after a change, at most once per interval, and not after stop', async () => {
    const box = createSecureBox(memoryBoxDeps(defaultCrypto as unknown as BoxCrypto));
    const qc = new QueryClient();
    const persister = createQueryPersister({ qc, box, scope: 's', account: () => 'acc', throttleMs: 5 });
    const stop = persister.start();
    qc.setQueryData(key('agent.get'), { agent: null });
    qc.setQueryData(key('vault.list'), { entries: [] });
    await new Promise((ok) => setTimeout(ok, 30));
    expect(await box.load('s', QUERY_CACHE_NAME)).toMatchObject({ account: 'acc' });
    stop();
    await box.wipe();
    qc.setQueryData(key('agent.get'), { agent: { handle: 'x' } });
    await new Promise((ok) => setTimeout(ok, 30));
    expect(await box.load('s', QUERY_CACHE_NAME)).toBeNull();
  });

  it('saves realtime’s changes at most once a minute; going to the background saves at once (AP-928)', async () => {
    vi.useFakeTimers();
    try {
      const deps = memoryBoxDeps(defaultCrypto as unknown as BoxCrypto);
      const box = createSecureBox(deps);
      const saves = vi.spyOn(box, 'saveJson');
      const qc = new QueryClient();
      const persister = createQueryPersister({ qc, box, scope: 's', account: () => 'acc' });
      const stop = persister.start();
      for (let i = 0; i < 20; i++) {
        qc.setQueryData(key('agent.get'), { agent: { handle: `a${i}` } });
        await vi.advanceTimersByTimeAsync(2000);
      }
      expect(saves).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(SAVE_EVERY_MS - 40_000);
      expect(saves).toHaveBeenCalledTimes(1);
      qc.setQueryData(key('agent.get'), { agent: { handle: 'last' } });
      await persister.flush();
      expect(saves).toHaveBeenCalledTimes(2);
      expect(await box.load('s', QUERY_CACHE_NAME)).toMatchObject({
        state: { queries: [{ state: { data: { agent: { handle: 'last' } } } }] },
      });
      // The flush took the pending save's place.
      await vi.advanceTimersByTimeAsync(SAVE_EVERY_MS);
      expect(saves).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes each read once and leaves the cached data as it is (AP-929)', () => {
    const qc = seeded();
    const before = qc.getQueryData(key('agent.get'));
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      snapshotJson(qc, 'acc', 1);
      // One per read (4), the copy's own fields and its (empty) mutations: never the whole copy again.
      expect(stringify).toHaveBeenCalledTimes(6);
    } finally {
      stringify.mockRestore();
    }
    expect(qc.getQueryData(key('agent.get'))).toBe(before);
    const list = qc.getQueryData<{ pages: { messages: { id: string }[] }[] }>([
      ...key('messages.list', { burrow: 'burrow-hq', conversationId: 'cv_1' }),
      'infinite',
    ]);
    expect(list?.pages[0]?.messages.map((m) => m.id)).toEqual(['msg_2', 'msg_local-abc']);
  });

  it('too large: the least important conversations go first; still too large: not kept', () => {
    const qc = seeded();
    const conversation = { burrow: 'burrow-hq', conversationId: 'cv_2' };
    qc.setQueryData([...key('messages.list', conversation), 'infinite'], {
      pages: [{ messages: [{ id: 'msg_big', text: 'x'.repeat(MAX_CHARS) }] }],
      pageParams: [undefined],
    });
    // cv_1 is on screen, so the large cv_2 is the one left out.
    const shown = new QueryObserver(qc, {
      queryKey: [...key('messages.list', { burrow: 'burrow-hq', conversationId: 'cv_1' }), 'infinite'],
      enabled: false,
    }).subscribe(() => {});
    const lean = snapshotQueries(qc, 'acc', 1);
    shown();
    expect(conversationsOf(lean)).toEqual(['cv_1']);
    qc.setQueryData(key('agent.get'), { agent: { handle: 'x'.repeat(MAX_CHARS) } });
    expect(snapshotJson(qc, 'acc', 1)).toBeNull();
  });

  it('keeps the conversations on screen and the most recent ones, not every one in the cache', () => {
    vi.useFakeTimers();
    try {
      const qc = new QueryClient();
      const total = KEPT_CONVERSATIONS + 3;
      for (let i = 0; i < total; i++) {
        vi.setSystemTime(1000 + i);
        qc.setQueryData([...key('messages.list', { burrow: 'b', conversationId: `cv_${i}` }), 'infinite'], {
          pages: [{ messages: [] }],
          pageParams: [undefined],
        });
      }
      // The oldest one is on screen.
      const off = new QueryObserver(qc, {
        queryKey: [...key('messages.list', { burrow: 'b', conversationId: 'cv_0' }), 'infinite'],
        enabled: false,
      }).subscribe(() => {});
      const kept = conversationsOf(snapshotQueries(qc, 'acc', 1));
      off();
      expect(kept).toHaveLength(KEPT_CONVERSATIONS);
      expect(kept).toContain('cv_0');
      expect(kept).toContain(`cv_${total - 1}`);
      expect(kept).not.toContain('cv_1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips a save when nothing kept changed, also after a restore', async () => {
    const box = createSecureBox(memoryBoxDeps(defaultCrypto as unknown as BoxCrypto));
    const qc = seeded();
    const persister = createQueryPersister({ qc, box, scope: 's', account: () => 'acc', throttleMs: 5 });
    const saves = vi.spyOn(box, 'saveJson');
    await persister.flush();
    await persister.flush();
    expect(saves).toHaveBeenCalledTimes(1);
    const stop = persister.start();
    // The same answer again (as a refetch that changed nothing brings it): the same data, no save.
    qc.setQueryData(key('agent.get'), (d: unknown) => d);
    await persister.flush();
    expect(saves).toHaveBeenCalledTimes(1);
    qc.setQueryData(key('agent.get'), { agent: { handle: 'trinity' } });
    await persister.flush();
    expect(saves).toHaveBeenCalledTimes(2);
    stop();

    const next = new QueryClient();
    const again = createQueryPersister({ qc: next, box, scope: 's', account: () => 'acc' });
    const nextSaves = vi.spyOn(box, 'saveJson');
    nextSaves.mockClear();
    expect(await again.restore()).toBe('acc');
    await again.flush();
    expect(nextSaves).not.toHaveBeenCalled();
  });
});

describe('a copy that can’t be kept or comes late', () => {
  it('too large to keep: the one on the phone goes, rather than opening every start', async () => {
    const box = createSecureBox(memoryBoxDeps(defaultCrypto as unknown as BoxCrypto));
    const qc = seeded();
    const persister = createQueryPersister({ qc, box, scope: 's', account: () => 'acc', throttleMs: 1 });
    await persister.flush();
    expect(await box.load('s', QUERY_CACHE_NAME)).not.toBeNull();
    const stop = persister.start();
    qc.setQueryData(key('agent.get'), { agent: { handle: 'x'.repeat(MAX_CHARS) } });
    await persister.flush();
    stop();
    expect(await box.load('s', QUERY_CACHE_NAME)).toBeNull();
  });

  it('read back after the first screen: a read answered or failed meanwhile keeps that', async () => {
    const box = createSecureBox(memoryBoxDeps(defaultCrypto as unknown as BoxCrypto));
    const old = seeded();
    await createQueryPersister({ qc: old, box, scope: 's', account: () => 'acc' }).flush();

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The bootstrap failed, the agent was answered, the inbox is still on its way.
    await qc
      .fetchQuery({
        queryKey: key('conversations.bootstrap'),
        queryFn: () => Promise.reject(new Error('lost')),
      })
      .catch(() => {});
    qc.setQueryData(key('agent.get'), { agent: { handle: 'fresh' } });
    let answer: (v: unknown) => void = () => {};
    const inbox = qc.fetchQuery({
      queryKey: key('notifications.inbox'),
      queryFn: () => new Promise((ok) => (answer = ok)),
    });
    expect(await createQueryPersister({ qc, box, scope: 's', account: () => null }).restore()).toBe('acc');
    expect(qc.getQueryState(key('conversations.bootstrap'))?.status).toBe('error');
    expect(qc.getQueryData(key('agent.get'))).toEqual({ agent: { handle: 'fresh' } });
    expect(qc.getQueryData(key('notifications.inbox'))).toEqual({ sections: [{ items: [{ id: 'nt_1' }] }] });
    answer({ sections: [] });
    await inbox;
    expect(qc.getQueryData(key('notifications.inbox'))).toEqual({ sections: [] });
  });
});

describe('a copy read back', () => {
  it('is owed a read however recently it was read before it was saved', async () => {
    const box = createSecureBox(memoryBoxDeps(defaultCrypto as unknown as BoxCrypto));
    // Saved a moment after it was read (live updates kept changing it): still the phone's copy, not an answer.
    await createQueryPersister({ qc: seeded(), box, scope: 's', account: () => 'acc' }).flush();
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60 * 60_000 } } });
    await createQueryPersister({ qc, box, scope: 's', account: () => null }).restore();
    const state = qc.getQueryState(key('notifications.inbox'));
    expect(state?.data).toEqual({ sections: [{ items: [{ id: 'nt_1' }] }] });
    expect(state?.isInvalidated).toBe(true);
    // A screen that shows it asks for it as it opens, even inside the stale time.
    const queryFn = vi.fn(() => Promise.resolve({ sections: [] }));
    const off = new QueryObserver(qc, { queryKey: key('notifications.inbox'), queryFn }).subscribe(() => {});
    await vi.waitFor(() => expect(qc.getQueryData(key('notifications.inbox'))).toEqual({ sections: [] }));
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(qc.getQueryState(key('notifications.inbox'))?.isInvalidated).toBe(false);
    off();
  });
});

describe('opening a conversation the copy left out', () => {
  it('makes the copy out of date', async () => {
    vi.useFakeTimers();
    try {
      const box = createSecureBox(memoryBoxDeps(defaultCrypto as unknown as BoxCrypto));
      const qc = new QueryClient();
      const listKey = (i: number) => [
        ...key('messages.list', { burrow: 'b', conversationId: `cv_${i}` }),
        'infinite',
      ];
      for (let i = 0; i <= KEPT_CONVERSATIONS; i++) {
        vi.setSystemTime(1000 + i);
        qc.setQueryData(listKey(i), { pages: [{ messages: [] }], pageParams: [undefined] });
      }
      const persister = createQueryPersister({ qc, box, scope: 's', account: () => 'acc' });
      const stop = persister.start();
      await persister.flush();
      const saves = vi.spyOn(box, 'saveJson');
      // The newest is kept already: opening it changes nothing; the oldest was left out.
      const a = new QueryObserver(qc, { queryKey: listKey(KEPT_CONVERSATIONS), enabled: false }).subscribe(
        () => {},
      );
      await persister.flush();
      expect(saves).not.toHaveBeenCalled();
      const b = new QueryObserver(qc, { queryKey: listKey(0), enabled: false }).subscribe(() => {});
      await persister.flush();
      expect(saves).toHaveBeenCalledTimes(1);
      expect(conversationsOf(await box.load<PersistedQueries>('s', QUERY_CACHE_NAME))).toContain('cv_0');
      a();
      b();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

function conversationsOf(snap: PersistedQueries | null): string[] {
  return (snap?.state.queries ?? [])
    .filter((q) => q.queryKey[1] === 'messages.list')
    .map((q) => String((q.queryKey[2] as { conversationId: string }).conversationId))
    .sort();
}
