/**
 * Where the managed app keeps things on the phone (AP-27):
 *
 * - the cloud session's bearer token and this install's push registration: expo-secure-store (Keystore/Keychain,
 *   this device only) — the token admits relay connections only, but is kept like a password;
 * - the appliance registry (metadata only: names, pinned identities, whether this phone is enrolled): a small JSON
 *   file in the app's documents, read once at start (`preloadedStorage`), so the shared registry's synchronous
 *   interface works unchanged;
 * - the endpoint key: `keys.ts` (secure store).
 */
import type { PushStore, SavedPush, SyncStorage, TokenStore } from '@whombat/client/managed';
import type { SecretStore } from './keys';

export const CLOUD_TOKEN_KEY = 'whombat.cloud-token';
export const PUSH_KEY = 'whombat.push';

export function secretTokenStore(store: SecretStore): TokenStore {
  return {
    get: () => store.get(CLOUD_TOKEN_KEY),
    set: (token) => store.set(CLOUD_TOKEN_KEY, token),
    remove: () => store.remove(CLOUD_TOKEN_KEY),
  };
}

export function secretPushStore(store: SecretStore): PushStore {
  return {
    async get() {
      // A keystore that refuses (locked, unavailable) reads as none (AP-594); writes still reject, never pretend.
      const raw = await store.get(PUSH_KEY).catch(() => null);
      if (!raw) return null;
      try {
        const v = JSON.parse(raw) as Partial<SavedPush>;
        return v.handle && v.address && v.platform
          ? { ...(v as SavedPush), appliances: Array.isArray(v.appliances) ? v.appliances : [] }
          : null;
      } catch {
        return null;
      }
    },
    set: (value) => store.set(PUSH_KEY, JSON.stringify(value)),
    remove: () => store.remove(PUSH_KEY),
  };
}

/** The app in the foreground: whether it is now, and the next time it is. */
export interface Foreground {
  active(): boolean;
  /** Resolves once the app is in the foreground (at once when it is). */
  next(): Promise<void>;
}

/**
 * The keystore as the app uses it: a call refused while the app isn't in the foreground is made again once it is. iOS
 * keeps these entries locked while the phone is, and the app still runs for a moment after the person locks it (a
 * reconnect, a list a push reloads); read then, the sign-in looked gone, so the app asked to sign in or control was
 * asked without it and answered “signed out”. In the foreground the phone is unlocked, so a refusal there is the
 * store's answer.
 */
export function foregroundStore(store: SecretStore, foreground: Foreground): SecretStore {
  async function call<T>(op: () => Promise<T>): Promise<T> {
    for (;;) {
      const here = foreground.active();
      try {
        return await op();
      } catch (error) {
        // Asked and refused in the foreground; asked away, it is asked again even when the app came back meanwhile.
        if (here && foreground.active()) throw error;
        await foreground.next();
      }
    }
  }
  return {
    get: (key) => call(() => store.get(key)),
    set: (key, value) => call(() => store.set(key, value)),
    remove: (key) => call(() => store.remove(key)),
  };
}

/** A text file the storage is kept in (`File.textSync` / `File.write` in the app; memory in tests). */
export interface TextFile {
  read(): string | null;
  write(text: string): void;
  remove(): void;
}

/**
 * A `Storage`-like map kept in one JSON file: read once, written on every change. Small and synchronous, like
 * the browser's local storage the registry was written for.
 */
export function preloadedStorage(file: TextFile): SyncStorage & { clear(): void } {
  let data: Record<string, string> = {};
  try {
    const raw = file.read();
    if (raw) data = JSON.parse(raw) as Record<string, string>;
  } catch {
    data = {};
  }
  const flush = () => {
    try {
      file.write(JSON.stringify(data));
    } catch {
      // The next change writes again.
    }
  };
  return {
    getItem: (key) => (Object.hasOwn(data, key) ? (data[key] ?? null) : null),
    setItem(key, value) {
      data[key] = String(value);
      flush();
    },
    removeItem(key) {
      delete data[key];
      flush();
    },
    clear() {
      data = {};
      try {
        file.remove();
      } catch {
        // already gone
      }
    },
  };
}
