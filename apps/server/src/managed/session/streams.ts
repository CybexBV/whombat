/**
 * Session streams with credit flow control (MA-08; docs/decisions/managed-runtime.md MR-14).
 *
 * Every non-control stream is bidirectional. Sending needs credit the peer granted (CREDIT frames, bytes);
 * `write` waits for it, so a slow client slows the file read instead of filling memory. Receiving grants the
 * peer an initial window and more only after the consumer has processed what came, so a fast client can't make
 * the appliance buffer more than one window per stream. DATA beyond the granted credit is a flow-control error
 * (RESET), as is credit above the protocol maximum.
 */
import {
  SESSION_INITIAL_STREAM_CREDIT,
  SESSION_MAX_DATA_BYTES,
  SESSION_MAX_STREAM_CREDIT,
} from '@whombat/protocol';
import { type Frame, STREAM_RESET } from '../ports';

export const MAX_STREAM_CREDIT = SESSION_MAX_STREAM_CREDIT;
/**
 * Unacknowledged bytes the appliance keeps in flight per connection, across all its streams: browsers and React
 * Native can't pause a WebSocket and fail beyond ~8 MiB buffered, so the relay path must never hold more than a
 * fraction of that for one session (the secure-channel qualification).
 */
export const CONNECTION_SEND_BUDGET = 2 * 1024 * 1024;

