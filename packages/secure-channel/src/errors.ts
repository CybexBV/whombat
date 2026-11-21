/**
 * Typed, deterministic failures of the secure channel. Every error surfaced by this package is a
 * `SecureChannelError` with a stable `code`; the original library error (if any) is kept as `cause`.
 */
export type SecureChannelErrorCode =
  | 'PEER_MISMATCH'
  | 'HANDSHAKE_TIMEOUT'
  | 'HANDSHAKE_FAILED'
  | 'VERSION_MISMATCH'
  | 'EARLY_DATA'
  | 'DECRYPT_FAILED'
  | 'FRAME_TOO_LARGE'
  | 'PROTOCOL_ERROR'
  | 'TRUNCATED'
  | 'BUFFER_OVERFLOW'
  | 'REKEY_REQUIRED'
  | 'CLOSED'
  | 'TRANSPORT_ERROR'
  | 'NO_SECURE_RANDOM'
  | 'KEY_STORE';

export class SecureChannelError extends Error {
  readonly code: SecureChannelErrorCode;

  constructor(code: SecureChannelErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = 'SecureChannelError';
  }
}

/** The remote static identity is not the pinned appliance identity. Raised before any application byte. */
export class PeerMismatchError extends SecureChannelError {
  constructor(
    message = 'remote identity does not match the pinned appliance identity',
    options?: { cause?: unknown },
  ) {
    super('PEER_MISMATCH', message, options);
    this.name = 'PeerMismatchError';
  }
}

export class HandshakeTimeoutError extends SecureChannelError {
  constructor(timeoutMs: number) {
    super('HANDSHAKE_TIMEOUT', `handshake did not complete within ${timeoutMs} ms`);
    this.name = 'HandshakeTimeoutError';
  }
}

/** The Noise handshake failed (bad message, bad signature, transport ended mid-handshake). */
export class HandshakeFailedError extends SecureChannelError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('HANDSHAKE_FAILED', message, options);
    this.name = 'HandshakeFailedError';
  }
}

/**
 * The peer's first encrypted handshake message did not authenticate under our prologue: it speaks another
 * version of this protocol (e.g. `whombat-secure-session/1`, contracts ≤ 0.5.0) — or the relay tampered with that
 * message. Either way no session is possible; update the older side.
 */
export class VersionMismatchError extends SecureChannelError {
  constructor(expected: string, options?: { cause?: unknown }) {
    super(
      'VERSION_MISMATCH',
      `handshake failed at the first encrypted message: the peer does not speak ${expected} (version mismatch), or the handshake was tampered with`,
      options,
    );
    this.name = 'VersionMismatchError';
  }
}

/** The peer put data we do not accept (extensions, muxer offers) into the handshake payload. */
export class EarlyDataError extends SecureChannelError {
  constructor(message: string) {
    super('EARLY_DATA', message);
    this.name = 'EarlyDataError';
  }
}

/** Authenticated decryption of a transport frame failed: tampered, replayed, reordered or truncated frame. */
export class DecryptFailedError extends SecureChannelError {
  constructor(options?: { cause?: unknown }) {
    super('DECRYPT_FAILED', 'authenticated decryption failed', options);
    this.name = 'DecryptFailedError';
  }
}

export class FrameTooLargeError extends SecureChannelError {
  readonly size: number;
  readonly limit: number;

  constructor(size: number, limit: number, what = 'frame') {
    super('FRAME_TOO_LARGE', `${what} of ${size} bytes exceeds the limit of ${limit} bytes`);
    this.name = 'FrameTooLargeError';
    this.size = size;
    this.limit = limit;
  }
}

export class ProtocolError extends SecureChannelError {
  constructor(message: string) {
    super('PROTOCOL_ERROR', message);
    this.name = 'ProtocolError';
  }
}

/** The transport ended without an authenticated close record (possible truncation attack). */
export class TruncatedError extends SecureChannelError {
  constructor(message = 'transport ended without an authenticated close') {
    super('TRUNCATED', message);
    this.name = 'TruncatedError';
  }
}

export class BufferOverflowError extends SecureChannelError {
  constructor(message: string) {
    super('BUFFER_OVERFLOW', message);
    this.name = 'BufferOverflowError';
  }
}

/**
 * The connection reached its rekey threshold (message count, bytes or age). It refuses further sends; the
 * caller closes it and reconnects with a fresh handshake (fresh keys, fresh nonces).
 */
export class RekeyRequiredError extends SecureChannelError {
  readonly reason: 'messages' | 'bytes' | 'age';

  constructor(reason: 'messages' | 'bytes' | 'age') {
    super('REKEY_REQUIRED', `rekey required (${reason} limit reached); reconnect with a fresh handshake`);
    this.name = 'RekeyRequiredError';
    this.reason = reason;
  }
}

export class ClosedError extends SecureChannelError {
  constructor(message = 'connection is closed') {
    super('CLOSED', message);
    this.name = 'ClosedError';
  }
}

export class TransportError extends SecureChannelError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('TRANSPORT_ERROR', message, options);
    this.name = 'TransportError';
  }
}

export class NoSecureRandomError extends SecureChannelError {
  constructor() {
    super(
      'NO_SECURE_RANDOM',
      'globalThis.crypto.getRandomValues is not available; install a CSPRNG (e.g. expo-crypto / react-native-get-random-values) before using the secure channel',
    );
    this.name = 'NoSecureRandomError';
  }
}

export class KeyStoreError extends SecureChannelError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('KEY_STORE', message, options);
    this.name = 'KeyStoreError';
  }
}
