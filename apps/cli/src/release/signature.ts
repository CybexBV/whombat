/**
 * Signed releases (docs/decisions/bp-distribution.md BP-F20): `SHA256SUMS.sig` is the raw 64-byte Ed25519
 * signature of the exact bytes of `SHA256SUMS`, made by the project's release key (`pnpm bundle:runtime --sign-key`,
 * `pnpm --filter @whombat/package sign`), checked against the keys pinned in `keys.ts` (and any `--release-key`
 * given) by `sign --check`. The format is plain on purpose: anyone can
 * check it with OpenSSL, `openssl pkeyutl -verify -pubin -inkey whombat-release.pub.pem -rawin -in SHA256SUMS
 * -sigfile SHA256SUMS.sig`, before running any of it.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto';
import { readFileSync } from 'node:fs';

export const SUMS_SIG = 'SHA256SUMS.sig';

/** A release signing key: its raw 32-byte Ed25519 public key (base64) and a short id (sha256 prefix). */
export interface ReleaseKey {
  id: string;
  publicKey: string;
  /** Who holds it / what it is for (shown when a signature checks out). */
  note?: string;
}

/** The id of a raw public key: the first 16 hex digits of its sha256. */
export function releaseKeyId(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 16);
}

function keyObject(publicKey: string): KeyObject {
  const raw = Buffer.from(publicKey, 'base64');
  if (raw.length !== 32) throw new Error('an Ed25519 public key is 32 bytes');
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
    format: 'jwk',
  });
}

/** The raw public key (base64) of an Ed25519 key object (public or private). */
function rawPublicKey(key: KeyObject): string {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  if (pub.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key');
  const jwk = pub.export({ format: 'jwk' }) as { x?: string };
  return Buffer.from(jwk.x ?? '', 'base64url').toString('base64');
}

/**
 * A release key from a file: a PEM public key (`openssl pkey -pubout`), a PEM private key (its public half), or
 * one line of base64 (the raw 32 bytes, as pinned in keys.ts).
 */
export function readReleaseKey(path: string): ReleaseKey {
  const text = readFileSync(path, 'utf8').trim();
  let publicKey: string;
  try {
    if (text.includes('PRIVATE KEY')) publicKey = rawPublicKey(createPrivateKey(text));
    else if (text.includes('PUBLIC KEY')) publicKey = rawPublicKey(createPublicKey(text));
    else {
      keyObject(text);
      publicKey = Buffer.from(text, 'base64').toString('base64');
    }
  } catch (err) {
    throw new Error(`${path} isn’t an Ed25519 key (${(err as Error).message})`);
  }
  return { id: releaseKeyId(publicKey), publicKey, note: path };
}

/** Signs `sums` (the bytes of SHA256SUMS) with an Ed25519 private key in PEM (PKCS#8). */
export function signSums(sums: Buffer, privateKeyPem: string): Buffer {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the signing key isn’t an Ed25519 key');
  return sign(null, sums, key);
}

/** The key that signed `sums`, among `keys`, or null (another key, other bytes, or not a signature at all). */
export function verifySums(sums: Buffer, signature: Buffer, keys: readonly ReleaseKey[]): ReleaseKey | null {
  if (signature.length !== 64) return null;
  for (const key of keys) {
    try {
      if (verify(null, sums, keyObject(key.publicKey), signature)) return key;
    } catch {
      // a malformed pinned key can't have signed it
    }
  }
  return null;
}

/** A new signing key pair: the private key (PEM, PKCS#8), its public key (PEM, SPKI) and as pinned (base64). */
export function generateReleaseKey(): { privatePem: string; publicPem: string; key: ReleaseKey } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = rawPublicKey(publicKey);
  return {
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    key: { id: releaseKeyId(raw), publicKey: raw },
  };
}
