/** “What’s new” on the phone: About's row and the one-time “Whombat updated” notice. */
import { readFileSync } from 'node:fs';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { WHATS_NEW_TEXT, whatsNewSeenKey } from '@whombat/client/managed';
import type { ApplianceStatus } from '@whombat/client/session';
import { describe, expect, it, vi } from 'vitest';
import { type KeyValueStore, memoryStore } from '../lib/kv';
import { stripNotices, WHATS_NEW_ROW, WHATS_NEW_URL, watchStatusOnReopen, whatsNewToShow } from './whatsNew';

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
    expect(WHATS_NEW_URL).toMatch(/^https:\/\/.+\/whats-new$/);
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
    expect(await whatsNewToShow(store, WHOMBAT, status('pve-20260928.6'))).toBe('pve-20260928.6');
    // Kept as seen as soon as it shows: the app closed before Dismiss doesn't show it again.
    expect(seenIn(store)).toBe('pve-20260928.6');
    expect(await whatsNewToShow(store, WHOMBAT, status('pve-20260928.6'))).toBeNull();
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
    expect(watch.backAt()).toBe(0);
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
