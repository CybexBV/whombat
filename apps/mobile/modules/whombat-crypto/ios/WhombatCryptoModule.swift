import CryptoKit
import ExpoModulesCore

private let tagLength = 16

/**
 * `WhombatCrypto` (iOS): ChaCha20-Poly1305 and SHA-256 from CryptoKit, the same functions and bytes as the Android
 * module, so the Noise transport, the phone's sealed files and the downloads' hashes stop running in JavaScript
 * (docs/app/decisions/ios-crypto-speed.md).
 *
 * Synchronous, like the Noise crypto interface: the bytes are copied in and out once per call (Uint8Array ↔ Data).
 * `open` throws when the tag doesn't verify. The JavaScript side (`modules/whombat-crypto/index.ts`) only uses either
 * after a self-test against the pure-JS code.
 */
public final class WhombatCryptoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WhombatCrypto")

    // CryptoKit is in every iOS the app runs on.
    Function("isSupported") { () -> Bool in true }

    /** Ciphertext followed by the 16-byte tag (CryptoKit's sealed box without its nonce). */
    Function("chaCha20Poly1305Seal") { (key: Data, nonce: Data, ad: Data, plaintext: Data) throws -> Data in
      let box = try ChaChaPoly.seal(
        plaintext, using: SymmetricKey(data: key), nonce: ChaChaPoly.Nonce(data: nonce), authenticating: ad)
      var out = Data(capacity: box.ciphertext.count + tagLength)
      out.append(box.ciphertext)
      out.append(box.tag)
      return out
    }

    /** The plaintext of ciphertext + tag; throws when it was tampered with. */
    Function("chaCha20Poly1305Open") { (key: Data, nonce: Data, ad: Data, sealed: Data) throws -> Data in
      guard sealed.count >= tagLength else { throw CryptoKitError.authenticationFailure }
      let box = try ChaChaPoly.SealedBox(
        nonce: ChaChaPoly.Nonce(data: nonce),
        ciphertext: sealed.prefix(sealed.count - tagLength),
        tag: sealed.suffix(tagLength))
      return try ChaChaPoly.open(box, using: SymmetricKey(data: key), authenticating: ad)
    }

    /** A running SHA-256: a download's bytes go in frame by frame, the digest comes out once at the end. */
    Class(Sha256Hasher.self) {
      Constructor { () -> Sha256Hasher in Sha256Hasher() }

      Function("update") { (hasher: Sha256Hasher, data: Data) in
        hasher.hash.update(data: data)
      }

      Function("digest") { (hasher: Sha256Hasher) -> Data in
        Data(hasher.hash.finalize())
      }
    }
  }
}

public final class Sha256Hasher: SharedObject {
  var hash = SHA256()
}
