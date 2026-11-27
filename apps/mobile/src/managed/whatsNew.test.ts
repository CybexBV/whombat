/** “What’s new” on the phone: About's row and the one-time “Whombat updated” notice. */
import { readFileSync } from 'node:fs';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { WHATS_NEW_TEXT, whatsNewRefetchInterval, whatsNewSeenKey } from '@whombat/client/managed';
import type { ApplianceStatus } from '@whombat/client/session';
import { describe, expect, it, vi } from 'vitest';
import { type KeyValueStore, memoryStore } from '../lib/kv';
import {
  stripNotices,
  WHATS_NEW_ROW,
  WHATS_NEW_URL,
  watchStatusOnReopen,
  whatsNewToShow,
  whatsNewWatcher,
} from './whatsNew';

const WHOMBAT = 'wb-test-0001';
const KEY = whatsNewSeenKey(WHOMBAT);

/** When a release was installed: its day from its name (`pve-20260928.6` on 28 September), then its number. */
const installedAt = (release: string) =>
  release.replace(/^pve-(\d{4})(\d{2})(\d{2})\.(\d+)$/, '$1-$2-$3T12:0$4:00Z');

/** The release a store keeps as seen (it keeps when the release was installed beside it). */
function seenIn(store: { data: Map<string, string> }): string | undefined {
  const raw = store.data.get(KEY);
  if (raw === undefined) return undefined;
  try {
    return (JSON.parse(raw) as { release: string }).release;
  } catch {
    return raw;
  }
}

const status = (release: string | null): Pick<ApplianceStatus, 'update'> =>
  ({
    update: {
      state: 'Healthy',
      current: release ?? 'pve-20260901.1',
      candidate: null,
      lastCheckedAt: null,
      deferredReason: null,
      failure: null,
      ...(release && { lastUpdate: { release, from: 'pve-20260901.1', at: installedAt(release) } }),
    },
  }) as unknown as Pick<ApplianceStatus, 'update'>;

describe('About’s “What’s new” row', () => {
  it('opens the web app’s page with the shared words', () => {
    expect(WHATS_NEW_URL).toMatch(/^https:\/\/.+\/settings\/whats-new$/);
    expect(WHATS_NEW_ROW.title).toBe(WHATS_NEW_TEXT.link);
    expect(WHATS_NEW_ROW.body).toBe(WHATS_NEW_TEXT.linkMeta);
    expect(WHATS_NEW_ROW.label).toContain(WHATS_NEW_TEXT.link);
  });

  it('is in About, in the updates part', () => {
    const source = readFileSync(new URL('./WhombatAboutScreen.tsx', import.meta.url), 'utf8');
    const card = source.slice(source.indexOf('<VersionCard'), source.indexOf('</VersionCard>'));
    expect(card).toContain('title={WHATS_NEW_ROW.title}');
    expect(card).toContain('openSignInPage(WHATS_NEW_URL)');
  });
});

