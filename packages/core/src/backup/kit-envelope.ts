/**
 * The backup details locked with a passkey (docs/decisions/backup-options.md, backup-passkey.md): the passkey's WebAuthn
 * PRF output is the secret; HKDF-SHA256 turns it into an XChaCha20-Poly1305 key bound to one Whombat (`kitKeyFromPrf`,
 * info = its PeerId). The device that touched the passkey hands the Whombat that key, never the PRF output, and the
 * Whombat locks its own backup details with it (`sealKitWithKey`) after every backup and every move. Control and the
 * NAS keep only envelopes, which they can neither open nor forge; the person's passkey opens them on any device that has
 * it. Envelopes made on a device from the PRF output (`sealKit`) are the same `wbkit1.<nonce>.<ciphertext>`, and
 * `openKit` opens both. Pure (web and phone).
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { utf8Decode } from './bytes.js';

export const KIT_ENVELOPE_PREFIX = 'wbkit1';
export const KIT_PRF_SALT_BYTES = 32;
/** The length of a Whombat's backup key (`kitKeyFromPrf`). */
export const KIT_KEY_BYTES = 32;
const NONCE_BYTES = 24;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Base64url without padding (no `btoa`, which not every place core runs has). */
export function toBase64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += B64[c & 63];
  }
  return out;
}

/** Base64url (padding and the standard alphabet tolerated); null when it isn't. */
export function fromBase64url(text: string): Uint8Array | null {
  const clean = text.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (!/^[A-Za-z0-9_-]*$/.test(clean) || clean.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const ch of clean) {
    value = (value << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

/**
 * The PRF input every passkey touch asks for: SHA-256 of `whombat backup key 1`. It is constant so a sign-in, which
 * doesn't know the Whombat before the passkey names it, can ask for it in the same touch. An envelope still carries its
 * salt, so older ones made with a random salt (`newKitPrfSalt`) open as before.
 */
export const KIT_PRF_SALT_V2: Uint8Array = sha256(utf8ToBytes('whombat backup key 1'));
/** `KIT_PRF_SALT_V2` as base64url, the way envelopes and `backup.passkeyKey.set` carry it. */
export const KIT_PRF_SALT_V2_B64 = toBase64url(KIT_PRF_SALT_V2);

/** A new random PRF input (envelopes locked on a device before the constant salt; tests). */
export function newKitPrfSalt(): Uint8Array {
  return randomBytes(KIT_PRF_SALT_BYTES);
}

/**
 * A Whombat's backup key from a passkey's PRF output: HKDF-SHA256, info = the Whombat's PeerId, so the same passkey
 * gives every Whombat a key of its own. The device computes it and only this key goes to the Whombat.
 */
export function kitKeyFromPrf(prfOutput: Uint8Array, appliance: string): Uint8Array {
  if (prfOutput.length !== 32) throw new Error('kit_envelope.prf_length');
  return hkdf(
    sha256,
    prfOutput,
    utf8ToBytes('whombat kit envelope 1'),
    utf8ToBytes(appliance),
    KIT_KEY_BYTES,
  );
}

function aad(appliance: string): Uint8Array {
  return utf8ToBytes(`${KIT_ENVELOPE_PREFIX}:${appliance}`);
}

/** Locks text for one Whombat with its backup key (`kitKeyFromPrf`): `wbkit1.<nonce>.<ciphertext>`. */
export function sealKitWithKey(
  kitText: string,
  key: Uint8Array,
  appliance: string,
  nonce?: Uint8Array,
): string {
  if (key.length !== KIT_KEY_BYTES) throw new Error('kit_envelope.key_length');
  const n = nonce ?? randomBytes(NONCE_BYTES);
  if (n.length !== NONCE_BYTES) throw new Error('kit_envelope.nonce_length');
  const ct = xchacha20poly1305(key, n, aad(appliance)).encrypt(utf8ToBytes(kitText));
  return `${KIT_ENVELOPE_PREFIX}.${toBase64url(n)}.${toBase64url(ct)}`;
}

/** Locks the kit's text for one Whombat with a passkey's PRF output (the key derived on the spot). */
export function sealKit(
  kitText: string,
  prfOutput: Uint8Array,
  appliance: string,
  nonce?: Uint8Array,
): string {
  return sealKitWithKey(kitText, kitKeyFromPrf(prfOutput, appliance), appliance, nonce);
}

/** Opens an envelope with the Whombat's backup key; null when the key, the Whombat or the envelope don't match. */
export function openKitWithKey(envelope: string, key: Uint8Array, appliance: string): string | null {
  const parts = envelope.split('.');
  if (parts.length !== 3 || parts[0] !== KIT_ENVELOPE_PREFIX || key.length !== KIT_KEY_BYTES) return null;
  const n = fromBase64url(parts[1] ?? '');
  const ct = fromBase64url(parts[2] ?? '');
  if (!n || n.length !== NONCE_BYTES || !ct) return null;
  try {
    return utf8Decode(xchacha20poly1305(key, n, aad(appliance)).decrypt(ct));
  } catch {
    return null;
  }
}

/** Opens an envelope with the passkey's PRF output; null when this passkey's output, the Whombat or the envelope don't match. */
export function openKit(envelope: string, prfOutput: Uint8Array, appliance: string): string | null {
  return openKitWithKey(envelope, kitKeyFromPrf(prfOutput, appliance), appliance);
}

/* The copy next to the backups (the place's `kit` user) ---------------------------------------------------------- */

/**
 * The second user of every backup app Whombat installs, and its well-known password: it may only add files to its own
 * repository path, `/kit/`, and read them back. That is safe to publish because what it keeps opens only with the
 * person's passkey (the PRF output is 32 random bytes) and the app never lets anything be deleted or overwritten.
 */
export const PLACE_KIT_USER = 'kit';
export const PLACE_KIT_PASSWORD = 'whombat-kit';
/** How many envelope files a place's cleanup keeps for each Whombat (the newest). */
export const PLACE_KIT_KEEP = 10;
/** The largest envelope file a box writes or reads. */
export const PLACE_KIT_RECORD_MAX_BYTES = 65_536;

export const PLACE_KIT_RECORD_KIND = 'whombat.kit-envelope/1';

const B64URL = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);

/**
 * One envelope file on a place (`POST /kit/keys/<sha256 hex of the file>`): which Whombat, its name then, which passkey
 * locks it and with which salt, the envelope and the backup generation it was locked at. Read tolerantly (a newer box
 * may add members).
 */
export const PlaceKitRecord = z.object({
  kind: z.literal(PLACE_KIT_RECORD_KIND),
  /** The Whombat's content PeerId. */
  appliance: z.string().regex(/^12D3KooW[1-9A-HJ-NP-Za-km-z]{44}$/),
  /** As the person named it (up to 80, as control's names); null when the box had none. */
  applianceName: z.string().max(80).nullable(),
  credentialId: B64URL(512),
  salt: B64URL(64),
  envelope: z
    .string()
    .min(1)
    .max(60_000)
    .regex(/^wbkit1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  generation: z.number().int().min(0).max(1_000_000),
  createdAt: z.iso.datetime({ offset: true }),
});
export type PlaceKitRecord = z.infer<typeof PlaceKitRecord>;
