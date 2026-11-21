/**
 * Encrypted local storage for what the phone keeps between launches (AP-717): the last-seen inbox, sidebar, conversations
 * and agents (`queryPersist.ts`) and messages waiting to send (`outbox.ts`). Data on the device is protected
 * (docs/privacy-and-security.md §9): every value is sealed with ChaCha20-Poly1305 under one random 256-bit key that lives
 * only in the platform keystore (expo-secure-store, this device only, never backed up); files hold ciphertext alone.
 *
 * Each value belongs to a storage scope (`managed:<org>/<Whombat>`, `server:<url>`) and a name. The file name is a hash
 * of both (no ids on disk) and both are the AEAD's associated data, so a file copied to another scope or name doesn't
 * open. `wipe()` deletes every file and the key (sign-out, switching Whombats, revocation): anything left behind can't
 * be read. A file that doesn't open (another key, damaged, an older format) is deleted and reads as nothing.
 *
 * Pure: the cipher, files, keystore and randomness are passed in (`secureBoxNative.ts` on the phone, memory in tests).
 */

/** The AEAD and hash, as `@libp2p/noise`'s `ICryptoInterface` has them (native ChaCha20-Poly1305 on the phone). */
export interface BoxCrypto {
  hashSHA256(data: Uint8Array): Uint8Array;
  chaCha20Poly1305Encrypt(
    plaintext: Uint8Array,
    nonce: Uint8Array,
    ad: Uint8Array,
    k: Uint8Array,
  ): Uint8Array | { subarray(): Uint8Array };
  chaCha20Poly1305Decrypt(
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    ad: Uint8Array,
    k: Uint8Array,
  ): Uint8Array | { subarray(): Uint8Array };
}

export interface BoxFiles {
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
  removeAll(): Promise<void>;
}

/** Where the key lives: one secure-store entry. */
export interface BoxKeyStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  remove(): Promise<void>;
}

export interface SecureBoxDeps {
  crypto: BoxCrypto;
  files: BoxFiles;
  keys: BoxKeyStore;
  random(length: number): Uint8Array;
}

export interface SecureBox {
  load<T>(scope: string, name: string): Promise<T | null>;
  save(scope: string, name: string, value: unknown): Promise<void>;
  /** `save` of a value already in JSON (the cached reads measure theirs first, AP-929). */
  saveJson(scope: string, name: string, json: string): Promise<void>;
  /**
   * Starts reading a value ahead (at start, while the fonts and the session load, AP-920): the next `load` of it takes
   * this read when it comes within `PREFETCH_KEEP_MS`. Saving, removing or wiping the value drops the read.
   */
  prefetch(scope: string, name: string): void;
  remove(scope: string, name: string): Promise<void>;
  /** Every value of every scope, and the key. */
  wipe(): Promise<void>;
}

