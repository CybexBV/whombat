import type {
  ConnectionEncrypter,
  MessageStream,
  StreamCloseEvent,
  StreamMessageEvent,
} from '@libp2p/interface';
import { type ICryptoInterface, type NoiseExtensions, noise, pureJsCrypto } from '@libp2p/noise';
import { peerIdFromString } from '@libp2p/peer-id';
import { Uint8ArrayList } from 'uint8arraylist';
import type { ByteStream } from './byte-stream.js';
import {
  BufferOverflowError,
  ClosedError,
  DecryptFailedError,
  EarlyDataError,
  FrameTooLargeError,
  HandshakeFailedError,
  HandshakeTimeoutError,
  PeerMismatchError,
  ProtocolError,
  RekeyRequiredError,
  SecureChannelError,
  TransportError,
  TruncatedError,
  VersionMismatchError,
} from './errors.js';
import { fingerprint, type Identity, normalizeFingerprint, parsePeerId } from './identity.js';
import { checkHandshakePayload, IdentityRejected } from './identity-guard.js';
import {
  ByteStreamMessageStream,
  flushWrites,
  silentComponentLogger,
  waitForDrain,
} from './message-stream.js';
import { assertSecureRandom } from './random.js';

/**
 * Noise prologue binding every handshake to this protocol version (mismatch = handshake failure,
 * `VERSION_MISMATCH`). `/1`: contracts ≤ 0.5.0 (records DATA and CLOSE). `/2`: contracts ≥ 0.5.1, adds the
 * WINDOW flow-control record. Peers of different versions never complete a handshake.
 */
export const DEFAULT_PROLOGUE = 'whombat-secure-session/2';

/** Largest Noise transport message (libp2p-noise: u16 length prefix). */
export const NOISE_MAX_FRAME_BYTES = 65_535;
/** ChaCha20-Poly1305 tag. */
const TAG_BYTES = 16;
/** Record header: u8 type + u32 BE length. */
const RECORD_HEADER_BYTES = 5;
/** Largest application message: one record fits one Noise transport message (65535 − 16 − 5). */
export const MAX_MESSAGE_BYTES = NOISE_MAX_FRAME_BYTES - TAG_BYTES - RECORD_HEADER_BYTES;

const RECORD_DATA = 0x00;
const RECORD_CLOSE = 0x01;
const RECORD_WINDOW = 0x02;

/**
 * Connection-level flow control (independent of the transport, so it also bounds memory where the WebSocket
 * cannot report or apply backpressure, e.g. React Native). Each side may send DATA records costing up to
 * `INITIAL_WINDOW_BYTES` before the peer grants more with WINDOW records; a DATA record costs its payload length
 * plus `RECORD_COST_OVERHEAD`. Receiving more than was granted is a protocol error.
 */
export const INITIAL_WINDOW_BYTES = 256 * 1024;
export const RECORD_COST_OVERHEAD = 64;
const MAX_WINDOW_BYTES = 64 * 1024 * 1024;

/**
 * Hard ceiling on transport AEAD operations per direction per connection. libp2p-noise uses a 32-bit
 * nonce counter (MAX_NONCE 2^32−1) and throws when it is exhausted; we require a rekey at half of that so the
 * library limit is never reached.
 */
export const FRAME_CEILING = 2 ** 31;

export interface RekeyPolicy {
  /** Application messages sent on one connection before `RekeyRequired`. Default 2^30. */
  maxMessages?: number;
  /** Application bytes sent on one connection before `RekeyRequired`. Default 2^40 (1 TiB). */
  maxBytes?: number;
  /** Connection age before `RekeyRequired` on send. Default 12 h. */
  maxAgeMs?: number;
}

export interface ChannelLimits {
  /** Abort the handshake after this long. Default 10 000 ms. */
  handshakeTimeoutMs?: number;
  /** Largest message accepted or sent; at most `MAX_MESSAGE_BYTES` (65514). Default `MAX_MESSAGE_BYTES`. */
  maxMessageBytes?: number;
  /**
   * Receive window granted to the peer: the most unconsumed received DATA (payload + 64 bytes per message) we
   * buffer. 256 KiB..64 MiB. Default 1 MiB.
   */
  receiveWindowBytes?: number;
  /** Refuse `send` while more than this many bytes wait for flow-control credit or the transport. Default 4 MiB. */
  maxQueuedSendBytes?: number;
  rekey?: RekeyPolicy;
  /** Graceful `close()` gives up and aborts the transport after this long. Default 5000 ms. */
  closeTimeoutMs?: number;
  /** Clock for the age policy (tests). Default `Date.now`. */
  now?: () => number;
}

