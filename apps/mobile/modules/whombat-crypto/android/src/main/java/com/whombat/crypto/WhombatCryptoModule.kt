package com.whombat.crypto

import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.sharedobjects.SharedObject
import java.security.MessageDigest
import java.security.Provider
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

private const val CHACHA20_POLY1305 = "ChaCha20/Poly1305/NoPadding"

/**
 * `WhombatCrypto` (Android): ChaCha20-Poly1305 from Android itself (android-slim.md AP-890) — `javax.crypto`, which is
 * Conscrypt on BoringSSL since Android 9 — for the Noise transport and the phone's sealed files. It replaces
 * react-native-quick-crypto (its own OpenSSL plus Nitro: ~10 MB of the APK) for the one cipher the app used it for.
 * SHA-256 (`MessageDigest`) hashes downloads and uploads, the same as the iPhone's module.
 *
 * Synchronous, like the Noise crypto interface: the bytes are copied in and out once per call (Uint8Array ↔ ByteArray).
 * `open` throws when the tag doesn't verify. The JavaScript side (`modules/whombat-crypto/index.ts`) only uses either
 * after a self-test against the pure-JS code; Android 8 and older have no ChaCha20 here (`isSupported` is false).
 */
class WhombatCryptoModule : Module() {
  /** The provider that has the cipher, looked up once (a fresh `Cipher` per call then skips the provider search). */
  private val provider: Provider? by lazy {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) null
    else runCatching { Cipher.getInstance(CHACHA20_POLY1305).provider }.getOrNull()
  }

  /** A new cipher per call: a reused one may refuse the same key and nonce twice (the self-test does exactly that). */
  private fun cipher(mode: Int, key: ByteArray, nonce: ByteArray, ad: ByteArray): Cipher {
    val p = provider ?: throw UnsupportedOperationException("No ChaCha20-Poly1305 on this Android.")
    return Cipher.getInstance(CHACHA20_POLY1305, p).apply {
      init(mode, SecretKeySpec(key, "ChaCha20"), IvParameterSpec(nonce))
      if (ad.isNotEmpty()) updateAAD(ad)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("WhombatCrypto")

    Function("isSupported") { provider != null }

    /** Ciphertext followed by the 16-byte tag. */
    Function("chaCha20Poly1305Seal") { key: ByteArray, nonce: ByteArray, ad: ByteArray, plaintext: ByteArray ->
      cipher(Cipher.ENCRYPT_MODE, key, nonce, ad).doFinal(plaintext)
    }

    /** The plaintext of ciphertext + tag; throws (`AEADBadTagException`) when it was tampered with. */
    Function("chaCha20Poly1305Open") { key: ByteArray, nonce: ByteArray, ad: ByteArray, sealed: ByteArray ->
      cipher(Cipher.DECRYPT_MODE, key, nonce, ad).doFinal(sealed)
    }

    /** A running SHA-256: a download's bytes go in frame by frame, the digest comes out once at the end. */
    Class(Sha256Hasher::class) {
      Constructor { Sha256Hasher() }

      Function("update") { hasher: Sha256Hasher, data: ByteArray -> hasher.digest.update(data) }

      Function("digest") { hasher: Sha256Hasher -> hasher.digest.digest() }
    }
  }
}

class Sha256Hasher : SharedObject() {
  val digest: MessageDigest = MessageDigest.getInstance("SHA-256")
}
