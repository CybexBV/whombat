import {
  generateKeyPair,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
  publicKeyFromRaw,
} from '@libp2p/crypto/keys';
import type { Ed25519PrivateKey, Ed25519PublicKey, PeerId } from '@libp2p/interface';
import { peerIdFromPublicKey, peerIdFromString } from '@libp2p/peer-id';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { KeyStoreError, PeerMismatchError } from './errors.js';
import { isStrongEd25519PublicKey } from './identity-guard.js';
import { assertSecureRandom } from './random.js';

/**
 * WebCrypto's key pair, the DOM's `CryptoKeyPair` spelled out: the server and the CLI compile this file from source
 * without the DOM library, where only `CryptoKey` is global.
 */
type CryptoKeyPair = { publicKey: CryptoKey; privateKey: CryptoKey };

/**
 * An Ed25519 identity: the static identity of one end of a Noise session (appliance content identity or a
 * client endpoint key). `privateKey` is a libp2p key object; it signs the Noise static key during the
 * handshake. For WebCrypto-backed identities it is non-extractable and `extractable` is false.
 */
export interface Identity {
  readonly privateKey: Ed25519PrivateKey;
  /** Raw 32-byte Ed25519 public key. */
  readonly publicKey: Uint8Array;
  /** libp2p PeerId string (base58btc identity multihash, `12D3KooW…`). */
  readonly peerId: string;
  /** Whether `serializeIdentity` can export the private key. */
  readonly extractable: boolean;
}

function fromPrivateKey(privateKey: Ed25519PrivateKey, extractable: boolean): Identity {
  const peerId = peerIdFromPublicKey(privateKey.publicKey).toString();
  return { privateKey, publicKey: privateKey.publicKey.raw, peerId, extractable };
}

/** Generate a fresh Ed25519 identity (software key; serializable for file or secure-store storage). */
export async function generateIdentity(): Promise<Identity> {
  assertSecureRandom();
  return fromPrivateKey(await generateKeyPair('Ed25519'), true);
}

/** Serialize for key storage: the libp2p protobuf private-key encoding (type + 64-byte seed||public). */
export function serializeIdentity(identity: Identity): Uint8Array {
  if (!identity.extractable)
    throw new KeyStoreError('identity is non-extractable (WebCrypto); store the CryptoKeyPair');
  return privateKeyToProtobuf(identity.privateKey);
}

export function deserializeIdentity(bytes: Uint8Array): Identity {
  let key: ReturnType<typeof privateKeyFromProtobuf>;
  try {
    key = privateKeyFromProtobuf(bytes);
  } catch (cause) {
    throw new KeyStoreError('stored identity is not a valid libp2p private key', { cause });
  }
  if (key.type !== 'Ed25519')
    throw new KeyStoreError(`stored identity has key type ${key.type}, expected Ed25519`);
  // The libp2p encoding stores seed || public key; the public half must be the one the seed derives (I-1).
  const derived = ed25519.getPublicKey(key.raw.subarray(0, 32));
  const stored = key.publicKey.raw;
  if (derived.length !== stored.length || derived.some((b, i) => b !== stored[i])) {
    throw new KeyStoreError('stored identity is corrupt: its public key does not match its private key');
  }
  return fromPrivateKey(key, true);
}

type WebCryptoSubtle = SubtleCrypto;

function subtle(): WebCryptoSubtle {
  const s = (globalThis as { crypto?: { subtle?: WebCryptoSubtle } }).crypto?.subtle;
  if (!s) throw new KeyStoreError('WebCrypto (crypto.subtle) is not available in this runtime');
  return s;
}

/**
 * Generate an Ed25519 identity whose private key lives in WebCrypto. With `extractable: false` (default)
 * the private key can sign but can never be read by script; persist the `CryptoKeyPair` itself (IndexedDB
 * stores CryptoKey objects by structured clone). Requires WebCrypto Ed25519 (Chromium 137+, Firefox 129+,
 * Safari 17+, Node 24). Not available on Hermes.
 */