const VERSION = 1;
const NONCE = 12;
/** A read ahead that no `load` took within this long is dropped. */
export const PREFETCH_KEEP_MS = 30_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const flat = (b: Uint8Array | { subarray(): Uint8Array }): Uint8Array =>
  b instanceof Uint8Array ? b : b.subarray();

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function unhex(text: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(text)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function createSecureBox(deps: SecureBoxDeps): SecureBox {
  const { crypto, files, keys } = deps;
  // The key, read once; a wipe forgets it (the next save makes a new one).
  let key: Promise<Uint8Array | null> | null = null;
  // Saves of one file run one after another, and a wipe waits for the writes before it.
  let chain: Promise<unknown> = Promise.resolve();
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => {});
    return next;
  };

  const readKey = () => {
    key ??= keys.get().then((k) => (k ? unhex(k) : null));
    return key;
  };
  const ensureKey = async (): Promise<Uint8Array> => {
    const k = await readKey();
    if (k) return k;
    const fresh = deps.random(32);
    await keys.set(hex(fresh));
    key = Promise.resolve(fresh);
    return fresh;
  };
  const fileName = (scope: string, name: string) =>
    `${hex(crypto.hashSHA256(enc.encode(`${scope}\n${name}`))).slice(0, 40)}.bin`;
  // Associated data: a hash of the format, scope and name (32 bytes, the most the AEAD binding takes).
  const ad = (scope: string, name: string) =>
    crypto.hashSHA256(enc.encode(`whombat-box/${VERSION}\n${scope}\n${name}`));

  const saveJson = (scope: string, name: string, json: string) =>
    queue(async () => {
      const k = await ensureKey();
      const nonce = deps.random(NONCE);
      const sealed = flat(crypto.chaCha20Poly1305Encrypt(enc.encode(json), nonce, ad(scope, name), k));
      const out = new Uint8Array(1 + NONCE + sealed.byteLength);
      out[0] = VERSION;
      out.set(nonce, 1);
      out.set(sealed, 1 + NONCE);
      await files.write(fileName(scope, name), out);
    });

  const read = async <T>(scope: string, name: string): Promise<T | null> => {
    await chain;
    const file = fileName(scope, name);
    const bytes = await files.read(file);
    if (!bytes) return null;
    const k = await readKey();
    try {
      if (!k || bytes[0] !== VERSION || bytes.byteLength < 1 + NONCE + 16) throw new Error('unreadable');
      const nonce = bytes.subarray(1, 1 + NONCE);
      const plain = flat(
        crypto.chaCha20Poly1305Decrypt(bytes.subarray(1 + NONCE), nonce, ad(scope, name), k),
      );
      return JSON.parse(dec.decode(plain)) as T;
    } catch {
      // Another key (after a wipe), damaged, or not ours: it can't ever be read, so it goes.
      await files.remove(file).catch(() => {});
      return null;
    }
  };

  // Reads started ahead, by file, until a `load` takes them (or a change makes them old).
  const ahead = new Map<string, { read: Promise<unknown>; timer: ReturnType<typeof setTimeout> }>();
  const drop = (file: string) => {
    const a = ahead.get(file);
    if (!a) return;
    clearTimeout(a.timer);
    ahead.delete(file);
  };

  return {
    load<T>(scope: string, name: string): Promise<T | null> {
      const file = fileName(scope, name);
      const a = ahead.get(file);
      if (!a) return read<T>(scope, name);
      drop(file);
      return a.read as Promise<T | null>;
    },
    save: (scope, name, value) => {
      drop(fileName(scope, name));
      return saveJson(scope, name, JSON.stringify(value));
    },
    saveJson: (scope, name, json) => {
      drop(fileName(scope, name));
      return saveJson(scope, name, json);
    },
    prefetch(scope, name) {
      const file = fileName(scope, name);
      if (ahead.has(file)) return;
      const timer = setTimeout(() => ahead.delete(file), PREFETCH_KEEP_MS);
      ahead.set(file, { read: read(scope, name).catch(() => null), timer });
    },
    remove(scope, name) {
      drop(fileName(scope, name));
      return queue(() => files.remove(fileName(scope, name)));
    },
    wipe() {
      for (const file of [...ahead.keys()]) drop(file);
      return queue(async () => {
        key = null;
        await Promise.all([files.removeAll(), keys.remove()]);
      });
    },
  };
}

/** A box in memory, for tests (its randomness is not random): same interface, nothing on disk. */
export function memoryBoxDeps(crypto: BoxCrypto): SecureBoxDeps & {
  stored: Map<string, Uint8Array>;
  keyValue: () => string | null;
} {
  const stored = new Map<string, Uint8Array>();
  let keyValue: string | null = null;
  let counter = 0;
  return {
    crypto,
    stored,
    keyValue: () => keyValue,
    files: {
      read: async (name) => stored.get(name) ?? null,
      write: async (name, bytes) => {
        stored.set(name, bytes);
      },
      remove: async (name) => {
        stored.delete(name);
      },
      removeAll: async () => stored.clear(),
    },
    keys: {
      get: async () => keyValue,
      set: async (v) => {
        keyValue = v;
      },
      remove: async () => {
        keyValue = null;
      },
    },
    random: (n) => new Uint8Array(n).map((_, i) => (i * 13 + ++counter * 7) % 256),
  };
}