/** The connection-wide send budget: bytes sent on any stream and not yet credited back by the peer. */
export class SendBudget {
  #available: number;
  #waiters: (() => void)[] = [];
  constructor(readonly total = CONNECTION_SEND_BUDGET) {
    this.#available = total;
  }
  get available(): number {
    return this.#available;
  }
  /** Takes up to `wanted` bytes (at least 1), waiting while none are available. */
  async take(wanted: number, aborted: () => boolean): Promise<number> {
    while (this.#available <= 0) {
      if (aborted()) return 0;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    const n = Math.min(wanted, this.#available);
    this.#available -= n;
    return n;
  }
  release(n: number): void {
    this.#available = Math.min(this.total, this.#available + n);
    for (const w of this.#waiters.splice(0)) w();
  }
  wakeAll(): void {
    for (const w of this.#waiters.splice(0)) w();
  }
}

export class StreamReset extends Error {
  constructor(
    readonly code: number,
    message = `stream reset (${code})`,
  ) {
    super(message);
  }
}

type Send = (frame: Frame) => Promise<void>;

export class SessionStream {
  /** Bytes we may still send. */
  #sendCredit: number;
  /** Bytes the peer may still send us. */
  #recvWindow: number;
  #creditWaiters: (() => void)[] = [];
  #dataHandler: ((bytes: Uint8Array) => Promise<void> | void) | null = null;
  #endHandler: (() => void) | null = null;
  #resetHandler: ((code: number) => void) | null = null;
  #inbox: Uint8Array[] = [];
  #processing: Promise<void> = Promise.resolve();
  localEnded = false;
  remoteEnded = false;
  resetCode: number | null = null;

  /** Bytes sent and not yet credited back (returned to the connection budget as credit arrives). */
  #outstanding = 0;

  constructor(
    readonly id: number,
    private readonly send: Send,
    options: { initialSendCredit?: number; window?: number; budget?: SendBudget } = {},
    private readonly onClosed: (id: number) => void = () => {},
  ) {
    this.#sendCredit = options.initialSendCredit ?? SESSION_INITIAL_STREAM_CREDIT;
    this.#recvWindow = options.window ?? SESSION_INITIAL_STREAM_CREDIT;
    this.#budget = options.budget ?? new SendBudget(Number.MAX_SAFE_INTEGER);
  }

  readonly #budget: SendBudget;

  get closed(): boolean {
    return this.resetCode !== null || (this.localEnded && this.remoteEnded);
  }

  /** The window granted at open (the peer learns it from the open message). */
  get window(): number {
    return this.#recvWindow;
  }

  /* Sending ------------------------------------------------------------------------------------ */

  /** Sends bytes as DATA frames, waiting for credit. Throws `StreamReset` when the stream was reset. */
  async write(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.resetCode !== null) throw new StreamReset(this.resetCode);
      if (this.localEnded) throw new StreamReset(STREAM_RESET.protocolError, 'write after end');
      if (this.#sendCredit <= 0) {
        await new Promise<void>((resolve) => this.#creditWaiters.push(resolve));
        continue;
      }
      const wanted = Math.min(bytes.length - offset, this.#sendCredit, SESSION_MAX_DATA_BYTES);
      const n = await this.#budget.take(wanted, () => this.resetCode !== null);
      if (n === 0) continue;
      if (this.resetCode !== null) {
        this.#budget.release(n);
        throw new StreamReset(this.resetCode);
      }
      this.#sendCredit -= n;
      this.#outstanding += n;
      await this.send({ type: 'data', streamId: this.id, payload: bytes.subarray(offset, offset + n) });
      offset += n;
    }
  }

  async end(): Promise<void> {
    if (this.localEnded || this.resetCode !== null) return;
    this.localEnded = true;
    await this.send({ type: 'end', streamId: this.id });
    if (this.closed) {
      this.#releaseOutstanding();
      this.onClosed(this.id);
    }
  }

  async reset(code: number): Promise<void> {
    if (this.resetCode !== null) return;
    this.resetCode = code;
    this.#releaseOutstanding();
    this.#wake();
    this.#resetHandler?.(code);
    await this.send({ type: 'reset', streamId: this.id, code }).catch(() => {});
    this.onClosed(this.id);
  }

  /* Receiving ---------------------------------------------------------------------------------- */

  /**
   * Consumes DATA in order; credit is granted back only after `handler` resolved for a chunk (bounded memory).
   */
  onData(handler: (bytes: Uint8Array) => Promise<void> | void): void {
    this.#dataHandler = handler;
    const queued = this.#inbox.splice(0);
    for (const chunk of queued) this.#process(chunk);
  }

  onEnd(handler: () => void): void {
    this.#endHandler = handler;
    if (this.remoteEnded) this.#processing.then(handler);
  }

  onReset(handler: (code: number) => void): void {
    this.#resetHandler = handler;
    // Opening a file or upstream connection may finish after the peer has already cancelled.
    if (this.resetCode !== null) handler(this.resetCode);
  }

  /** A frame for this stream from the peer. Returns an error code when the peer broke the rules. */
  receive(frame: Frame): number | null {
    switch (frame.type) {
      case 'data': {
        if (this.remoteEnded || this.resetCode !== null) return STREAM_RESET.protocolError;
        if (frame.payload.length > this.#recvWindow) return STREAM_RESET.flowControl;
        this.#recvWindow -= frame.payload.length;
        if (this.#dataHandler) this.#process(frame.payload);
        else this.#inbox.push(frame.payload);
        return null;
      }
      case 'credit': {
        if (frame.credit <= 0 || this.#sendCredit + frame.credit > MAX_STREAM_CREDIT)
          return STREAM_RESET.flowControl;
        this.#sendCredit += frame.credit;
        const back = Math.min(frame.credit, this.#outstanding);
        this.#outstanding -= back;
        this.#budget.release(back);
        this.#wake();
        return null;
      }
      case 'end': {
        if (this.remoteEnded) return STREAM_RESET.protocolError;
        this.remoteEnded = true;
        const handler = this.#endHandler;
        if (handler) this.#processing = this.#processing.then(handler);
        if (this.closed) {
          this.#releaseOutstanding();
          this.onClosed(this.id);
        }
        return null;
      }
      case 'reset': {
        this.resetCode = frame.code;
        this.#releaseOutstanding();
        this.#wake();
        this.#resetHandler?.(frame.code);
        this.onClosed(this.id);
        return null;
      }
      default:
        return STREAM_RESET.protocolError;
    }
  }

  #process(chunk: Uint8Array): void {
    const handler = this.#dataHandler as (bytes: Uint8Array) => Promise<void> | void;
    this.#processing = this.#processing
      .then(async () => {
        if (this.resetCode !== null) return;
        await handler(chunk);
        if (this.resetCode !== null) return;
        this.#recvWindow += chunk.length;
        await this.send({ type: 'credit', streamId: this.id, credit: chunk.length });
      })
      .catch(async (err) => {
        await this.reset(err instanceof StreamReset ? err.code : STREAM_RESET.internal);
      });
  }

  #wake(): void {
    for (const w of this.#creditWaiters.splice(0)) w();
    this.#budget.wakeAll();
  }

  /** A closed stream gives its unacknowledged bytes back to the connection budget. */
  #releaseOutstanding(): void {
    this.#budget.release(this.#outstanding);
    this.#outstanding = 0;
  }

  /** Aborts local waits when the whole session closes. */
  abort(): void {
    if (this.resetCode === null) this.resetCode = STREAM_RESET.cancelled;
    this.#releaseOutstanding();
    this.#wake();
    this.#resetHandler?.(this.resetCode);
  }
}

/** Largest message inside a length-framed stream (collaboration, 0.4.0: `[u32 len][bytes]`, ≤ 16 MiB). */
export const MAX_FRAMED_MESSAGE_BYTES = 16 * 1024 * 1024;

/**
 * Length-prefixed messages inside a stream (`[u32 BE length][bytes]`): the collaboration stream's Yjs messages,
 * which may span DATA frames. Buffers at most one message.
 */
export class LengthFramer {
  #buf = new Uint8Array(0);
  constructor(private readonly max = MAX_FRAMED_MESSAGE_BYTES) {}

  static encode(message: Uint8Array): Uint8Array {
    const out = new Uint8Array(4 + message.length);
    new DataView(out.buffer).setUint32(0, message.length);
    out.set(message, 4);
    return out;
  }

  push(bytes: Uint8Array): Uint8Array[] {
    const joined = new Uint8Array(this.#buf.length + bytes.length);
    joined.set(this.#buf);
    joined.set(bytes, this.#buf.length);
    const out: Uint8Array[] = [];
    let offset = 0;
    while (joined.length - offset >= 4) {
      const len = new DataView(joined.buffer, joined.byteOffset + offset).getUint32(0);
      if (len > this.max) throw new StreamReset(STREAM_RESET.tooLarge, 'message too large');
      if (joined.length - offset - 4 < len) break;
      out.push(joined.slice(offset + 4, offset + 4 + len));
      offset += 4 + len;
    }
    this.#buf = joined.slice(offset);
    return out;
  }
}
