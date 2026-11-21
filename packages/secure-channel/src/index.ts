export {
  type ByteStream,
  InboundQueue,
  type MemoryByteStreamOptions,
  memoryByteStreamPair,
} from './byte-stream.js';
export {
  acceptResponder,
  type ChannelLimits,
  type ConnectionStats,
  DEFAULT_PROLOGUE,
  FRAME_CEILING,
  INITIAL_WINDOW_BYTES,
  type InitiatorOptions,
  MAX_MESSAGE_BYTES,
  NOISE_MAX_FRAME_BYTES,
  openInitiator,
  RECORD_COST_OVERHEAD,
  type RekeyPolicy,
  type ResponderOptions,
  type SecureConnection,
} from './channel.js';
export * from './errors.js';
export {
  deserializeIdentity,
  fingerprint,
  generateIdentity,
  generateWebCryptoIdentity,
  type Identity,
  identityFromCryptoKeyPair,
  normalizeFingerprint,
  parsePeerId,
  peerIdFromEd25519PublicKey,
  serializeIdentity,
} from './identity.js';
export { isStrongEd25519PublicKey } from './identity-guard.js';
export { type KeyStore, loadOrCreateIdentity, MemoryKeyStore } from './keystore.js';
export { PINNED_DEPENDENCIES } from './pins.js';
export { assertSecureRandom } from './random.js';
export { type SecureByteStreamOptions, secureByteStream } from './secure-byte-stream.js';
export { type WebSocketByteStreamOptions, type WebSocketLike, webSocketByteStream } from './websocket.js';
