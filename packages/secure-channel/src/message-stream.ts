import type {
  AbortOptions,
  ComponentLogger,
  Logger,
  MessageStream,
  StreamCloseEvent,
} from '@libp2p/interface';
import { AbstractMessageStream, type SendResult } from '@libp2p/utils';
import type { Uint8ArrayList } from 'uint8arraylist';
import type { ByteStream } from './byte-stream.js';

const noop = (): void => {};

/** A silent libp2p logger: the channel never logs key material or payloads. */
export function silentLogger(): Logger {
  const log = Object.assign((_formatter: unknown, ..._args: unknown[]) => {}, {
    error: noop,
    trace: noop,
    enabled: false,
    newScope: (_name: string): Logger => log,
  });
  return log as Logger;
}

export const silentComponentLogger: ComponentLogger = { forComponent: () => silentLogger() };

/**
 * Adapts our pull-based `ByteStream` to the libp2p `MessageStream` that the Noise connection encrypter
 * consumes (via its public `secureOutbound`/`secureInbound`). Reads are pulled only while the stream is not
 * paused, so libp2p's pause propagates to the byte source (and on to `ws.pause()` / TCP).
 */
export class ByteStreamMessageStream extends AbstractMessageStream {
  private readonly bytes: ByteStream;
  private paused = false;
  private wake: (() => void) | undefined;
  private pumping = true;

  // End-of-stream handling during the handshake (review L-3). A peer may send its last handshake message,
  // application records and its close in one burst. Upstream processes the handshake asynchronously, so an end
  // of stream delivered immediately would close this stream under it (dropping the authenticated records, or
  // failing `unwrap`). We count complete handshake messages ([u16 len][body]) as they arrive: if the stream
  // ends before all of them arrived, the end is delivered at once (the handshake fails promptly); otherwise it
  // is held until the connection has attached its listeners (`releaseEof`).
  private handshakeFramesLeft: number;
  private hsHeader = -1;
  private hsHeaderByte = 0;
  private hsBodyLeft = 0;
  private eofHeld = false;
  private eofReleased = false;

  constructor(
    bytes: ByteStream,
    init: {
      direction: 'inbound' | 'outbound';
      maxReadBufferLength: number;
      maxChunkBytes: number;
      /** Handshake messages this side reads (XX: initiator 1, responder 2). 0 = no end-of-stream hold. */
      handshakeFramesToRead?: number;
    },
  ) {
    super({
      log: silentLogger(),
      direction: init.direction,
      maxReadBufferLength: init.maxReadBufferLength,
      maxMessageSize: init.maxChunkBytes,
      // No inactivity timeout here: the session protocol and relay own idle policy.
      inactivityTimeout: 0,
    });
    this.bytes = bytes;
    this.handshakeFramesLeft = init.handshakeFramesToRead ?? 0;
    this.eofReleased = this.handshakeFramesLeft === 0;
    void this.pump();
  }

  /** Count complete u16-length-prefixed handshake messages in the incoming bytes. */
  private countHandshakeFrames(chunk: Uint8Array): void {
    let i = 0;
    while (i < chunk.length && this.handshakeFramesLeft > 0) {
      if (this.hsBodyLeft > 0) {
        const take = Math.min(this.hsBodyLeft, chunk.length - i);
        this.hsBodyLeft -= take;
        i += take;
        if (this.hsBodyLeft === 0) this.handshakeFramesLeft--;
        continue;
      }
      const b = chunk[i++] as number;
      if (this.hsHeader < 0) {
        this.hsHeaderByte = b;
        this.hsHeader = 0;
      } else {
        const len = (this.hsHeaderByte << 8) | b;
        this.hsHeader = -1;
        if (len === 0) this.handshakeFramesLeft--;
        else this.hsBodyLeft = len;
      }
    }
  }

  private deliverEof(): void {
    this.onRemoteCloseWrite();
    this.onTransportClosed();
  }

  /** Called once the connection listens: deliver a held end of stream after the buffered bytes. */
  releaseEof(): void {
    this.eofReleased = true;
    if (this.eofHeld) this.scheduleEof();
  }

  /**
   * Deliver the end of stream only after every byte already received was dispatched: bytes handed back by
   * the handshake reader (`unshift`) are dispatched from a timer, so an immediate end would overtake them.
   */
  private scheduleEof(): void {
    const tryDeliver = (): void => {
      if (this.status !== 'open') return;
      if (this.readBufferLength > 0) setTimeout(tryDeliver, this.readStatus === 'paused' ? 10 : 0);
      else this.deliverEof();
    };
    setTimeout(tryDeliver, 0);
  }