describe('the one-time “Whombat updated” notice', () => {
  it('shows once the last update differs from the release this phone saw, and only once', async () => {
    const store = memoryStore({ [KEY]: 'pve-20260927.1' });
    const shown: string[] = [];
    whatsNewWatcher(store, WHOMBAT, (r) => shown.push(r)).see(status('pve-20260928.6'));
    await vi.waitFor(() => expect(shown).toEqual(['pve-20260928.6']));
    // Kept as seen as soon as it shows: the app closed before Dismiss doesn't show it again.
    await vi.waitFor(async () =>
      expect(await whatsNewToShow(store, WHOMBAT, status('pve-20260928.6'))).toBeNull(),
    );
    expect(seenIn(store)).toBe('pve-20260928.6');
    // The next update shows it again.
    expect(await whatsNewToShow(store, WHOMBAT, status('pve-20261001.2'))).toBe('pve-20261001.2');
  });

  it('says nothing for the release already seen', async () => {
    const store = memoryStore({ [KEY]: 'pve-20260928.6' });
    expect(await whatsNewToShow(store, WHOMBAT, status('pve-20260928.6'))).toBeNull();
  });

  it('only remembers the release on the very first look', async () => {
    const store = memoryStore();
    expect(await whatsNewToShow(store, WHOMBAT, status('pve-20260928.6'))).toBeNull();
    expect(seenIn(store)).toBe('pve-20260928.6');
    expect(await whatsNewToShow(store, WHOMBAT, status('pve-20260928.6'))).toBeNull();
  });

  it('keeps what it saw per Whombat', async () => {
    const store = memoryStore({ [KEY]: 'pve-20260927.1' });
    expect(await whatsNewToShow(store, 'wb-other-0002', status('pve-20260928.6'))).toBeNull();
    expect(await whatsNewToShow(store, WHOMBAT, status('pve-20260928.6'))).toBe('pve-20260928.6');
  });

  it('shows nothing when the store can’t be read', async () => {
    const written: string[] = [];
    const broken: KeyValueStore = {
      get: () => Promise.reject(new Error('locked')),
      set: async (key) => {
        written.push(key);
      },
      remove: async () => {},
    };
    expect(await whatsNewToShow(broken, WHOMBAT, status('pve-20260928.6'))).toBeNull();
    expect(written).toEqual([]);
  });

  it('a newer release kept already: an older answer neither tells nor goes back to it', async () => {
    const store = memoryStore({
      [KEY]: JSON.stringify({ release: 'pve-20260928.6', at: installedAt('pve-20260928.6') }),
    });
    expect(await whatsNewToShow(store, WHOMBAT, status('pve-20260927.1'))).toBeNull();
    expect(seenIn(store)).toBe('pve-20260928.6');
  });

  it('asks for the status again each time the session opens after a drop, however fresh the last answer', async () => {
    let state = 'open';
    const listeners = new Set<(s: { status: string }) => void>();
    const session = {
      state: () => ({ status: state }),
      onState: (cb: (s: { status: string }) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    const move = (next: string) => {
      state = next;
      for (const cb of [...listeners]) cb({ status: state });
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let reads = 0;
    const queryKey = ['settings', 'appliance-status', 'scope'];
    const observer = new QueryObserver(client, {
      queryKey,
      queryFn: async () => ++reads,
      staleTime: 60_000,
    });
    const off = observer.subscribe(() => {});
    await vi.waitFor(() => expect(client.getQueryData(queryKey)).toBe(1));
    const watch = watchStatusOnReopen(session, client, queryKey);
    move('connecting');
    move('open');
    // The answer is seconds old, but the box was gone: asked again at once.
    await vi.waitFor(() => expect(client.getQueryData(queryKey)).toBe(2));
    expect(watch.backAt()).toBeGreaterThan(0);
    watch.stop();
    move('connecting');
    move('open');
    await Promise.resolve();
    expect(reads).toBe(2);
    off();
  });

  it('asks again soon when the first read on an open session fails or says nothing of updates', () => {
    const session = (status: string) => ({ state: () => ({ status }), onState: () => () => {} });
    const client = new QueryClient();
    const open = watchStatusOnReopen(session('open'), client, ['k']);
    const interval = whatsNewRefetchInterval(open.backAt);
    expect(interval({ state: { data: undefined, status: 'error' } })).toBe(5_000);
    expect(interval({ state: { data: { update: null }, status: 'success' } })).toBe(5_000);
    expect(interval({ state: { data: status('pve-20260928.6'), status: 'success' } })).toBe(false);
    open.stop();
    // Not open yet: the window starts when it opens.
    const later = watchStatusOnReopen(session('connecting'), client, ['k']);
    expect(later.backAt()).toBe(0);
    later.stop();
  });

  it('reads that overlap keep the newest update and tell of it once', async () => {
    const inner = memoryStore({
      [KEY]: JSON.stringify({ release: 'pve-20260927.1', at: installedAt('pve-20260927.1') }),
    });
    // The first write lands after the second, as a busy secure store may do.
    let writes = 0;
    const store: KeyValueStore = {
      get: (key) => inner.get(key),
      set: async (key, value) => {
        writes += 1;
        if (writes === 1) await new Promise((resolve) => setTimeout(resolve, 20));
        await inner.set(key, value);
      },
      remove: (key) => inner.remove(key),
    };
    const [first, second] = await Promise.all([
      whatsNewToShow(store, WHOMBAT, status('pve-20260928.6')),
      whatsNewToShow(store, WHOMBAT, status('pve-20260929.1')),
    ]);
    expect([first, second].filter(Boolean)).toEqual(expect.arrayContaining(['pve-20260928.6']));
    expect(seenIn(inner)).toBe('pve-20260929.1');
    // The older answer comes back to nothing: the newest is what is kept.
    expect(await whatsNewToShow(store, WHOMBAT, status('pve-20260928.6'))).toBeNull();
  });

  it('a store that can’t keep the release says nothing, so the notice doesn’t come back at every start', async () => {
    const inner = memoryStore({
      [KEY]: JSON.stringify({ release: 'pve-20260927.1', at: installedAt('pve-20260927.1') }),
    });
    const store: KeyValueStore = {
      get: (key) => inner.get(key),
      set: async () => {
        throw new Error('full');
      },
      remove: (key) => inner.remove(key),
    };
    expect(await whatsNewToShow(store, WHOMBAT, status('pve-20260928.6'))).toBeNull();
    expect(seenIn(inner)).toBe('pve-20260927.1');
  });

  it('a second answer for the same update while the first is still being kept still tells, once', async () => {
    const inner = memoryStore({
      [KEY]: JSON.stringify({ release: 'pve-20260927.1', at: installedAt('pve-20260927.1') }),
    });
    let release: (() => void) | null = null;
    const store: KeyValueStore = {
      get: (key) => inner.get(key),
      set: async (key, value) => {
        if (!release) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        await inner.set(key, value);
      },
      remove: (key) => inner.remove(key),
    };
    const shown: string[] = [];
    const watcher = whatsNewWatcher(store, WHOMBAT, (r) => shown.push(r));
    watcher.see(status('pve-20260928.6'));
    await vi.waitFor(() => expect(release).not.toBeNull());
    // The status is asked again (a refresh) while the first answer is still being kept.
    watcher.see(status('pve-20260928.6'));
    (release as unknown as () => void)();
    await vi.waitFor(() => expect(shown).toEqual(['pve-20260928.6']));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shown).toEqual(['pve-20260928.6']);
    // Stopped (the app moved to another Whombat): a late answer shows nothing.
    const later: string[] = [];
    const gone = whatsNewWatcher(memoryStore({ [KEY]: inner.data.get(KEY) ?? '' }), WHOMBAT, (r) =>
      later.push(r),
    );
    gone.see(status('pve-20260929.1'));
    gone.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(later).toEqual([]);
  });

  it('a watcher stopped while it reads (the app moved to another Whombat) keeps nothing, so coming back tells', async () => {
    const kept = JSON.stringify({ release: 'pve-20260927.1', at: installedAt('pve-20260927.1') });
    const inner = memoryStore({ [KEY]: kept });
    let answer: (() => void) | null = null;
    const store: KeyValueStore = {
      get: async (key) => {
        await new Promise<void>((resolve) => {
          answer = resolve;
        });
        return inner.get(key);
      },
      set: (key, value) => inner.set(key, value),
      remove: (key) => inner.remove(key),
    };
    const shown: string[] = [];
    const watcher = whatsNewWatcher(store, WHOMBAT, (r) => shown.push(r));
    watcher.see(status('pve-20260928.6'));
    await vi.waitFor(() => expect(answer).not.toBeNull());
    watcher.stop();
    (answer as unknown as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shown).toEqual([]);
    expect(inner.data.get(KEY)).toBe(kept);
  });

  it('a watcher stopped while it keeps the update leaves the notice for the next one of that Whombat', async () => {
    const inner = memoryStore({
      [KEY]: JSON.stringify({ release: 'pve-20260927.1', at: installedAt('pve-20260927.1') }),
    });
    let done: (() => void) | null = null;
    const store: KeyValueStore = {
      get: (key) => inner.get(key),
      set: async (key, value) => {
        if (!done) {
          await new Promise<void>((resolve) => {
            done = resolve;
          });
        }
        await inner.set(key, value);
      },
      remove: (key) => inner.remove(key),
    };
    const first: string[] = [];
    const watcher = whatsNewWatcher(store, WHOMBAT, (r) => first.push(r));
    watcher.see(status('pve-20260928.6'));
    await vi.waitFor(() => expect(done).not.toBeNull());
    // The app moves to another Whombat while the release is being kept.
    watcher.stop();
    (done as unknown as () => void)();
    await vi.waitFor(() => expect(seenIn(inner)).toBe('pve-20260928.6'));
    expect(first).toEqual([]);
    // Back on this Whombat: the notice nobody saw shows now, once.
    const back: string[] = [];
    const again = whatsNewWatcher(store, WHOMBAT, (r) => back.push(r));
    again.see(status('pve-20260928.6'));
    await vi.waitFor(() => expect(back).toEqual(['pve-20260928.6']));
    again.see(status('pve-20260928.6'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(back).toEqual(['pve-20260928.6']);
  });

  it('an update kept but never shown (the app moved on or closed first) shows on the next start, then never again', async () => {
    const store = memoryStore({
      [KEY]: JSON.stringify({ release: 'pve-20260927.1', at: installedAt('pve-20260927.1') }),
    });
    // Kept, but the app closed (or moved to another Whombat) before anything showed it.
    expect(await whatsNewToShow(store, WHOMBAT, status('pve-20260928.6'))).toBe('pve-20260928.6');
    expect(seenIn(store)).toBe('pve-20260928.6');
    // The next start: it still tells, and once shown it is told.
    const shown: string[] = [];
    const watcher = whatsNewWatcher(store, WHOMBAT, (r) => shown.push(r));
    watcher.see(status('pve-20260928.6'));
    await vi.waitFor(() => expect(shown).toEqual(['pve-20260928.6']));
    watcher.see(status('pve-20260928.6'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shown).toEqual(['pve-20260928.6']);
    const restarted: string[] = [];
    whatsNewWatcher(store, WHOMBAT, (r) => restarted.push(r)).see(status('pve-20260928.6'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(restarted).toEqual([]);
  });

  it('is drawn in the strip with the passkey nudge, never waiting for it', () => {
    expect(stripNotices({ open: true, nudge: true, whatsNew: true })).toEqual({
      nudge: true,
      whatsNew: true,
    });
    expect(stripNotices({ open: true, nudge: false, whatsNew: true })).toEqual({
      nudge: false,
      whatsNew: true,
    });
    expect(stripNotices({ open: false, nudge: true, whatsNew: true })).toEqual({
      nudge: false,
      whatsNew: false,
    });
  });
});
