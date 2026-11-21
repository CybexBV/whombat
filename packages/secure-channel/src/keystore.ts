import { KeyStoreError } from './errors.js';
import { deserializeIdentity, generateIdentity, type Identity, serializeIdentity } from './identity.js';

/**
 * Persistent storage for identities, keyed by a name such as `content` (appliance) or `endpoint`
 * (client). Implementations: `FileKeyStore` (Node, `@whombat/secure-channel/node`), `MemoryKeyStore` (tests).
 * Browser (IndexedDB + non-extractable WebCrypto) and Expo (expo-secure-store) stores are documented in
 * `docs/contracts/decisions/secure-channel.md` and implemented by the app.
 */
export interface KeyStore {
  get(name: string): Promise<Identity | undefined>;
  /** Store an identity. Must refuse to overwrite an existing different identity unless `replace` is set. */
  put(name: string, identity: Identity, options?: { replace?: boolean }): Promise<void>;
  delete(name: string): Promise<void>;
}

export function assertKeyName(name: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new KeyStoreError(`invalid key name: ${name}`);
}

/**
 * Load the named identity, or generate and store a new one. Safe against concurrent creators (another process
 * or task creating the same name): the store refuses to overwrite, and this returns what is stored, so every
 * caller ends up with the identity that is on disk.
 */
export async function loadOrCreateIdentity(store: KeyStore, name: string): Promise<Identity> {
  const existing = await store.get(name);
  if (existing) return existing;
  const identity = await generateIdentity();
  try {
    await store.put(name, identity);
  } catch (err) {
    const winner = await store.get(name);
    if (winner) return winner;
    throw err;
  }
  const stored = await store.get(name);
  if (!stored) throw new KeyStoreError(`identity ${name} was not stored`);
  return stored;
}

/** In-memory store holding serialized keys (tests, ephemeral processes). */
export class MemoryKeyStore implements KeyStore {
  private readonly keys = new Map<string, Uint8Array>();

  async get(name: string): Promise<Identity | undefined> {
    assertKeyName(name);
    const bytes = this.keys.get(name);
    return bytes ? deserializeIdentity(bytes) : undefined;
  }

  async put(name: string, identity: Identity, options: { replace?: boolean } = {}): Promise<void> {
    assertKeyName(name);
    const existing = this.keys.get(name);
    if (existing && !options.replace && deserializeIdentity(existing).peerId !== identity.peerId) {
      throw new KeyStoreError(`identity ${name} already exists`);
    }
    this.keys.set(name, serializeIdentity(identity));
  }

  async delete(name: string): Promise<void> {
    assertKeyName(name);
    this.keys.delete(name);
  }
}
