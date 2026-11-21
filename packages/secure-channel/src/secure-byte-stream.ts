import type { ByteStream } from './byte-stream.js';
import { MAX_MESSAGE_BYTES, type SecureConnection } from './channel.js';
import { ClosedError } from './errors.js';

export interface SecureByteStreamOptions {
  /** `write` returns false above this many queued bytes. Default 1 MiB. */
  highWaterBytes?: number;
}

/**
 * View a `SecureConnection` as a `ByteStream`, for protocols that frame themselves — the session protocol's
 * `[u32 len][u8 type][u32 stream][payload]` frames (CT-05) of any size up to its own limit. Writes are cut into
 * records of at most `MAX_MESSAGE_BYTES` (65514); a record is delivered only once all of its bytes are
 * authenticated (records may share or span Noise frames when writes queue). Reads return record payloads in
 * order (chunk boundaries carry no meaning). An authenticated close reads as end of stream.
 *
 * Failure semantics (review M-1): if any queued piece cannot be sent (rekey threshold, transport failure,
 * flow-control or buffer limit), the connection is aborted — the peer sees a failure, never a clean end — and
 * every later `write`, `drained` and `close` on this stream rejects with that error. `close()` resolves only
 * after every written byte was handed to the connection and the authenticated close was sent.
 */
export function secureByteStream(
  connection: SecureConnection,
  options: SecureByteStreamOptions = {},
): ByteStream {
  const high = options.highWaterBytes ?? 1024 * 1024;
  const queue: Uint8Array[] = [];
  let queued = 0;
  let pumping = false;
  let failure: unknown;
  let closing = false;
  const drainWaiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  const idleWaiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  const settle = (): void => {
    if (failure !== undefined) {
      for (const w of [...drainWaiters.splice(0), ...idleWaiters.splice(0)]) w.reject(failure);
      return;
    }
    if (queued <= high / 2) for (const w of drainWaiters.splice(0)) w.resolve();
    if (queued === 0) for (const w of idleWaiters.splice(0)) w.resolve();
  };
  const fail = (err: unknown): void => {
    failure ??= err;
    queue.length = 0;
    queued = 0;
    connection.abort(err instanceof Error ? err : new Error(String(err)));
    settle();
  };

  // Surface a connection failure (e.g. DECRYPT_FAILED on a replayed record) to writers and waiters at once,
  // not only when the next queued piece is sent.
  void connection.closed.then((err) => {
    if (err) fail(err);
  });

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      for (let piece = queue.shift(); piece && failure === undefined; piece = queue.shift()) {
        await connection.send(piece);
        queued -= piece.byteLength;
        settle();
      }
    } catch (err) {
      fail(err);
    } finally {
      pumping = false;
    }
  };

  return {
    read: () => connection.receive(),
    write(chunk: Uint8Array): boolean {
      if (failure !== undefined) throw failure;
      if (closing) throw new ClosedError('write after close');
      for (let i = 0; i < chunk.byteLength; i += MAX_MESSAGE_BYTES) {
        const piece = chunk.slice(i, Math.min(i + MAX_MESSAGE_BYTES, chunk.byteLength));
        queue.push(piece);
        queued += piece.byteLength;
      }
      void pump();
      return queued < high;
    },
    drained(): Promise<void> {
      if (failure !== undefined) return Promise.reject(failure);
      if (queued <= high / 2) return Promise.resolve();
      return new Promise((resolve, reject) => drainWaiters.push({ resolve, reject }));
    },
    async close(): Promise<void> {
      if (failure !== undefined) throw failure;
      if (closing) return;
      closing = true;
      if (queued > 0) await new Promise<void>((resolve, reject) => idleWaiters.push({ resolve, reject }));
      if (failure !== undefined) throw failure;
      await connection.close();
    },
    abort(reason: Error): void {
      fail(reason);
    },
  };
}
