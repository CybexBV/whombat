import { describe, expect, it } from 'vitest';
import type { SecretStore } from './keys';
import { foregroundStore, secretPushStore } from './stores';

/** A keystore that refuses (locked, unavailable), as expo-secure-store can. */
const refusing: SecretStore = {
  get: () => Promise.reject(new Error('keystore unavailable')),
  set: () => Promise.reject(new Error('keystore unavailable')),
  remove: () => Promise.reject(new Error('keystore unavailable')),
};

describe('the phone’s push registration when the keystore refuses (AP-594)', () => {
  it('reads as none, never a rejection', async () => {
    await expect(secretPushStore(refusing).get()).resolves.toBeNull();
  });

  it('a registration that can’t be saved is refused, not pretended', async () => {
    const saved = {
      platform: 'fcm' as const,
      address: 't'.repeat(20),
      handle: 'h'.repeat(22),
      appliances: [],
    };
    await expect(secretPushStore(refusing).set(saved)).rejects.toThrow();
  });
});

/** The app's foreground as a test drives it: `come()` brings it back. */
function foreground(active: boolean) {
  let now = active;
  const waiting: (() => void)[] = [];
  return {
    active: () => now,
    next: () => (now ? Promise.resolve() : new Promise<void>((ok) => waiting.push(ok))),
    go: () => {
      now = false;
    },
    come: () => {
      now = true;
      for (const ok of waiting.splice(0)) ok();
    },
  };
}

/** A Keychain locked with the phone: it refuses while `locked` is true. */
function lockable(value: string | null) {
  const lock = { locked: true, reads: 0 };
  const store: SecretStore = {
    get: async () => {
      lock.reads++;
      if (lock.locked) throw new Error('errSecInteractionNotAllowed');
      return value;
    },
    set: async () => {
      if (lock.locked) throw new Error('errSecInteractionNotAllowed');
    },
    remove: async () => {
      if (lock.locked) throw new Error('errSecInteractionNotAllowed');
    },
  };
  return { lock, store };
}

describe('the keystore while the phone is locked', () => {
  it('a read refused in the background waits for the foreground, then reads the sign-in', async () => {
    const app = foreground(false);
    const { lock, store } = lockable('token');
    const read = foregroundStore(store, app).get('whombat.cloud-token');
    await Promise.resolve();
    expect(lock.reads).toBe(1);
    lock.locked = false;
    app.come();
    await expect(read).resolves.toBe('token');
    expect(lock.reads).toBe(2);
  });

  it('a refusal in the foreground is the store’s answer', async () => {
    const { store } = lockable('token');
    await expect(foregroundStore(store, foreground(true)).get('k')).rejects.toThrow();
  });

  it('a write refused in the background is made in the foreground', async () => {
    const app = foreground(false);
    const { lock, store } = lockable(null);
    const write = foregroundStore(store, app).set('k', 'v');
    lock.locked = false;
    app.come();
    await expect(write).resolves.toBeUndefined();
  });

  it('nothing changes while the store answers', async () => {
    const app = foreground(false);
    const { lock, store } = lockable(null);
    lock.locked = false;
    await expect(foregroundStore(store, app).get('k')).resolves.toBeNull();
  });
});
