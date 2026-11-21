/**
 * The appliance's reader of collaboration stream payloads (CT-22 framing, `[u32 len BE][Yjs message]`), bounded for
 * a hostile sender (review L-7; docs/decisions/managed-runtime.md MR-33). The protocol's `CollabMessageDecoder`
 * allocates a whole message as soon as its 4-byte length arrives (up to 16 MiB, per stream, 32 streams per session);
 * this one keeps what arrived so far as the DATA payloads themselves and copies them once when the message is
 * complete, so memory follows the bytes actually received. Console streams (contracts 0.80.1) use the same framing and
 * budget with their own bound. What an incomplete message holds counts against a
 * **per-session budget** shared by all the session's collab streams, and an awareness message (type 1) may be at most
 * `AWARENESS_MAX_BYTES`. Any violation is a framing error: the stream is reset.
 */
import { COLLAB_MAX_MESSAGE_BYTES } from '@whombat/protocol';
import { CollabFramingError } from '@whombat/protocol/collab';

/** Partially received collaboration bytes one session may hold across its streams. */
export const COLLAB_SESSION_BUDGET_BYTES = 32 * 1024 * 1024;
/** An awareness update (cursor, name, colour) is small. */
export const AWARENESS_MAX_BYTES = 64 * 1024;

/** The per-session budget (one per session connection). */
export class CollabBudget {
  used = 0;
  constructor(readonly limit = COLLAB_SESSION_BUDGET_BYTES) {}
  take(n: number): boolean {
    if (this.used + n > this.limit) return false;
    this.used += n;
    return true;
  }
  give(n: number): void {
    this.used = Math.max(0, this.used - n);
  }
}

export class BoundedCollabDecoder {
  private readonly header = new Uint8Array(4);
  private headerFill = 0;
  /** The announced length of the message being received, or 0 between messages. */
  private length = 0;
  private parts: Uint8Array[] = [];
  private received = 0;
  private failed = false;

  /**
   * `max` bounds a message (the collab bound by default; a console stream's is `CONSOLE_MAX_MESSAGE_BYTES`, contracts
   * 0.80.1); `awareness` keeps the awareness cap (collab only).
   */
  constructor(
    private readonly budget: CollabBudget,
    private readonly options: { max?: number; awareness?: boolean } = {},
  ) {}

  /** Bytes of the incomplete message held now (counted in the budget). */
  get held(): number {
    return this.received;
  }

  /** Feeds one DATA payload; returns the messages it completes. Throws `CollabFramingError`. */
  push(payload: Uint8Array): Uint8Array[] {
    if (this.failed) throw new CollabFramingError('failed', 'decoder failed earlier');
    const out: Uint8Array[] = [];
    let i = 0;
    try {
      while (i < payload.length) {
        if (this.length === 0) {
          const take = Math.min(4 - this.headerFill, payload.length - i);
          this.header.set(payload.subarray(i, i + take), this.headerFill);
          this.headerFill += take;
          i += take;
          if (this.headerFill < 4) break;
          const n = new DataView(this.header.buffer).getUint32(0);
          if (n === 0) throw new CollabFramingError('empty_message', 'empty collab message');
          if (n > (this.options.max ?? COLLAB_MAX_MESSAGE_BYTES))
            throw new CollabFramingError('message_too_large', `framed message of ${n} bytes`);
          this.length = n;
          this.headerFill = 0;
        }
        const take = Math.min(this.length - this.received, payload.length - i);
        if (!this.budget.take(take))
          throw new CollabFramingError('message_too_large', 'collaboration data over the session budget');
        // A copy: the payload buffer belongs to the frame decoder.
        this.parts.push(payload.slice(i, i + take));
        this.received += take;
        i += take;
        if (
          this.options.awareness !== false &&
          this.received === 1 &&
          this.parts[0]?.[0] === 1 &&
          this.length > AWARENESS_MAX_BYTES
        )
          throw new CollabFramingError('message_too_large', 'awareness message too large');
        if (this.received === this.length) out.push(this.complete());
      }
    } catch (err) {
      this.fail();
      throw err;
    }
    return out;
  }

  private complete(): Uint8Array {
    const message = this.parts.length === 1 ? (this.parts[0] as Uint8Array) : new Uint8Array(this.length);
    if (this.parts.length > 1) {
      let o = 0;
      for (const p of this.parts) {
        message.set(p, o);
        o += p.length;
      }
    }
    this.budget.give(this.received);
    this.parts = [];
    this.received = 0;
    this.length = 0;
    return message;
  }

  /** Gives the held bytes back to the budget (the stream ended or was reset). */
  fail(): void {
    this.failed = true;
    this.budget.give(this.received);
    this.parts = [];
    this.received = 0;
    this.length = 0;
  }
}
