/**
 * This app's endpoint key (MA-03, secure-channel ADR SC-06): an Ed25519 identity generated on the phone
 * (`@whombat/secure-channel`, randomness from expo-crypto), stored with expo-secure-store — encrypted by the
 * Android Keystore / iOS Keychain, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`: not synced, not in backups. Hermes has no
 * WebCrypto, so the key is loaded into JS memory to sign the handshake (a hardware-held Ed25519 key would need a
 * native module; Android Keystore Ed25519 needs API 33+).
 */
import {
  deserializeIdentity,
  generateIdentity,
  type Identity,
  serializeIdentity,
} from '@whombat/secure-channel';

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const KEY = 'whombat.endpoint-key.v1';

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function loadOrCreateEndpointIdentity(store: SecretStore): Promise<Identity> {
  const saved = await store.get(KEY);
  if (saved) return deserializeIdentity(fromBase64(saved));
  const identity = await generateIdentity();
  await store.set(KEY, toBase64(serializeIdentity(identity)));
  return identity;
}

/** “Forget this phone”: every appliance treats it as a new device afterwards. */
export async function deleteEndpointIdentity(store: SecretStore): Promise<void> {
  await store.remove(KEY);
}
