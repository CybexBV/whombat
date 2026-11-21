/**
 * `whombat-crypto` — ChaCha20-Poly1305 and SHA-256 from the phone's own system: on Android `javax.crypto` (Conscrypt on
 * BoringSSL, Android 9+) and `MessageDigest` through a small Kotlin module (`android/`, android-slim.md AP-890), on the
 * iPhone CryptoKit through a Swift one (`ios/`, docs/app/decisions/ios-crypto-speed.md). Without the module (tests) or
 * on Android 8 and older, `nativeChaCha20Poly1305()` is null and the app keeps the pure-JS cipher; without it
 * `nativeSha256()` is null and the pure-JS hash stays.
 */
import { requireOptionalNativeModule } from 'expo';

interface NativeHasher {
  update(data: Uint8Array): void;
  digest(): Uint8Array;
}

interface NativeWhombatCrypto {
  isSupported(): boolean;
  chaCha20Poly1305Seal(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  chaCha20Poly1305Open(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, sealed: Uint8Array): Uint8Array;
  /** Missing in a build made before the module had it. */
  Sha256Hasher?: new () => NativeHasher;
}

export interface NativeAead {
  /** Ciphertext followed by the 16-byte tag. */
  seal(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /** The plaintext; throws when the tag doesn't verify. */
  open(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, sealed: Uint8Array): Uint8Array;
}

/** A running SHA-256 (as `@noble/hashes`' `sha256.create()`): one per download or upload. */
export interface Sha256 {
  update(data: Uint8Array): Sha256;
  digest(): Uint8Array;
}

const native = requireOptionalNativeModule<NativeWhombatCrypto>('WhombatCrypto');

/** The module takes exactly a Uint8Array (a subclass such as Buffer isn't converted): a view on the same bytes. */
const plain = (b: Uint8Array): Uint8Array =>
  b.constructor === Uint8Array ? b : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

export function nativeChaCha20Poly1305(): NativeAead | null {
  try {
    if (!native?.isSupported()) return null;
  } catch {
    return null;
  }
  const m = native;
  return {
    seal: (key, nonce, ad, plaintext) =>
      m.chaCha20Poly1305Seal(plain(key), plain(nonce), plain(ad), plain(plaintext)),
    open: (key, nonce, ad, sealed) =>
      m.chaCha20Poly1305Open(plain(key), plain(nonce), plain(ad), plain(sealed)),
  };
}

/** A factory of native running hashes, or null without the module. */
export function nativeSha256(): (() => Sha256) | null {
  const Hasher = native?.Sha256Hasher;
  if (typeof Hasher !== 'function') return null;
  return () => {
    const h = new Hasher();
    const self: Sha256 = {
      update(data) {
        // An empty frame has nothing to hash; skipping it also spares the bridge a zero-length buffer.
        if (data.byteLength > 0) h.update(plain(data));
        return self;
      },
      digest: () => h.digest(),
    };
    return self;
  };
}
