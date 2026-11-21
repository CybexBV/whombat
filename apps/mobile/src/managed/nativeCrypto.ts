/**
 * Native ChaCha20-Poly1305 for the Noise transport on React Native (AP-26): the per-message AEAD — where Hermes'
 * pure-JS Noise spends its time — runs in the phone's own crypto through `modules/whombat-crypto`: Android's
 * `javax.crypto` (Conscrypt on BoringSSL, android-slim.md AP-890), the iPhone's CryptoKit
 * (docs/app/decisions/ios-crypto-speed.md). The handshake primitives (X25519, SHA-256, HKDF) stay the library's audited
 * pure-JS ones: they run a few times per connection.
 *
 * `selfTest()` checks the native AEAD against the pure-JS one both ways (and that a flipped bit fails) before the app
 * uses it; any failure keeps pure JS. `checkedNativeCrypto()` runs it once per process for the transport and the
 * phone's sealed files together (AP-891; each ran its own before). The native running SHA-256 that hashes downloads
 * and uploads is checked the same way (`checkedNativeSha256()`).
 */
import type { ICryptoInterface } from '@libp2p/noise';
import { defaultCrypto } from '@libp2p/noise/crypto';
import {
  type NativeAead,
  nativeChaCha20Poly1305,
  nativeSha256,
  type Sha256,
} from '../../modules/whombat-crypto';

type Bytes = Uint8Array | { subarray(): Uint8Array };

const flat = (b: Bytes): Uint8Array => (b instanceof Uint8Array ? b : b.subarray());

/** The Noise crypto with its AEAD from `aead`; everything else stays `base`'s. */
export function nativeNoiseCrypto(
  aead: NativeAead,
  base: ICryptoInterface = defaultCrypto,
): ICryptoInterface {
  return {
    ...base,
    chaCha20Poly1305Encrypt: (plaintext, nonce, ad, k) => aead.seal(k, nonce, ad, flat(plaintext as Bytes)),
    // Throws when the tag doesn't verify (the Noise layer turns it into a decrypt failure).
    chaCha20Poly1305Decrypt: (ciphertext, nonce, ad, k) => aead.open(k, nonce, ad, flat(ciphertext as Bytes)),
  };
}

/** Interop with the pure-JS AEAD, both directions, plus tamper rejection. */
export function selfTest(native: ICryptoInterface, pure: ICryptoInterface = defaultCrypto): string | null {
  try {
    const k = new Uint8Array(32).map((_, i) => i * 7 + 1);
    const nonce = new Uint8Array(12).map((_, i) => i + 3);
    const ad = new Uint8Array([1, 2, 3, 4]);
    // Several ChaCha blocks and Poly1305 chunks, unaligned; 4 KiB, not a full 65 kB frame: the pure-JS side of the check
    // cost ~40 ms of the first connection on the emulator (AP-891), and both ciphers stream the same way at any size.
    for (const size of [0, 1, 17, 4097]) {
      const pt = new Uint8Array(size).map((_, i) => (i * 31) % 256);
      const a = flat(native.chaCha20Poly1305Encrypt(pt, nonce, ad, k) as Bytes);
      const b = flat(pure.chaCha20Poly1305Encrypt(pt, nonce, ad, k) as Bytes);
      if (a.byteLength !== b.byteLength || a.some((x, i) => x !== b[i]))
        return `ciphertext differs at ${size}`;
      const back = flat(native.chaCha20Poly1305Decrypt(b, nonce, ad, k) as Bytes);
      if (back.byteLength !== size || back.some((x, i) => x !== pt[i])) return `decrypt differs at ${size}`;
    }
    const bad = flat(pure.chaCha20Poly1305Encrypt(new Uint8Array(40), nonce, ad, k) as Bytes).slice();
    bad[3] = (bad[3] ?? 0) ^ 1;
    try {
      native.chaCha20Poly1305Decrypt(bad, nonce, ad, k);
      return 'tampered ciphertext accepted';
    } catch {
      return null;
    }
  } catch (error) {
    return String((error as Error)?.message ?? error);
  }
}

let checked: ICryptoInterface | null | undefined;

/** The native AEAD once it passed `selfTest` (checked once per process), or null: pure JS then. */
export function checkedNativeCrypto(
  aead: () => NativeAead | null = nativeChaCha20Poly1305,
): ICryptoInterface | null {
  if (checked !== undefined) return checked;
  try {
    const native = aead();
    const crypto = native ? nativeNoiseCrypto(native) : null;
    checked = crypto && selfTest(crypto) === null ? crypto : null;
  } catch {
    checked = null;
  }
  return checked;
}

/** The running hash against the pure-JS SHA-256, fed whole and in uneven pieces; null when they agree. */
export function sha256SelfTest(
  create: () => Sha256,
  pure: (data: Uint8Array) => Uint8Array = defaultCrypto.hashSHA256,
): string | null {
  try {
    const same = (a: Uint8Array, b: Uint8Array) =>
      a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);
    // Around the 64-byte block edges, and a few blocks split off their boundaries.
    for (const size of [0, 1, 55, 56, 64, 65, 4097]) {
      const data = new Uint8Array(size).map((_, i) => (i * 29 + 7) % 256);
      const want = pure(data);
      if (!same(create().update(data).digest(), want)) return `hash differs at ${size}`;
      const h = create();
      for (let at = 0; at < size; at += 1000) h.update(data.subarray(at, Math.min(size, at + 1000)));
      if (!same(h.digest(), want)) return `pieces differ at ${size}`;
    }
    return null;
  } catch (error) {
    return String((error as Error)?.message ?? error);
  }
}

let checkedHash: (() => Sha256) | null | undefined;

/** The native running SHA-256 once it passed `sha256SelfTest` (checked once per process), or null: pure JS then. */
export function checkedNativeSha256(
  source: () => (() => Sha256) | null = nativeSha256,
): (() => Sha256) | null {
  if (checkedHash !== undefined) return checkedHash;
  try {
    const create = source();
    checkedHash = create && sha256SelfTest(create) === null ? create : null;
  } catch {
    checkedHash = null;
  }
  return checkedHash;
}

/** Tests only: forget the checked results. */
export function resetCheckedNativeCrypto(): void {
  checked = undefined;
  checkedHash = undefined;
}
