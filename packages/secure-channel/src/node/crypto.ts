import type { ICryptoInterface } from '@libp2p/noise';
import { defaultCrypto, nodeCrypto } from '@libp2p/noise/crypto';

/**
 * Noise primitives for the Node appliance: OpenSSL (`node:crypto`) for ChaCha20-Poly1305 at every message size,
 * SHA-256 and X25519, with HKDF from @noble/hashes. Built from @libp2p/noise's own `nodeCrypto` and the X25519
 * functions of its `defaultCrypto`, but without `defaultCrypto`'s routing of AEAD operations under 1200 bytes
 * (every handshake AEAD and small record) to `@chainsafe/as-chacha20poly1305@0.1.0`, which has no public audit,
 * a single release and a non-constant-time tag comparison (review L-7). Same algorithms and wire format as the
 * default `pureJsCrypto`.
 */
export const nodeNoiseCrypto: ICryptoInterface = {
  hashSHA256: nodeCrypto.hashSHA256,
  getHKDF: defaultCrypto.getHKDF,
  generateX25519KeyPair: defaultCrypto.generateX25519KeyPair,
  generateX25519KeyPairFromSeed: defaultCrypto.generateX25519KeyPairFromSeed,
  generateX25519SharedKey: defaultCrypto.generateX25519SharedKey,
  chaCha20Poly1305Encrypt: nodeCrypto.chaCha20Poly1305Encrypt,
  chaCha20Poly1305Decrypt: nodeCrypto.chaCha20Poly1305Decrypt,
};
