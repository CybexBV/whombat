import { BufferOverflowError, ClosedError, TransportError } from './errors.js';

/**
 * A bidirectional, ordered, reliable stream of bytes (a duplex of `Uint8Array` chunks). Chunk boundaries
 * carry no meaning. This is what the relay splice gives us after its `ready` message.
 *
 * Backpressure: `write` returns `false` once the outbound buffer is above its high-water mark; the writer
 * then awaits `drained()`. `read` is pull-based, so an adapter can stop reading its source when nobody
 * pulls (e.g. `ws.pause()`), or fail with `BufferOverflowError` if its source cannot be paused.
 */
export interface ByteStream {
  /** Next chunk, or `null` at a clean end of stream. Rejects when the stream failed or was aborted. */
  read(): Promise<Uint8Array | null>;
  /** Queue a chunk for sending. Returns `false` when the caller should await `drained()`. Throws when closed. */
  write(chunk: Uint8Array): boolean;
  /** Resolves once the outbound buffer is at or below the low-water mark. Rejects if the stream fails. */
  drained(): Promise<void>;
  /** Flush queued outbound bytes, then end the stream in both directions. */
  close(): Promise<void>;
  /** Tear down immediately; pending and future reads reject with `reason`. */
  abort(reason: Error): void;
}

type Pending = { resolve: (v: Uint8Array | null) => void; reject: (e: unknown) => void };

/**
 * A bounded FIFO of inbound chunks with a single pending reader. Shared by the adapters.
 * `onLow`/`onHigh` let an adapter pause and resume its source.
 */
export class InboundQueue {
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;
  private pending: Pending | undefined;
  private ended = false;
  private error: unknown;
  private high = false;

  constructor(
    private readonly limits: { highWaterBytes: number; maxBufferedBytes: number },
    private readonly hooks: { onHigh?: () => void; onLow?: () => void } = {},
  ) {}

  get bufferedBytes(): number {
    return this.bytes;
  }

  /** Returns false (and fails the queue) when the hard limit is exceeded. */
  push(chunk: Uint8Array): boolean {
    if (this.ended || this.error !== undefined) return true;
    if (chunk.byteLength === 0) return true;
    if (this.pending) {
      const p = this.pending;
      this.pending = undefined;
      p.resolve(chunk);
      return true;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    if (this.bytes > this.limits.maxBufferedBytes) {
      this.fail(
        new BufferOverflowError(
          `inbound buffer of ${this.bytes} bytes exceeds ${this.limits.maxBufferedBytes} (slow consumer)`,
        ),
      );
      return false;
    }
    if (!this.high && this.bytes >= this.limits.highWaterBytes) {
      this.high = true;
      this.hooks.onHigh?.();
    }
    return true;
  }

  end(): void {
    if (this.ended || this.error !== undefined) return;
    this.ended = true;
    if (this.pending && this.chunks.length === 0) {
      const p = this.pending;
      this.pending = undefined;
      p.resolve(null);
    }
  }

  fail(err: unknown): void {
    if (this.error !== undefined) return;
    this.error = err;
    this.chunks.length = 0;
    this.bytes = 0;
    if (this.pending) {
      const p = this.pending;
      this.pending = undefined;
      p.reject(err);
    }
  }

  read(): Promise<Uint8Array | null> {
    if (this.error !== undefined) return Promise.reject(this.error);
    if (this.pending) return Promise.reject(new TransportError('concurrent read on a ByteStream'));
    const chunk = this.chunks.shift();
    if (chunk) {
      this.bytes -= chunk.byteLength;
      if (this.high && this.bytes <= this.limits.highWaterBytes / 2) {
        this.high = false;
        this.hooks.onLow?.();
      }
      return Promise.resolve(chunk);
    }
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }
}

export interface MemoryByteStreamOptions {
  /** Outbound high-water mark: `write` returns false above it. Default 256 KiB. */
  highWaterBytes?: number;
}

class MemoryByteStream implements ByteStream {
  peer!: MemoryByteStream;
  readonly inbound: InboundQueue;
  private closed = false;
  private readonly waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  private failure: unknown;

  constructor(private readonly highWater: number) {
    // The writer applies backpressure against the reader's buffer, so the hard limit is never hit by a
    // well-behaved writer; it only guards against writers that ignore `write() === false`.
    this.inbound = new InboundQueue(
      { highWaterBytes: highWater, maxBufferedBytes: Number.MAX_SAFE_INTEGER },
      { onLow: () => this.peer.notifyDrained() },
    );
  }

  notifyDrained(): void {
    for (const w of this.waiters.splice(0)) w.resolve();
  }

  read(): Promise<Uint8Array | null> {
    return this.inbound.read();
  }

  write(chunk: Uint8Array): boolean {
    if (this.failure !== undefined) throw this.failure;
    if (this.closed) throw new ClosedError('write after close');
    // Copy: the receiver may decrypt in place and the writer may reuse its buffer.
    this.peer.inbound.push(chunk.slice());
    return this.peer.inbound.bufferedBytes < this.highWater;
  }

  drained(): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.peer.inbound.bufferedBytes <= this.highWater / 2) return Promise.resolve();
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.peer.inbound.end();
    this.inbound.end();
    this.peer.closed = true;
  }

  abort(reason: Error): void {
    this.fail(reason);
    this.peer.fail(new TransportError('peer aborted the stream', { cause: reason }));
  }

  private fail(err: unknown): void {
    if (this.failure !== undefined) return;
    this.failure = err;
    this.closed = true;
    this.inbound.fail(err);
    for (const w of this.waiters.splice(0)) w.reject(err);
  }
}

/** Two connected in-memory byte streams (for tests and in-process use). */
export function memoryByteStreamPair(options: MemoryByteStreamOptions = {}): [ByteStream, ByteStream] {
  const hw = options.highWaterBytes ?? 256 * 1024;
  const a = new MemoryByteStream(hw);
  const b = new MemoryByteStream(hw);
  a.peer = b;
  b.peer = a;
  return [a, b];
}