export async function generateWebCryptoIdentity(
  options: { extractable?: boolean } = {},
): Promise<{ identity: Identity; keyPair: CryptoKeyPair }> {
  assertSecureRandom();
  const extractable = options.extractable ?? false;
  // Node's typings have no Ed25519 overload of generateKey; WebCrypto answers it with a key pair.
  const keyPair = (await subtle().generateKey({ name: 'Ed25519' }, extractable, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  return { identity: await identityFromCryptoKeyPair(keyPair, { allowExtractable: extractable }), keyPair };
}

/**
 * Wrap a WebCrypto Ed25519 `CryptoKeyPair` (e.g. loaded from IndexedDB) as an `Identity`. Signing is done by
 * WebCrypto (`subtle.sign('Ed25519')`, RFC 8032, identical signatures to the software key); the private key is
 * never exported. An extractable private key is refused unless `allowExtractable` is set.
 */
export async function identityFromCryptoKeyPair(
  keyPair: CryptoKeyPair,
  options: { allowExtractable?: boolean } = {},
): Promise<Identity> {
  if (keyPair.privateKey.algorithm.name !== 'Ed25519')
    throw new KeyStoreError('CryptoKeyPair is not Ed25519');
  // An extractable private key can be read by any script on the origin: refuse unless asked for (review I-7).
  if (keyPair.privateKey.extractable && !options.allowExtractable) {
    throw new KeyStoreError('CryptoKeyPair private key is extractable; generate it with extractable: false');
  }
  const raw = new Uint8Array(await subtle().exportKey('raw', keyPair.publicKey));
  const publicKey = publicKeyFromRaw(raw);
  if (publicKey.type !== 'Ed25519') throw new KeyStoreError('CryptoKeyPair public key is not Ed25519');
  const cryptoKey = keyPair.privateKey;
  const privateKey: Ed25519PrivateKey = {
    type: 'Ed25519',
    publicKey: publicKey as Ed25519PublicKey,
    get raw(): Uint8Array {
      throw new KeyStoreError('WebCrypto identity private key is not exportable');
    },
    equals(other?: unknown): boolean {
      return other === privateKey;
    },
    async sign(data): Promise<Uint8Array> {
      const bytes = data instanceof Uint8Array ? data : data.subarray();
      const sig = await subtle().sign({ name: 'Ed25519' }, cryptoKey, bytes as Uint8Array<ArrayBuffer>);
      return new Uint8Array(sig);
    },
  };
  return fromPrivateKey(privateKey, false);
}

/** Parse and validate a PeerId string; only Ed25519 identities are accepted. */
export function parsePeerId(peerId: string): PeerId {
  let parsed: PeerId;
  try {
    parsed = peerIdFromString(peerId);
  } catch (cause) {
    throw new PeerMismatchError(`invalid PeerId: ${peerId}`, { cause });
  }
  if (parsed.type !== 'Ed25519') throw new PeerMismatchError(`PeerId ${peerId} is not an Ed25519 identity`);
  if (!parsed.publicKey || !isStrongEd25519PublicKey(parsed.publicKey.raw)) {
    throw new PeerMismatchError(`PeerId ${peerId} is a weak (small-order or non-canonical) key`);
  }
  return parsed;
}

/** PeerId string for a raw 32-byte Ed25519 public key. */
export function peerIdFromEd25519PublicKey(raw: Uint8Array): string {
  const key = publicKeyFromRaw(raw);
  if (key.type !== 'Ed25519') throw new PeerMismatchError('not an Ed25519 public key');
  return peerIdFromPublicKey(key).toString();
}

const FINGERPRINT_LABEL = new TextEncoder().encode('whombat-peer-fingerprint/1\0');
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** 5 groups × 5 base32 characters = 125 bits. */
const FINGERPRINT_CHARS = 25;

/**
 * Short human-verifiable fingerprint of a PeerId for claim cards: the first 125 bits of
 * SHA-256("whombat-peer-fingerprint/1\0" || PeerId multihash bytes), RFC 4648 base32, as
 * `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. 125 bits keeps a second-preimage (forging a key with a given
 * fingerprint) far out of reach even across millions of devices.
 */
export function fingerprint(peerId: string): string {
  const id = parsePeerId(peerId).toMultihash().bytes;
  const input = new Uint8Array(FINGERPRINT_LABEL.length + id.length);
  input.set(FINGERPRINT_LABEL, 0);
  input.set(id, FINGERPRINT_LABEL.length);
  const digest = sha256(input);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < FINGERPRINT_CHARS) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
    if (out.length >= FINGERPRINT_CHARS) break;
  }
  return out.match(/.{5}/g)?.join('-') ?? out;
}

/** Normalize user input of a fingerprint: case, spaces, dashes, and digits commonly mistyped for letters. */
export function normalizeFingerprint(input: string): string {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/0/g, 'O')
    .replace(/1/g, 'I')
    .replace(/8/g, 'B');
  if (!/^[A-Z2-7]{25}$/.test(cleaned)) throw new PeerMismatchError('malformed fingerprint');
  return cleaned.match(/.{5}/g)?.join('-') ?? cleaned;
}