export interface ConnectionStats {
  messagesSent: number;
  bytesSent: number;
  messagesReceived: number;
  bytesReceived: number;
  /** Transport AEAD operations (Noise nonces used) per direction. */
  framesSent: number;
  framesReceived: number;
  establishedAt: number;
}

/**
 * An authenticated, encrypted, message-oriented connection. Single consumer for received messages.
 */
export interface SecureConnection extends AsyncIterable<Uint8Array> {
  readonly role: 'initiator' | 'responder';
  /** The authenticated remote identity (Ed25519 PeerId string). */
  readonly remotePeerId: string;
  /** Raw 32-byte Ed25519 public key of the remote. */
  readonly remotePublicKey: Uint8Array;
  /** True once the rekey policy was reached: `send` throws `RekeyRequiredError`; reconnect. */
  readonly rekeyRequired: boolean;
  /**
   * Send one message (≤ maxMessageBytes). Resolves once it is handed to the transport, waiting for the
   * transport to drain when it is above its high-water mark (backpressure).
   */
  send(message: Uint8Array): Promise<void>;
  /**
   * Next message, or `null` once the connection ended cleanly: after the peer's authenticated close, or after
   * our own `close()` (messages that arrive after a local close are not delivered). Rejects with the
   * connection's failure.
   */
  receive(): Promise<Uint8Array | null>;
  /**
   * Authenticated graceful close: sends a close record, flushes, then closes the transport. Sends still
   * waiting for flow-control credit are rejected with `ClosedError`. Rejects with the connection's failure if
   * it had already failed (a failed connection never ends with an authenticated close).
   */
  close(): Promise<void>;
  /** Tear down immediately. */
  abort(reason?: Error): void;
  /** Resolves when the connection has ended: `undefined` for a clean close, else the failure. */
  readonly closed: Promise<SecureChannelError | undefined>;
  stats(): ConnectionStats;
}

export interface InitiatorOptions {
  stream: ByteStream;
  identity: Identity;
  /** The appliance PeerId from enrollment/claim card QR. Checked inside the handshake. */
  expectedAppliancePeerId?: string;
  /**
   * Alternative to the full PeerId: the claim card fingerprint (125-bit). Checked right after the handshake,
   * before any application byte is sent. Prefer the full PeerId when available.
   */
  expectedApplianceFingerprint?: string;
  prologue?: string | Uint8Array;
  limits?: ChannelLimits;
  /**
   * Noise primitive implementation. Default: the library's `pureJsCrypto` (@noble X25519, ChaCha20-Poly1305,
   * SHA-256, HKDF), identical on every platform. Node may pass `nodeNoiseCrypto` from
   * `@whombat/secure-channel/node` (OpenSSL for every primitive but HKDF; same algorithms, faster).
   */
  crypto?: ICryptoInterface;
}

export interface ResponderOptions {
  stream: ByteStream;
  identity: Identity;
  prologue?: string | Uint8Array;
  limits?: ChannelLimits;
  /**
   * Noise primitive implementation. Default: the library's `pureJsCrypto` (@noble X25519, ChaCha20-Poly1305,
   * SHA-256, HKDF), identical on every platform. Node may pass `nodeNoiseCrypto` from
   * `@whombat/secure-channel/node` (OpenSSL for every primitive but HKDF; same algorithms, faster).
   */
  crypto?: ICryptoInterface;
}

interface Handshaked {
  raw: ByteStreamMessageStream;
  secured: MessageStream;
  remotePeerId: string;
  remotePublicKey: Uint8Array;
  counters: Counters;
  guard: HandshakeGuard;
}

interface Counters {
  framesSent: number;
  framesReceived: number;
}

interface HandshakeGuard {
  decrypts: number;
  /** A transport frame failed to decrypt (possibly before the handshake call returned). */
  transportError?: SecureChannelError;
  remoteStatic?: Uint8Array;
  pinnedKey?: Uint8Array;
  rejection?: IdentityRejected;
  /** The identity key our payload check validated (review N-3: must equal the key upstream reports). */
  identityKey?: Uint8Array;
  /**
   * The first encrypted handshake message did not authenticate. The handshake hash covers the prologue, so this
   * is what a peer with another protocol version (prologue) produces — or a relay that tampered with it.
   */
  firstDecryptFailed?: boolean;
}

function copyBytes(b: Uint8Array | Uint8ArrayList): Uint8Array {
  return new Uint8Array(b instanceof Uint8Array ? b : b.subarray());
}

