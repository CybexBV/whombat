/**
 * Key custody (DECISIONS D-06): every principal has an Ed25519 keypair; the server holds the secret key,
 * encrypted at rest with AES-256-GCM under `WHOMBAT_MASTER_KEY` (32 bytes, base64).
 *
 * Stored form: `v1:<base64(iv[12] | tag[16] | ciphertext)>`. The principal id is bound as additional
 * authenticated data, so a ciphertext copied onto another principal row does not decrypt.
 *
 * Development fallback: without `WHOMBAT_MASTER_KEY` (and outside production) a fixed, publicly known key
 * derived from `whombat/dev-master-key/v1` is used and a warning is logged. Never rely on it for real data.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { deriveSeedKeypair, fingerprintOf, generateKeypair, type Keypair, publicKeyOf } from '@whombat/core';

export const DEV_MASTER_KEY_CONTEXT = 'whombat/dev-master-key/v1';

export interface PrincipalKeys {
  publicKey: string;
  fingerprint: string;
  secretKeyEnc: string;
}

export class KeyCustody {
  private readonly key: Buffer;
  private readonly cache = new Map<string, string>();
  readonly usingDevKey: boolean;

  constructor(masterKeyBase64: string | undefined) {
    if (masterKeyBase64) {
      const key = Buffer.from(masterKeyBase64, 'base64');
      if (key.length !== 32) throw new Error('WHOMBAT_MASTER_KEY must be 32 bytes, base64-encoded');
      this.key = key;
      this.usingDevKey = false;
    } else {
      this.key = createHash('sha256').update(DEV_MASTER_KEY_CONTEXT).digest();
      this.usingDevKey = true;
    }
  }

  /** Encrypts a hex secret key for storage on `principalId`'s row. */
  encrypt(principalId: string, secretKeyHex: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(principalId, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(secretKeyHex, 'hex')), cipher.final()]);
    return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')}`;
  }

  /** Decrypts a stored secret key. Throws if the master key or principal binding is wrong. */
  decrypt(principalId: string, stored: string): string {
    const cached = this.cache.get(`${principalId}\u0000${stored}`);
    if (cached) return cached;
    if (!stored.startsWith('v1:')) throw new Error(`Unknown secret key format for ${principalId}`);
    const raw = Buffer.from(stored.slice(3), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(principalId, 'utf8'));
    decipher.setAuthTag(tag);
    const hex = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('hex');
    this.cache.set(`${principalId}\u0000${stored}`, hex);
    return hex;
  }

  /**
   * Keys for a new principal. `seed` makes them deterministic (`deriveSeedKeypair`) so seeded fingerprints are
   * stable; otherwise a fresh random keypair.
   */
  newPrincipalKeys(principalId: string, options: { seed?: string } = {}): PrincipalKeys {
    const pair: Keypair =
      options.seed !== undefined ? deriveSeedKeypair(principalId, options.seed) : generateKeypair();
    return this.wrap(principalId, pair);
  }

  wrap(principalId: string, pair: Keypair): PrincipalKeys {
    const publicKey = publicKeyOf(pair.secretKey);
    if (publicKey !== pair.publicKey) throw new Error('Keypair does not match');
    return {
      publicKey,
      fingerprint: fingerprintOf(publicKey),
      secretKeyEnc: this.encrypt(principalId, pair.secretKey),
    };
  }

  /**
   * Encrypts any other secret held at rest (connector app secrets, OAuth tokens: connectors/crypto.ts) in the
   * same `v1:` format, bound to `aad` so a ciphertext copied to another row or purpose does not decrypt.
   */
  seal(aad: string, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')}`;
  }

  /** Decrypts a `seal()`ed value. Throws when the master key or the `aad` binding is wrong. */
  open(aad: string, stored: string): string {
    if (!stored.startsWith('v1:')) throw new Error('Unknown sealed secret format');
    const raw = Buffer.from(stored.slice(3), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }

  /**
   * `seal` for bytes (a service's settings copy, outside-changes.md): AES-256-GCM under the master key, bound to `aad`,
   * as one buffer (`1`, IV, tag, ciphertext) for a `bytea` column.
   */
  sealBytes(aad: string, plain: Uint8Array): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
  }

  /** Decrypts a `sealBytes()`ed buffer. Throws when the master key or the `aad` binding is wrong. */
  openBytes(aad: string, stored: Uint8Array): Buffer {
    const raw = Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength);
    if (raw[0] !== 1 || raw.length < 29) throw new Error('Unknown sealed bytes format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(1, 13));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(raw.subarray(13, 29));
    return Buffer.concat([decipher.update(raw.subarray(29)), decipher.final()]);
  }

  /**
   * HMAC-SHA256 of `message` under a subkey of the master key bound to `purpose` (base64url). Lets the server
   * re-derive a secret it only stores the hash of (invite links: `commands/invite-links.ts`).
   */
  mac(purpose: string, message: string): string {
    const subkey = createHmac('sha256', this.key).update(`whombat/${purpose}`).digest();
    return createHmac('sha256', subkey).update(message, 'utf8').digest('base64url');
  }
}
