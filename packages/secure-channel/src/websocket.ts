import { type ByteStream, InboundQueue } from './byte-stream.js';
import { ClosedError, FrameTooLargeError, ProtocolError, TransportError } from './errors.js';

/**
 * The subset of the WHATWG `WebSocket` we use. Satisfied by browser `WebSocket`, React Native `WebSocket`
 * and the Node `ws` package (which additionally has `pause`/`resume`, used for receive backpressure).
 *
 * `bufferedAmount` may be missing: React Native (0.86) declares it but never assigns it, so it reads
 * `undefined` (review M-2). The adapter then applies no transport-level send backpressure; memory stays bounded
 * by the channel's flow-control window (`INITIAL_WINDOW_BYTES` / `receiveWindowBytes`), which limits the
 * bytes in flight end to end regardless of the socket.
 */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  // biome-ignore lint/suspicious/noExplicitAny: event shapes differ between browser, RN and ws
  addEventListener(type: 'message' | 'close' | 'error', listener: (event: any) => void): void;
  // biome-ignore lint/suspicious/noExplicitAny: event shapes differ between browser, RN and ws
  removeEventListener(type: 'message' | 'close' | 'error', listener: (event: any) => void): void;
  pause?: () => void;
  resume?: () => void;
}

export interface WebSocketByteStreamOptions {
  /**
   * Largest binary WebSocket message accepted or sent. Default 262144 (relay protocol v1 `maxMessage`).
   * Larger inbound messages fail the stream with `FrameTooLargeError` and close code 1009.
   * (Browsers allocate a message before we see it; Node `ws` servers should also set `maxPayload`.)
   */
  maxMessageBytes?: number;
  /**
   * Outbound: `write` returns false while `bufferedAmount` exceeds this. Default 1 MiB. Ignored when the socket
   * does not report a numeric `bufferedAmount` (React Native).
   */
  sendHighWaterBytes?: number;
  /** Inbound: pause the socket (if it supports `pause`) above this many unread bytes. Default 1 MiB. */
  receiveHighWaterBytes?: number;
  /** Inbound hard cap on unread bytes; exceeding it fails with `BufferOverflowError`. Default 8 MiB. */
  maxBufferedBytes?: number;
  /** Poll interval for `bufferedAmount` while waiting for drain (browsers have no drain event). Default 4 ms. */
  drainPollMs?: number;
}

const OPEN = 1;

/**
 * Wrap an OPEN WebSocket that carries only binary messages (i.e. after the relay's `ready`) as a
 * `ByteStream`. Create it synchronously in the handler that observed `ready` so no message is missed.
 * A text message after that point is a protocol error (relay protocol v1).
 */
export function webSocketByteStream(
  socket: WebSocketLike,
  options: WebSocketByteStreamOptions = {},
): ByteStream {
  if (socket.readyState !== OPEN) throw new TransportError('WebSocket is not open');
  const maxMessage = options.maxMessageBytes ?? 262_144;
  const sendHigh = options.sendHighWaterBytes ?? 1024 * 1024;
  const pollMs = options.drainPollMs ?? 4;
  socket.binaryType = 'arraybuffer';
  // Transport backpressure only where the socket reports its queue (browsers, Node ws). See WebSocketLike.
  const buffered = (): number => {
    const n = socket.bufferedAmount;
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  };

  const canPause = typeof socket.pause === 'function' && typeof socket.resume === 'function';
  const inbound = new InboundQueue(
    {
      highWaterBytes: options.receiveHighWaterBytes ?? 1024 * 1024,
      maxBufferedBytes: options.maxBufferedBytes ?? 8 * 1024 * 1024,
    },
    canPause ? { onHigh: () => socket.pause?.(), onLow: () => socket.resume?.() } : {},
  );

  let failure: Error | undefined;
  let closing = false;
  let closedResolve: (() => void) | undefined;
  const closedPromise = new Promise<void>((r) => {
    closedResolve = r;
  });

  const fail = (err: Error, code?: number): void => {
    if (failure) return;
    failure = err;
    inbound.fail(err);
    detach();
    try {
      if (socket.readyState === OPEN || socket.readyState === 0)
        socket.close(code ?? 1011, err.name.slice(0, 60));
    } catch {
      // closing an already failed socket may throw in some runtimes
    }
    closedResolve?.();
  };

  // biome-ignore lint/suspicious/noExplicitAny: see WebSocketLike
  const onMessage = (event: any): void => {
    const data: unknown = event?.data;
    let chunk: Uint8Array;
    if (data instanceof ArrayBuffer) chunk = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) chunk = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else {
      fail(new ProtocolError('text or unsupported WebSocket message on a binary stream'), 1003);
      return;
    }
    if (chunk.byteLength > maxMessage) {
      fail(new FrameTooLargeError(chunk.byteLength, maxMessage, 'WebSocket message'), 1009);
      return;
    }
    if (!inbound.push(chunk)) fail(new TransportError('inbound buffer overflow'), 1008);
  };
  // biome-ignore lint/suspicious/noExplicitAny: see WebSocketLike
  const onClose = (event: any): void => {
    detach();
    const code: number = typeof event?.code === 'number' ? event.code : 1006;
    if (code === 1000 || (closing && code === 1005)) inbound.end();
    else {
      // The close reason is peer/relay-controlled text: keep a short printable-ASCII excerpt only (review I-8).
      const reason =
        typeof event?.reason === 'string' ? event.reason.replace(/[^\x20-\x7e]/g, '?').slice(0, 64) : '';
      const err = new TransportError(`WebSocket closed with code ${code}${reason ? ` (${reason})` : ''}`);
      failure ??= err;
      inbound.fail(err);
    }
    closedResolve?.();
  };
  const onError = (): void => {
    fail(new TransportError('WebSocket error'));
  };
  const detach = (): void => {
    socket.removeEventListener('message', onMessage);
    socket.removeEventListener('error', onError);
  };
  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', onClose);
  socket.addEventListener('error', onError);

  return {
    read: () => inbound.read(),
    write(chunk: Uint8Array): boolean {
      if (failure) throw failure;
      if (closing || socket.readyState !== OPEN) throw new ClosedError('write after close');
      for (let i = 0; i < chunk.byteLength; i += maxMessage) {
        socket.send(chunk.subarray(i, Math.min(i + maxMessage, chunk.byteLength)) as Uint8Array<ArrayBuffer>);
      }
      return buffered() < sendHigh;
    },
    drained(): Promise<void> {
      return new Promise((resolve, reject) => {
        const check = (): void => {
          if (failure) reject(failure);
          else if (socket.readyState !== OPEN)
            reject(new ClosedError('socket closed while waiting for drain'));
          else if (buffered() <= sendHigh / 2) resolve();
          else setTimeout(check, pollMs);
        };
        check();
      });
    },
    async close(): Promise<void> {
      if (closing || failure) return;
      closing = true;
      // Messages sent before close() are transmitted before the close frame.
      if (socket.readyState === OPEN) socket.close(1000, 'bye');
      await closedPromise;
    },
    abort(reason: Error): void {
      fail(reason);
    },
  };
}