/**
 * Wrap the library's crypto to (a) count transport AEAD operations (empty associated data = transport phase;
 * handshake messages use the handshake hash as AD), (b) turn any AEAD failure into `DecryptFailedError`, and
 * (c) check the peer's decrypted handshake payload (identity key type, strength, strict signature, pin) before
 * the library parses and verifies it. In XX, the peer's static key and then its payload are the first and
 * second handshake decryptions on both sides. Delegation plus checks: no cryptographic primitive here.
 */
function instrumentCrypto(
  base: ICryptoInterface,
  counters: Counters,
  guard: HandshakeGuard,
): ICryptoInterface {
  return {
    ...base,
    chaCha20Poly1305Encrypt(plaintext, nonce, ad, k) {
      const out = base.chaCha20Poly1305Encrypt(plaintext, nonce, ad, k);
      if (ad.byteLength === 0) counters.framesSent++;
      return out;
    },
    chaCha20Poly1305Decrypt(ciphertext, nonce, ad, k, dst) {
      let out: ReturnType<ICryptoInterface['chaCha20Poly1305Decrypt']>;
      try {
        out = base.chaCha20Poly1305Decrypt(ciphertext, nonce, ad, k, dst);
      } catch (cause) {
        const err = new DecryptFailedError({ cause });
        if (ad.byteLength === 0) guard.transportError ??= err;
        else if (guard.decrypts === 0) guard.firstDecryptFailed = true;
        throw err;
      }
      if (ad.byteLength === 0) {
        counters.framesReceived++;
        return out;
      }
      guard.decrypts++;
      try {
        if (guard.decrypts === 1) {
          if (out.byteLength !== 32)
            throw new IdentityRejected('remote static key is not 32 bytes', 'payload');
          guard.remoteStatic = copyBytes(out);
        } else if (guard.decrypts === 2 && guard.remoteStatic) {
          guard.identityKey = checkHandshakePayload(copyBytes(out), guard.remoteStatic, guard.pinnedKey);
        } else {
          throw new IdentityRejected('unexpected handshake decryption', 'payload');
        }
      } catch (err) {
        guard.rejection ??=
          err instanceof IdentityRejected ? err : new IdentityRejected(String(err), 'payload');
        throw guard.rejection;
      }
      return out;
    },
  };
}

function prologueBytes(p: string | Uint8Array | undefined): Uint8Array {
  if (p instanceof Uint8Array) return p;
  return new TextEncoder().encode(p ?? DEFAULT_PROLOGUE);
}

function rejectUnexpectedExtensions(ext: NoiseExtensions | undefined): void {
  if (!ext) return;
  const e = ext as NoiseExtensions & { streamMuxers?: string[] };
  if ((e.webtransportCerthashes?.length ?? 0) > 0 || (e.streamMuxers?.length ?? 0) > 0) {
    throw new EarlyDataError('peer sent handshake extensions; no data is accepted in the handshake');
  }
}

function errorName(err: unknown): string {
  return (err as { name?: string } | undefined)?.name ?? '';
}

function mapTransportError(err: unknown): SecureChannelError {
  if (err instanceof SecureChannelError) return err;
  if (err instanceof Error && /Invalid chunk/.test(err.message))
    return new DecryptFailedError({ cause: err });
  if (errorName(err) === 'StreamBufferError') return new BufferOverflowError((err as Error).message);
  if (errorName(err) === 'StreamResetError')
    return new TransportError('stream reset by peer', { cause: err });
  return new TransportError((err as Error)?.message ?? String(err), { cause: err });
}

function mapRejection(role: 'initiator' | 'responder', r: IdentityRejected): SecureChannelError {
  if (r.kind === 'early-data') return new EarlyDataError(r.message);
  // The initiator only talks to the pinned appliance: any identity failure means "not the pinned appliance".
  if (role === 'initiator' && r.kind !== 'payload') return new PeerMismatchError(r.message);
  return new HandshakeFailedError(r.message);
}

