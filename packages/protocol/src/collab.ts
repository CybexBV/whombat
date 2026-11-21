/**
 * Collaboration stream payloads (CT-22). DATA frames of a `collab` stream carry a byte stream of Yjs messages,
 * each framed as `[u32 length BE][message]` (y-protocols: varuint type 0 sync / 1 awareness, then the body).
 * A message may span DATA frames and a frame may hold several messages; frame boundaries mean nothing.
 *
 * Bounds and credit: a message is 1..16 MiB (`COLLAB_MAX_MESSAGE_BYTES`); a length above it (or 0) is a
 * protocol error (`RESET protocolError`). Credit counts DATA payload bytes, prefixes included. The sender
 * splits the byte stream into DATA frames of ≤ 64 KiB as credit allows — it never waits for credit to cover a
 * whole message. The receiver grants credit as it consumes DATA (not per message), so a message larger than
 * the window still flows; it buffers at most one incomplete message (≤ 16 MiB + 4 bytes).
 */
import { COLLAB_MAX_MESSAGE_BYTES, SESSION_MAX_DATA_BYTES } from './limits.js';

export const COLLAB_MESSAGE_TYPE = { sync: 0, awareness: 1 } as const;

export class CollabFramingError extends Error {
  constructor(
    readonly code: 'empty_message' | 'message_too_large' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'CollabFramingError';
  }
}

function checkLength(n: number, max: number): void {
  if (n === 0) throw new CollabFramingError('empty_message', 'empty collab message');
  if (n > max) throw new CollabFramingError('message_too_large', `collab message of ${n} bytes`);
}

/**
 * `[u32 len][bytes]` for each message, concatenated. `max` bounds a message (default the collab bound; the console
 * stream uses the same framing with its own, `@whombat/protocol/console`).
 */
export function encodeCollabMessages(
  messages: readonly Uint8Array[],
  max: number = COLLAB_MAX_MESSAGE_BYTES,
): Uint8Array {
  let total = 0;
  for (const m of messages) {
    checkLength(m.length, max);
    total += 4 + m.length;
  }
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;
  for (const m of messages) {
    view.setUint32(o, m.length);
    out.set(m, o + 4);
    o += 4 + m.length;
  }
  return out;
}

/** Splits an encoded byte stream into DATA payloads of at most `maxData` bytes (default 64 KiB). */
export function collabDataPayloads(encoded: Uint8Array, maxData = SESSION_MAX_DATA_BYTES): Uint8Array[] {
  if (!Number.isInteger(maxData) || maxData < 1 || maxData > SESSION_MAX_DATA_BYTES)
    throw new RangeError(`maxData ${maxData} out of range`);
  const out: Uint8Array[] = [];
  for (let o = 0; o < encoded.length; o += maxData) out.push(encoded.subarray(o, o + maxData));
  return out;
}

/**
 * Reassembles Yjs messages from DATA payloads. After an error the stream is unusable (reset it). `max` bounds a message
 * (default the collab bound).
 */
export class CollabMessageDecoder {
  private header = new Uint8Array(4);
  private headerFill = 0;
  private message: Uint8Array | null = null;
  private messageFill = 0;
  private failed = false;

  constructor(private readonly max: number = COLLAB_MAX_MESSAGE_BYTES) {}

  /** Feeds one DATA payload; returns the messages it completes. */
  push(payload: Uint8Array): Uint8Array[] {
    if (this.failed) throw new CollabFramingError('failed', 'decoder failed earlier');
    const out: Uint8Array[] = [];
    let i = 0;
    try {
      while (i < payload.length) {
        if (!this.message) {
          const take = Math.min(4 - this.headerFill, payload.length - i);
          this.header.set(payload.subarray(i, i + take), this.headerFill);
          this.headerFill += take;
          i += take;
          if (this.headerFill < 4) break;
          const n = new DataView(this.header.buffer).getUint32(0);
          checkLength(n, this.max);
          this.message = new Uint8Array(n);
          this.messageFill = 0;
          this.headerFill = 0;
        }
        const take = Math.min(this.message.length - this.messageFill, payload.length - i);
        this.message.set(payload.subarray(i, i + take), this.messageFill);
        this.messageFill += take;
        i += take;
        if (this.messageFill === this.message.length) {
          out.push(this.message);
          this.message = null;
        }
      }
    } catch (error) {
      this.failed = true;
      this.message = null;
      throw error;
    }
    return out;
  }

  /** Bytes of an incomplete message (prefix included) waiting for more DATA. */
  get pending(): number {
    return this.message ? 4 + this.messageFill : this.headerFill;
  }
}