  private async pump(): Promise<void> {
    try {
      while (this.pumping) {
        if (this.paused) {
          await new Promise<void>((resolve) => {
            this.wake = resolve;
          });
          continue;
        }
        const chunk = await this.bytes.read();
        if (!this.pumping) return;
        if (chunk === null) {
          this.pumping = false;
          if (this.handshakeFramesLeft > 0) {
            // The handshake cannot complete: let it fail now.
            this.deliverEof();
            return;
          }
          this.eofHeld = true;
          if (this.eofReleased) this.scheduleEof();
          return;
        }
        if (this.handshakeFramesLeft > 0) this.countHandshakeFrames(chunk);
        this.onData(chunk);
      }
    } catch (err) {
      this.pumping = false;
      if (this.status === 'open' || this.status === 'closing') this.abort(err as Error);
    }
  }

  /**
   * Set by the connection once established. A failed transport write is then reported here instead of aborting
   * the whole stream: the read side keeps delivering authenticated records that already arrived (the peer may
   * have sent its last messages and closed), and the connection decides the outcome (review L-3). During the
   * handshake a write failure aborts as usual.
   */
  onWriteError: ((err: Error) => void) | undefined;
  private writeFailed = false;

  /** Report a write failure to the connection; false when no connection listens yet (handshake). */
  private writeError(err: unknown): boolean {
    if (!this.onWriteError) return false;
    if (!this.writeFailed) {
      this.writeFailed = true;
      this.onWriteError(err instanceof Error ? err : new Error(String(err)));
    }
    return true;
  }

  sendData(data: Uint8ArrayList): SendResult {
    if (this.writeFailed) return { sentBytes: data.byteLength, canSendMore: true };
    let canSendMore: boolean;
    try {
      // Coalesce (libp2p-noise emits length prefix and ciphertext as separate buffers) into one transport chunk.
      canSendMore = this.bytes.write(data.subarray());
    } catch (err) {
      if (!this.writeError(err)) throw err;
      return { sentBytes: data.byteLength, canSendMore: true };
    }
    if (!canSendMore) {
      this.bytes.drained().then(
        () => this.safeDispatchEvent('drain'),
        (err: unknown) => {
          if (this.writeError(err)) this.safeDispatchEvent('drain');
          else this.abort(err as Error);
        },
      );
    }
    return { sentBytes: data.byteLength, canSendMore };
  }

  sendReset(err: Error): void {
    this.pumping = false;
    this.wake?.();
    this.bytes.abort(err);
  }

  sendPause(): void {
    this.paused = true;
  }

  sendResume(): void {
    this.paused = false;
    const w = this.wake;
    this.wake = undefined;
    w?.();
  }

  async close(_options?: AbortOptions): Promise<void> {
    if (this.status !== 'open') return;
    this.status = 'closing';
    this.writeStatus = 'closing';
    await flushWrites(this);
    await this.bytes.drained().catch(() => {});
    this.pumping = false;
    this.wake?.();
    await this.bytes.close().catch(() => {});
    this.onTransportClosed();
  }
}

type DrainableStream = Pick<
  MessageStream,
  'writeBufferLength' | 'writableNeedsDrain' | 'status' | 'addEventListener' | 'removeEventListener'
>;

/**
 * Wait for the next 'drain' of a MessageStream that needs one. Not `stream.onDrain()`: in @libp2p/utils
 * 7.4.1 `AbstractMessageStream.onDrain` keeps its first resolved promise forever, so every later call returns
 * immediately and backpressure is lost.
 */
export function waitForDrain(stream: DrainableStream): Promise<void> {
  if (!stream.writableNeedsDrain) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (evt: StreamCloseEvent): void => {
      cleanup();
      reject(evt.error ?? new Error('stream closed while waiting for drain'));
    };
    const cleanup = (): void => {
      stream.removeEventListener('drain', onDrain);
      stream.removeEventListener('close', onClose);
    };
    stream.addEventListener('drain', onDrain);
    stream.addEventListener('close', onClose);
  });
}

/** Wait until a MessageStream has handed every queued byte to its underlying transport. */
export async function flushWrites(stream: DrainableStream): Promise<void> {
  while (stream.writeBufferLength > 0 && (stream.status === 'open' || stream.status === 'closing')) {
    if (stream.writableNeedsDrain) await waitForDrain(stream).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
