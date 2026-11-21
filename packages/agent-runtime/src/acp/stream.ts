/**
 * The runtime's stdio as an ACP `Stream`, stricter than the SDK's `ndJsonStream`: a line longer than
 * `maxLineBytes`, a line that isn't JSON, or JSON that isn't a JSON-RPC message ends the connection and says
 * why (`onViolation`), instead of answering a parse error and reading on. A runtime that talks nonsense is
 * broken; the turn fails and its process group is killed (bp-acp.md BP-E08).
 */
import type { Readable, Writable } from 'node:stream';
import type { AnyMessage, Stream } from '@agentclientprotocol/sdk';

/** Largest line accepted from a runtime (a session replay can carry images; 16 MiB is generous). */
export const ACP_MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface BoundedStreamOptions {
  maxLineBytes?: number;
  /** Every well-formed message from the runtime (idle timer). */
  onMessage?: () => void;
  /** The runtime broke the protocol; the stream is closed. Called once. */
  onViolation: (reason: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a parsed line is a JSON-RPC 2.0 request, notification or response. */
export function isJsonRpcMessage(value: unknown): value is AnyMessage {
  if (!isRecord(value) || value.jsonrpc !== '2.0') return false;
  if (typeof value.method === 'string') return true;
  const id = value.id;
  return (typeof id === 'string' || typeof id === 'number') && ('result' in value || 'error' in value);
}

export function boundedNdJsonStream(
  stdout: Readable,
  stdin: Writable,
  options: BoundedStreamOptions,
): Stream {
  const max = options.maxLineBytes ?? ACP_MAX_LINE_BYTES;
  let violated = false;
  /** The reader went away (the connection closed): nothing more is delivered. */
  let done = false;
  let controllerRef: ReadableStreamDefaultController<AnyMessage> | null = null;
  const violate = (reason: string) => {
    if (violated) return;
    violated = true;
    // Said first, so the caller knows why before the connection fails its pending requests.
    options.onViolation(reason);
    stdout.removeAllListeners('data');
    stdout.destroy();
    if (done) return;
    done = true;
    controllerRef?.error(new Error(reason));
  };

  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      controllerRef = controller;
      let parts: Buffer[] = [];
      let length = 0;
      const line = (bytes: Buffer) => {
        const text = bytes.toString('utf8').trim();
        if (!text) return;
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          violate('The runtime sent a line that isn’t JSON.');
          return;
        }
        if (!isJsonRpcMessage(value)) {
          violate('The runtime sent JSON that isn’t a JSON-RPC message.');
          return;
        }
        options.onMessage?.();
        if (!done) controller.enqueue(value);
      };
      stdout.on('data', (chunk: Buffer) => {
        if (violated) return;
        let start = 0;
        for (;;) {
          const nl = chunk.indexOf(0x0a, start);
          const end = nl === -1 ? chunk.length : nl;
          length += end - start;
          if (length > max) {
            violate(`The runtime sent a message larger than ${Math.round(max / 1024 / 1024)} MB.`);
            return;
          }
          parts.push(chunk.subarray(start, end));
          if (nl === -1) break;
          const whole = Buffer.concat(parts);
          parts = [];
          length = 0;
          line(whole);
          if (violated) return;
          start = nl + 1;
        }
      });
      stdout.on('end', () => {
        if (violated || done) return;
        if (length > 0) line(Buffer.concat(parts));
        if (violated || done) return;
        done = true;
        controller.close();
      });
      stdout.on('error', (err) => {
        if (violated || done) return;
        done = true;
        controller.error(err);
      });
    },
    cancel() {
      done = true;
    },
  });

  const writable = new WritableStream<AnyMessage>({
    write(message) {
      return new Promise<void>((resolve) => {
        if (stdin.destroyed || !stdin.writable) return resolve();
        // A runtime that exited mid-write (EPIPE) is reported by its exit, not here.
        stdin.write(`${JSON.stringify(message)}\n`, () => resolve());
      });
    },
    close() {
      stdin.end();
    },
  });
  stdin.on('error', () => {});
  return { readable, writable };
}
