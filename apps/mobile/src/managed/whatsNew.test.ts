/** “What’s new” on the phone: About's row and the one-time “Whombat updated” notice. */
import { readFileSync } from 'node:fs';
import { WHATS_NEW_TEXT, whatsNewSeenKey } from '@whombat/client/managed';
import type { ApplianceStatus } from '@whombat/client/session';
import { describe, expect, it } from 'vitest';
import { type KeyValueStore, memoryStore } from '../lib/kv';
import { WHATS_NEW_ROW, WHATS_NEW_URL, whatsNewToShow } from './whatsNew';

const WHOMBAT = 'wb-test-0001';
const KEY = whatsNewSeenKey(WHOMBAT);

const status = (release: string | null): Pick<ApplianceStatus, 'update'> =>
  ({
    update: {
      state: 'Healthy',
      current: release ?? 'pve-20260901.1',
      candidate: null,
      lastCheckedAt: null,
      deferredReason: null,
      failure: null,
      ...(release && { lastUpdate: { release, from: 'pve-20260901.1', at: '2026-09-29T12:00:00Z' } }),
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
    expect(store.data.get(KEY)).toBe('pve-20260928.6');
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
    expect(store.data.get(KEY)).toBe('pve-20260928.6');
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

  it('is drawn in the strip every screen shows, whether or not the passkey nudge is there', () => {
    const source = readFileSync(new URL('./ApplianceRoot.tsx', import.meta.url), 'utf8');
    const line = source.split('\n').find((l) => l.includes('<WhatsNewNoticeView notice={whatsNew} />'));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/nudge/);
  });
});