async function handshake(
  role: 'initiator' | 'responder',
  stream: ByteStream,
  identity: Identity,
  prologue: string | Uint8Array | undefined,
  limits: ChannelLimits,
  expectedPeerId: string | undefined,
  crypto: ICryptoInterface = pureJsCrypto,
): Promise<Handshaked> {
  assertSecureRandom();
  const pinned = expectedPeerId ? parsePeerId(expectedPeerId) : undefined;
  const counters: Counters = { framesSent: 0, framesReceived: 0 };
  const guard: HandshakeGuard = { decrypts: 0, pinnedKey: pinned?.publicKey?.raw };
  const encrypter: ConnectionEncrypter<NoiseExtensions> = noise({
    crypto: instrumentCrypto(crypto, counters, guard),
    prologueBytes: prologueBytes(prologue),
  })({
    peerId: peerIdFromString(identity.peerId),
    privateKey: identity.privateKey,
    logger: silentComponentLogger,
    // Stream-muxer negotiation is skipped; the upgrader is never consulted.
    upgrader: {
      getStreamMuxers: () => new Map(),
    } as never,
  });

  const raw = new ByteStreamMessageStream(stream, {
    direction: role === 'initiator' ? 'outbound' : 'inbound',
    // Inbound DATA is bounded by the receive window; this bounds bytes between transport and decryption.
    maxReadBufferLength: receiveWindow(limits) + 1024 * 1024,
    maxChunkBytes: 256 * 1024,
    // XX: the initiator reads message 2, the responder messages 1 and 3.
    handshakeFramesToRead: role === 'initiator' ? 1 : 2,
  });

  const timeoutMs = limits.handshakeTimeoutMs ?? 10_000;
  const controller = new AbortController();
  ensureThrowIfAborted(controller.signal);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const options = {
      signal: controller.signal,
      skipStreamMuxerNegotiation: true,
      ...(pinned ? { remotePeer: pinned } : {}),
    };
    const result =
      role === 'initiator'
        ? await encrypter.secureOutbound(raw, options)
        : await encrypter.secureInbound(raw, options);
    if (timedOut) throw new HandshakeTimeoutError(timeoutMs);
    if (result.remotePeer.type !== 'Ed25519' || !result.remotePeer.publicKey) {
      throw new HandshakeFailedError(`remote identity type ${result.remotePeer.type} is not Ed25519`);
    }
    const remotePublicKey = result.remotePeer.publicKey.raw;
    if (guard.decrypts !== 2 || !guard.identityKey) {
      throw new HandshakeFailedError('handshake payload was not checked');
    }
    if (
      guard.identityKey.length !== remotePublicKey.length ||
      guard.identityKey.some((b, i) => b !== remotePublicKey[i])
    ) {
      throw new HandshakeFailedError('checked identity key differs from the key the library reports');
    }
    if (pinned && !pinned.publicKey?.equals(result.remotePeer.publicKey)) throw new PeerMismatchError();
    rejectUnexpectedExtensions(result.remoteExtensions);
    if (raw.status !== 'open') {
      throw guard.transportError ?? new HandshakeFailedError(`transport ${raw.status} during the handshake`);
    }
    return {
      raw,
      secured: result.connection,
      remotePeerId: result.remotePeer.toString(),
      remotePublicKey,
      counters,
      guard,
    };
  } catch (err) {
    let mapped: SecureChannelError;
    if (timedOut) mapped = new HandshakeTimeoutError(timeoutMs);
    else if (guard.firstDecryptFailed)
      mapped = new VersionMismatchError(
        typeof prologue === 'string' ? prologue : prologue ? 'the expected prologue' : DEFAULT_PROLOGUE,
        { cause: err },
      );
    else if (guard.rejection) mapped = mapRejection(role, guard.rejection);
    else if (err instanceof TransportError) {
      mapped = new HandshakeFailedError(`transport failed during the handshake: ${err.message}`, {
        cause: err,
      });
    } else if (err instanceof SecureChannelError) mapped = err;
    else if (role === 'initiator' && pinned && errorName(err) === 'UnexpectedPeerError') {
      mapped = new PeerMismatchError(undefined, { cause: err });
    } else mapped = new HandshakeFailedError((err as Error)?.message ?? 'handshake failed', { cause: err });
    raw.abort(mapped);
    throw mapped;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Upstream (p-event, @libp2p/crypto) calls `signal.throwIfAborted()` on the signal we pass, e.g. while waiting
 * for a transport drain during the handshake. React Native's `AbortSignal` (the `abort-controller` package)
 * lacks it. Add it to our own signal instance only — no global patching.
 */
function ensureThrowIfAborted(signal: AbortSignal): void {
  const s = signal as AbortSignal & { throwIfAborted?: () => void };
  if (typeof s.throwIfAborted === 'function') return;
  Object.defineProperty(s, 'throwIfAborted', {
    configurable: true,
    value(this: AbortSignal & { reason?: unknown }): void {
      if (!this.aborted) return;
      const reason = this.reason;
      throw reason instanceof Error
        ? reason
        : Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    },
  });
}

function receiveWindow(limits: ChannelLimits): number {
  return limits.receiveWindowBytes ?? 1024 * 1024;
}

interface PendingSend {
  record: Uint8Array;
  cost: number;
  resolve: () => void;
  reject: (e: unknown) => void;
}

/** Receive-side ceiling on transport frames: a peer that ignores its rekey policy is cut off (review I-5). */
const RECEIVE_FRAME_CEILING = FRAME_CEILING + 2 ** 20;

class Connection implements SecureConnection {
  readonly role: 'initiator' | 'responder';
  readonly remotePeerId: string;
  readonly remotePublicKey: Uint8Array;
  readonly closed: Promise<SecureChannelError | undefined>;

  private readonly secured: MessageStream;
  private readonly counters: Counters;
  private readonly maxMessage: number;
  private readonly window: number;
  private readonly maxQueuedSend: number;
  private readonly rekey: Required<RekeyPolicy>;
  private readonly now: () => number;
  private readonly establishedAt: number;
  private readonly closeTimeoutMs: number;

  private readonly inbuf = new Uint8ArrayList();
  private readonly queue: Uint8Array[] = [];
  private waiter: { resolve: (m: Uint8Array | null) => void; reject: (e: unknown) => void } | undefined;
  private failure: SecureChannelError | undefined;
  private remoteClosed = false;
  private localClosed = false;
  private ended = false;
  private resolveClosed!: (v: SecureChannelError | undefined) => void;
  private _rekeyRequired = false;
  private messagesSent = 0;
  private bytesSent = 0;
  private messagesReceived = 0;
  private bytesReceived = 0;

  // Flow control (costs in bytes, see INITIAL_WINDOW_BYTES).
  private sendCredit = INITIAL_WINDOW_BYTES;
  private sentCost = 0;
  private readonly pendingSends: PendingSend[] = [];
  private pendingSendBytes = 0;
  private granted = INITIAL_WINDOW_BYTES;
  /** A transport write failed: nothing more can be sent; `dataLost` if any DATA may not have been delivered. */
  private writeFailure: SecureChannelError | undefined;
  private dataLost = false;
  private receivedCost = 0;
  private ungranted = 0;

  constructor(role: 'initiator' | 'responder', hs: Handshaked, limits: ChannelLimits) {
    this.role = role;
    this.secured = hs.secured;
    this.remotePeerId = hs.remotePeerId;
    this.remotePublicKey = hs.remotePublicKey;
    this.counters = hs.counters;
    this.maxMessage = Math.min(limits.maxMessageBytes ?? MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES);
    this.window = receiveWindow(limits);
    this.maxQueuedSend = limits.maxQueuedSendBytes ?? 4 * 1024 * 1024;
    this.rekey = {
      maxMessages: limits.rekey?.maxMessages ?? 2 ** 30,
      maxBytes: limits.rekey?.maxBytes ?? 2 ** 40,
      maxAgeMs: limits.rekey?.maxAgeMs ?? 12 * 60 * 60 * 1000,
    };
    this.now = limits.now ?? Date.now;
    this.closeTimeoutMs = limits.closeTimeoutMs ?? 5000;
    this.establishedAt = this.now();
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });

    // Attach synchronously: data decrypted before this point is buffered by the stream and dispatched to the
    // listener, and the transport's end of stream is held back until `releaseEof` below (review L-3).
    this.secured.addEventListener('message', (evt: StreamMessageEvent) => this.onData(evt.data));
    this.secured.addEventListener('close', (evt: StreamCloseEvent) => {
      if (evt.error) this.fail(mapTransportError(evt.error));
      else if (!this.remoteClosed && !this.localClosed) this.fail(new TruncatedError());
      else this.finish();
    });
    if (hs.raw.status !== 'open' || this.secured.status !== 'open') {
      // A transport frame may have failed to authenticate after the handshake returned but before this point
      // (e.g. a replayed record right behind the last handshake message): report it as such.
      this.fail(
        hs.guard.transportError ??
          new TransportError(`transport ${hs.raw.status} before the connection was established`),
        true,
      );
      return;
    }
    hs.raw.onWriteError = (err) => this.onWriteError(err);
    hs.raw.releaseEof();
    // Grant the rest of our receive window.
    if (this.window > INITIAL_WINDOW_BYTES) this.grant(this.window - INITIAL_WINDOW_BYTES);
  }

  /** The failure the connection already had when it was constructed, if any. */
  get failedAtStart(): SecureChannelError | undefined {
    return this.failure;
  }

  get rekeyRequired(): boolean {
    return this._rekeyRequired;
  }

  stats(): ConnectionStats {
    return {
      messagesSent: this.messagesSent,
      bytesSent: this.bytesSent,
      messagesReceived: this.messagesReceived,
      bytesReceived: this.bytesReceived,
      framesSent: this.counters.framesSent,
      framesReceived: this.counters.framesReceived,
      establishedAt: this.establishedAt,
    };
  }

  private checkRekey(nextBytes: number): void {
    let reason: 'messages' | 'bytes' | 'age' | undefined;
    if (this.messagesSent + 1 > this.rekey.maxMessages || this.counters.framesSent + 2 > FRAME_CEILING) {
      reason = 'messages';
    } else if (this.bytesSent + nextBytes > this.rekey.maxBytes) reason = 'bytes';
    else if (this.now() - this.establishedAt >= this.rekey.maxAgeMs) reason = 'age';
    if (reason) {
      this._rekeyRequired = true;
      throw new RekeyRequiredError(reason);
    }
  }

  /**
   * The transport refused a write (typically: the peer already closed it). Nothing more can be sent. Reading
   * continues, so authenticated records that already arrived are still delivered; the connection ends cleanly
   * only if the peer's authenticated close arrives and none of our DATA can have been lost.
   */
  private onWriteError(err: Error): void {
    if (this.writeFailure || this.ended) return;
    this.writeFailure = mapTransportError(err);
    this.dataLost = this.messagesSent > 0 && !this.remoteClosed;
    this.rejectPendingSends(this.writeFailure);
  }

  private record(type: number, payload: Uint8Array): Uint8Array {
    const record = new Uint8Array(RECORD_HEADER_BYTES + payload.byteLength);
    record[0] = type;
    new DataView(record.buffer).setUint32(1, payload.byteLength, false);
    record.set(payload, RECORD_HEADER_BYTES);
    return record;
  }

  /** Write a record to the secured stream; returns false when the transport wants a drain. */
  private write(record: Uint8Array): boolean {
    try {
      return this.secured.send(record);
    } catch (err) {
      const e = this.failure ?? mapTransportError(err);
      this.fail(e, true);
      throw e;
    }
  }

  private grant(bytes: number): void {
    if (bytes <= 0 || this.localClosed || this.remoteClosed || this.ended || this.writeFailure) return;
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, bytes, false);
    this.granted += bytes;
    try {
      this.write(this.record(RECORD_WINDOW, payload));
    } catch {
      // failure recorded by write()
    }
  }

  /** Write queued sends, in order, while credit allows. */
  private flushPending(): void {
    while (this.pendingSends.length > 0) {
      const next = this.pendingSends[0] as PendingSend;
      if (this.sentCost + next.cost > this.sendCredit) return;
      this.pendingSends.shift();
      this.pendingSendBytes -= next.record.byteLength;
      this.sentCost += next.cost;
      let canSendMore: boolean;
      try {
        canSendMore = this.write(next.record);
      } catch (err) {
        next.reject(err);
        continue;
      }
      const settle = (): void => {
        const err = this.failure ?? this.writeFailure;
        if (err) next.reject(err);
        else next.resolve();
      };
      if (canSendMore) settle();
      else
        waitForDrain(this.secured).then(settle, (err: unknown) =>
          next.reject(this.failure ?? this.writeFailure ?? mapTransportError(err)),
        );
    }
  }

  send(message: Uint8Array): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.writeFailure) return Promise.reject(this.writeFailure);
    if (this.localClosed || this.remoteClosed || this.ended) return Promise.reject(new ClosedError());
    if (message.byteLength > this.maxMessage) {
      return Promise.reject(new FrameTooLargeError(message.byteLength, this.maxMessage, 'message'));
    }
    try {
      this.checkRekey(message.byteLength);
    } catch (err) {
      return Promise.reject(err);
    }
    const record = this.record(RECORD_DATA, message);
    if (this.secured.writeBufferLength + this.pendingSendBytes + record.byteLength > this.maxQueuedSend) {
      return Promise.reject(
        new BufferOverflowError('send queue is full; await earlier sends (backpressure)'),
      );
    }
    this.messagesSent++;
    this.bytesSent += message.byteLength;
    return new Promise<void>((resolve, reject) => {
      this.pendingSends.push({ record, cost: message.byteLength + RECORD_COST_OVERHEAD, resolve, reject });
      this.pendingSendBytes += record.byteLength;
      this.flushPending();
    });
  }

  private onData(data: Uint8Array | Uint8ArrayList): void {
    if (this.failure || this.ended) return;
    if (this.counters.framesReceived > RECEIVE_FRAME_CEILING) {
      this.fail(new ProtocolError('peer exceeded the transport frame limit without rekeying'), true);
      return;
    }
    this.inbuf.append(data);
    while (this.inbuf.byteLength >= RECORD_HEADER_BYTES) {
      const type = this.inbuf.get(0);
      const len = this.inbuf.getUint32(1, false);
      if (type !== RECORD_DATA && type !== RECORD_CLOSE && type !== RECORD_WINDOW) {
        this.fail(new ProtocolError(`unknown record type ${type}`), true);
        return;
      }
      if (len > this.maxMessage) {
        this.fail(new FrameTooLargeError(len, this.maxMessage, 'message'), true);
        return;
      }
      if (type === RECORD_CLOSE && len !== 0) {
        this.fail(new ProtocolError('close record with payload'), true);
        return;
      }
      if (type === RECORD_WINDOW && len !== 4) {
        this.fail(new ProtocolError('window record must carry 4 bytes'), true);
        return;
      }
      if (type === RECORD_DATA && this.receivedCost + len + RECORD_COST_OVERHEAD > this.granted) {
        this.fail(new ProtocolError('peer exceeded the flow-control window'), true);
        return;
      }
      if (this.inbuf.byteLength < RECORD_HEADER_BYTES + len) break;
      if (type === RECORD_CLOSE) {
        this.inbuf.consume(RECORD_HEADER_BYTES);
        if (this.inbuf.byteLength > 0) {
          this.fail(new ProtocolError('data after close record'), true);
          return;
        }
        this.onRemoteClose();
        return;
      }
      if (type === RECORD_WINDOW) {
        const inc = this.inbuf.getUint32(RECORD_HEADER_BYTES, false);
        this.inbuf.consume(RECORD_HEADER_BYTES + 4);
        if (inc === 0 || this.sendCredit - this.sentCost + inc > MAX_WINDOW_BYTES) {
          this.fail(new ProtocolError('invalid window increment'), true);
          return;
        }
        this.sendCredit += inc;
        this.flushPending();
        continue;
      }
      const msg = this.inbuf.subarray(RECORD_HEADER_BYTES, RECORD_HEADER_BYTES + len);
      this.inbuf.consume(RECORD_HEADER_BYTES + len);
      this.messagesReceived++;
      this.bytesReceived += len;
      this.receivedCost += len + RECORD_COST_OVERHEAD;
      this.deliver(msg.slice());
    }
  }

  /** The peer's authenticated CLOSE: the connection has ended cleanly, whatever happens to the transport next. */
  private onRemoteClose(): void {
    this.remoteClosed = true;
    this.rejectPendingSends(new ClosedError('peer closed the connection'));
    this.finish();
    // Answer with our own close record so the peer also ends cleanly; failures no longer matter.
    if (!this.localClosed && !this.writeFailure) {
      this.localClosed = true;
      try {
        this.secured.send(this.record(RECORD_CLOSE, new Uint8Array(0)));
      } catch {
        // peer already gone
      }
      void flushWrites(this.secured)
        .then(() => this.secured.close())
        .catch(() => {});
    }
  }

  private consumed(msg: Uint8Array): void {
    this.ungranted += msg.byteLength + RECORD_COST_OVERHEAD;
    if (this.ungranted >= this.window / 4) {
      const bytes = this.ungranted;
      this.ungranted = 0;
      this.grant(bytes);
    }
  }

  private deliver(msg: Uint8Array): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      this.consumed(msg);
      w.resolve(msg);
      return;
    }
    this.queue.push(msg);
  }

  private endQueue(): void {
    if (this.waiter && this.queue.length === 0) {
      const w = this.waiter;
      this.waiter = undefined;
      w.resolve(null);
    }
  }

  receive(): Promise<Uint8Array | null> {
    const msg = this.queue.shift();
    if (msg) {
      this.consumed(msg);
      return Promise.resolve(msg);
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.remoteClosed || this.localClosed || this.ended) return Promise.resolve(null);
    if (this.waiter) return Promise.reject(new ProtocolError('concurrent receive on a SecureConnection'));
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for (;;) {
      const msg = await this.receive();
      if (msg === null) return;
      yield msg;
    }
  }

  private rejectPendingSends(err: unknown): void {
    for (const p of this.pendingSends.splice(0)) p.reject(err);
    this.pendingSendBytes = 0;
  }

  async close(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.localClosed || this.ended) return;
    if (this.writeFailure) {
      // We can no longer send an authenticated close: end with the failure, never with a clean close.
      const err = this.writeFailure;
      this.fail(err, true);
      throw err;
    }
    this.localClosed = true;
    this.rejectPendingSends(new ClosedError('connection closed before this message was sent'));
    try {
      this.write(this.record(RECORD_CLOSE, new Uint8Array(0)));
    } catch (err) {
      throw this.failure ?? err;
    }
    this.endQueue();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceful = (async () => {
      await flushWrites(this.secured);
      await this.secured.close();
    })().catch(() => {});
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.closeTimeoutMs);
    });
    const outcome = await Promise.race([graceful, timeout]);
    clearTimeout(timer);
    if (outcome === 'timeout' && !this.ended) {
      // The peer stopped reading; don't hang: tear the transport down.
      const err = new ClosedError('close timed out; transport aborted');
      this.fail(err, true);
      throw err;
    }
    if (this.failure) throw this.failure;
    this.finish();
  }

  abort(reason?: Error): void {
    const err = reason instanceof SecureChannelError ? reason : new ClosedError(reason?.message ?? 'aborted');
    this.fail(err, true);
  }

  private fail(err: SecureChannelError, abortTransport = false): void {
    if (this.ended) return;
    if (!this.failure) this.failure = err;
    this.rejectPendingSends(this.failure);
    if (abortTransport) {
      try {
        this.secured.abort(err);
      } catch {
        // already closed
      }
    }
    const w = this.waiter;
    this.waiter = undefined;
    // Already-authenticated queued messages stay readable; the failure is reported after them.
    if (w) {
      if (this.queue.length > 0) w.resolve(this.queue.shift() ?? null);
      else w.reject(err);
    }
    this.ended = true;
    this.resolveClosed(this.failure);
  }

  private finish(): void {
    if (this.ended) return;
    if (this.writeFailure && this.dataLost) {
      this.fail(this.writeFailure, true);
      return;
    }
    this.ended = true;
    this.rejectPendingSends(new ClosedError());
    this.endQueue();
    this.resolveClosed(undefined);
  }
}

