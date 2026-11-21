// The wire of the runner's git relay (docs/decisions/one-person.md OP-S111): one JSON line asks, one JSON line
// answers, then the connection carries binary frames both ways until the command's `exit`:
//
//   [type u8][length u32 BE][payload]
//
// Used by `git-remote-whombat` in a command and by the runner, so it is plain JavaScript with built-in modules only.

/** Frame types. `exit` and `resize` carry JSON, `signal` a signal name, the streams raw bytes, `eof` nothing. */
export const FRAME = Object.freeze({
  stdin: 1,
  stdout: 2,
  stderr: 3,
  exit: 4,
  signal: 5,
  resize: 6,
  eof: 7,
});

/** Largest payload of one frame (bigger writes are split). */
export const MAX_FRAME = 256 * 1024;
/** Longest header line (the request or the reply). */
export const MAX_LINE = 1024 * 1024;

/** One frame as bytes; a stream payload larger than MAX_FRAME is split into several. */
export function encodeFrame(type, payload = Buffer.alloc(0)) {
  const body = typeof payload === 'string' ? Buffer.from(payload) : payload;
  const count = Math.max(1, Math.ceil(body.length / MAX_FRAME));
  const out = Buffer.allocUnsafe(body.length + count * 5);
  for (let frame = 0, at = 0; frame < count; frame++) {
    const part = body.subarray(frame * MAX_FRAME, (frame + 1) * MAX_FRAME);
    out[at] = type;
    out.writeUInt32BE(part.length, at + 1);
    out.set(part, at + 5);
    at += 5 + part.length;
  }
  return out;
}

/** A frame with a JSON payload (`exit`, `resize`). */
export function jsonFrame(type, value) {
  return encodeFrame(type, Buffer.from(JSON.stringify(value)));
}

/** Splits a byte stream into frames: `push(chunk)` returns the frames completed by it. */
export class FrameDecoder {
  #header = Buffer.alloc(5);
  #headerBytes = 0;
  #payload = null;
  #payloadBytes = 0;

  push(chunk) {
    const out = [];
    let at = 0;
    while (at < chunk.length) {
      if (this.#headerBytes < 5) {
        const n = Math.min(5 - this.#headerBytes, chunk.length - at);
        this.#header.set(chunk.subarray(at, at + n), this.#headerBytes);
        this.#headerBytes += n;
        at += n;
        if (this.#headerBytes < 5) break;
        const length = this.#header.readUInt32BE(1);
        if (length > MAX_FRAME) throw new Error(`frame too large (${length} bytes)`);
        // Allocate once after checking the bound: fragmented input must not copy the prefix again each time.
        this.#payload = Buffer.allocUnsafe(length);
      }
      const n = Math.min(this.#payload.length - this.#payloadBytes, chunk.length - at);
      this.#payload.set(chunk.subarray(at, at + n), this.#payloadBytes);
      this.#payloadBytes += n;
      at += n;
      if (this.#payloadBytes < this.#payload.length) break;
      out.push({ type: this.#header[0], payload: this.#payload });
      this.#headerBytes = 0;
      this.#payload = null;
      this.#payloadBytes = 0;
    }
    return out;
  }

  /** Bytes received but not yet a whole frame. */
  get pending() {
    return this.#headerBytes + this.#payloadBytes;
  }
}

/** Parses a frame's JSON payload, or null. */
export function frameJson(frame) {
  try {
    return JSON.parse(frame.payload.toString('utf8'));
  } catch {
    return null;
  }
}

/** One JSON line. */
export function headerLine(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

/** Signal names a frame may carry (the wrapper forwards these; anything else is refused). */
export const SIGNALS = Object.freeze([
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  'SIGQUIT',
  'SIGKILL',
  'SIGUSR1',
  'SIGUSR2',
]);