/** Never hand out a connection that already failed (e.g. a replayed record right after the handshake). */
function established(connection: Connection): Connection {
  const failure = connection.failedAtStart;
  if (failure) throw failure;
  return connection;
}

function validateLimits(limits: ChannelLimits): void {
  if (
    limits.maxMessageBytes !== undefined &&
    (limits.maxMessageBytes < 1 || limits.maxMessageBytes > MAX_MESSAGE_BYTES)
  ) {
    throw new RangeError(`maxMessageBytes must be in 1..${MAX_MESSAGE_BYTES}`);
  }
  const w = limits.receiveWindowBytes;
  if (w !== undefined && (!Number.isInteger(w) || w < INITIAL_WINDOW_BYTES || w > MAX_WINDOW_BYTES)) {
    throw new RangeError(
      `receiveWindowBytes must be an integer in ${INITIAL_WINDOW_BYTES}..${MAX_WINDOW_BYTES}`,
    );
  }
}

/**
 * Client side: run Noise XX as initiator over `stream`, authenticate the appliance against the pinned
 * PeerId (or claim-card fingerprint) and return the connection. Nothing but handshake messages is written
 * before the pin is verified.
 */
export async function openInitiator(options: InitiatorOptions): Promise<SecureConnection> {
  const limits = options.limits ?? {};
  validateLimits(limits);
  const { expectedAppliancePeerId: peerId, expectedApplianceFingerprint: fp } = options;
  if (!peerId === !fp) {
    options.stream.abort(new PeerMismatchError('no pinned identity'));
    throw new PeerMismatchError(
      'exactly one of expectedAppliancePeerId or expectedApplianceFingerprint is required',
    );
  }
  // Validate the pin before any byte is written (review I-2); a malformed pin aborts the transport.
  let expectedFp: string | undefined;
  try {
    if (peerId) parsePeerId(peerId);
    expectedFp = fp ? normalizeFingerprint(fp) : undefined;
  } catch (err) {
    options.stream.abort(err as Error);
    throw err;
  }
  const hs = await handshake(
    'initiator',
    options.stream,
    options.identity,
    options.prologue,
    limits,
    peerId,
    options.crypto,
  );
  if (expectedFp && fingerprint(hs.remotePeerId) !== expectedFp) {
    const err = new PeerMismatchError('appliance fingerprint does not match the claim card');
    hs.secured.abort(err);
    throw err;
  }
  return established(new Connection('initiator', hs, limits));
}

/**
 * Appliance side: run Noise XX as responder. Any Ed25519 client identity completes the handshake; the
 * caller applies its own policy to `remotePeerId` (enrolled endpoint, enrollment-only, reject) before acting
 * on any message.
 */
export async function acceptResponder(options: ResponderOptions): Promise<SecureConnection> {
  const limits = options.limits ?? {};
  validateLimits(limits);
  const hs = await handshake(
    'responder',
    options.stream,
    options.identity,
    options.prologue,
    limits,
    undefined,
    options.crypto,
  );
  return established(new Connection('responder', hs, limits));
}
