/**
 * Session protocol v1 frames (MA-08), carried inside the Noise channel's byte stream.
 *
 * Wire form (CT-05): `[u32 length BE][u8 type][u32 streamId BE][payload]`, where `length` counts the type,
 * stream id and payload (so it is at least 5). The Noise transport is a byte stream (its messages may split or
 * join frames), so each frame carries its length; the body is exactly MA-08's `[type][streamId][payload]`.
 *
 * | type | name    | stream | payload                                   |
 * |------|---------|--------|-------------------------------------------|
 * | 0x01 | CONTROL | 0      | UTF-8 JSON `SessionMessage`, 1..64 KiB     |
 * | 0x02 | DATA    | ≠ 0    | stream bytes, 1..64 KiB                    |
 * | 0x03 | CREDIT  | ≠ 0    | u32 BE bytes granted, 1..16 MiB            |
 * | 0x04 | END     | ≠ 0    | empty (the sender's half of the stream is done) |
 * | 0x05 | RESET   | ≠ 0    | u16 BE `STREAM_RESET` code (abort both halves) |
 *
 * Stream ids: 0 is the control stream; streams opened by the client are odd, by the appliance even (non-zero).
 */
import {
  FRAME_HEADER_BYTES,
  SESSION_MAX_CONTROL_BYTES,
  SESSION_MAX_DATA_BYTES,
  SESSION_MAX_FRAME_BODY_BYTES,
  SESSION_MAX_STREAM_CREDIT,
} from './limits.js';

export const FRAME_TYPE = {
  control: 0x01,
  data: 0x02,
  credit: 0x03,
  end: 0x04,
  reset: 0x05,
} as const;
export type FrameTypeName = keyof typeof FRAME_TYPE;

export const CONTROL_STREAM_ID = 0;
export const MAX_STREAM_ID = 0xffff_ffff;

/** RESET codes (u16). */
export const STREAM_RESET = {
  /** The opener or receiver no longer wants the stream. */
  cancelled: 1,
  /** The stream could not be opened (unknown resource, not allowed, too many streams). */
  refused: 2,
  /** DATA beyond the granted credit, or credit above the maximum window. */
  flowControl: 3,
  /** Size above the announced or allowed size. */
  tooLarge: 4,
  /** A chunk or the whole transfer failed its sha256 check. */
  integrity: 5,
  notFound: 6,
  forbidden: 7,
  /** The deadline or an idle timer expired. */
  timeout: 8,
  /** Frames that break the stream rules (DATA after END, …). */
  protocolError: 9,
  internal: 10,
} as const;
export type StreamResetName = keyof typeof STREAM_RESET;

export type Frame =
  | { type: 'control'; streamId: 0; payload: Uint8Array }
  | { type: 'data'; streamId: number; payload: Uint8Array }
  | { type: 'credit'; streamId: number; credit: number }
  | { type: 'end'; streamId: number }
  | { type: 'reset'; streamId: number; code: number };

export type FrameErrorCode =
  | 'frame_too_large'
  | 'frame_too_short'
  | 'unknown_type'
  | 'bad_stream'
  | 'bad_payload'
  | 'buffer_overflow';

export class FrameError extends Error {
  constructor(
    readonly code: FrameErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FrameError';
  }
}

function checkStream(streamId: number, type: FrameTypeName): void {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > MAX_STREAM_ID)
    throw new FrameError('bad_stream', `stream id ${streamId} out of range`);
  if (type === 'control' ? streamId !== 0 : streamId === 0)
    throw new FrameError('bad_stream', `${type} frame on stream ${streamId}`);
}

function checkPayload(type: FrameTypeName, length: number): void {
  const bad = (m: string) => new FrameError('bad_payload', `${type}: ${m}`);
  switch (type) {
    case 'control':
      if (length < 1) throw bad('empty');
      if (length > SESSION_MAX_CONTROL_BYTES)
        throw new FrameError('frame_too_large', 'control payload too large');
      return;
    case 'data':
      if (length < 1) throw bad('empty');
      if (length > SESSION_MAX_DATA_BYTES) throw new FrameError('frame_too_large', 'data payload too large');
      return;
    case 'credit':
      if (length !== 4) throw bad('must be 4 bytes');
      return;
    case 'end':
      if (length !== 0) throw bad('must be empty');
      return;
    case 'reset':
      if (length !== 2) throw bad('must be 2 bytes');
      return;
  }
}

const TYPE_NAMES: Record<number, FrameTypeName> = Object.fromEntries(
  Object.entries(FRAME_TYPE).map(([name, code]) => [code, name as FrameTypeName]),
);

/** Encodes one frame including its length prefix. Throws `FrameError` on invalid frames. */
export function encodeFrame(frame: Frame): Uint8Array {
  checkStream(frame.streamId, frame.type);
  let payload: Uint8Array;
  switch (frame.type) {
    case 'control':
    case 'data':
      payload = frame.payload;
      break;
    case 'credit':
      if (!Number.isInteger(frame.credit) || frame.credit < 1 || frame.credit > SESSION_MAX_STREAM_CREDIT)
        throw new FrameError('bad_payload', `credit ${frame.credit} out of range`);
      payload = new Uint8Array(4);
      new DataView(payload.buffer).setUint32(0, frame.credit);
      break;
    case 'end':
      payload = new Uint8Array(0);
      break;
    case 'reset':
      if (!Number.isInteger(frame.code) || frame.code < 0 || frame.code > 0xffff)
        throw new FrameError('bad_payload', `reset code ${frame.code} out of range`);
      payload = new Uint8Array(2);
      new DataView(payload.buffer).setUint16(0, frame.code);
      break;
  }
  checkPayload(frame.type, payload.length);
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 5 + payload.length);
  view.setUint8(4, FRAME_TYPE[frame.type]);
  view.setUint32(5, frame.streamId);
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

/** Decodes a frame body (`[type][streamId][payload]`, without the length prefix). */
export function decodeFrameBody(body: Uint8Array): Frame {
  if (body.length < 5) throw new FrameError('frame_too_short', 'frame body shorter than 5 bytes');
  if (body.length > SESSION_MAX_FRAME_BODY_BYTES) throw new FrameError('frame_too_large', 'frame too large');
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const type = TYPE_NAMES[view.getUint8(0)];
  if (!type) throw new FrameError('unknown_type', `unknown frame type 0x${view.getUint8(0).toString(16)}`);
  const streamId = view.getUint32(1);
  checkStream(streamId, type);
  const payload = body.subarray(5);
  checkPayload(type, payload.length);
  switch (type) {
    case 'control':
      return { type, streamId: 0, payload };
    case 'data':
      return { type, streamId, payload };
    case 'credit': {
      const credit = view.getUint32(5);
      if (credit < 1 || credit > SESSION_MAX_STREAM_CREDIT)
        throw new FrameError('bad_payload', `credit ${credit} out of range`);
      return { type, streamId, credit };
    }
    case 'end':
      return { type, streamId };
    case 'reset':
      return { type, streamId, code: view.getUint16(5) };
  }
}

/**
 * Incremental decoder for the byte stream. Buffers at most one frame (≤ 9 + 64 KiB) and rejects an announced
 * length above the limit before buffering it. After a `FrameError` the stream is unusable (close the session).
 * Linear in the input however it is fragmented: a frame's body is allocated once, when its length is known, and
 * each input byte is copied once.
 */
export class FrameDecoder {
  private readonly header = new Uint8Array(4);
  private headerFill = 0;
  private body: Uint8Array | undefined;
  private bodyFill = 0;
  private failed = false;

  /** Feeds bytes; returns the complete frames they finish. */
  push(chunk: Uint8Array): Frame[] {
    if (this.failed) throw new FrameError('buffer_overflow', 'decoder failed earlier');
    const frames: Frame[] = [];
    let offset = 0;
    try {
      while (offset < chunk.length) {
        if (!this.body) {
          const take = Math.min(4 - this.headerFill, chunk.length - offset);
          this.header.set(chunk.subarray(offset, offset + take), this.headerFill);
          this.headerFill += take;
          offset += take;
          if (this.headerFill < 4) break;
          const length = new DataView(this.header.buffer).getUint32(0);
          if (length < 5) throw new FrameError('frame_too_short', `frame length ${length}`);
          if (length > SESSION_MAX_FRAME_BODY_BYTES)
            throw new FrameError('frame_too_large', `frame length ${length}`);
          this.body = new Uint8Array(length);
          this.bodyFill = 0;
        }
        const take = Math.min(this.body.length - this.bodyFill, chunk.length - offset);
        this.body.set(chunk.subarray(offset, offset + take), this.bodyFill);
        this.bodyFill += take;
        offset += take;
        if (this.bodyFill === this.body.length) {
          const body = this.body;
          this.body = undefined;
          this.headerFill = 0;
          frames.push(decodeFrameBody(body));
        }
      }
    } catch (error) {
      this.failed = true;
      this.body = undefined;
      this.headerFill = 0;
      throw error;
    }
    return frames;
  }

  /** Bytes of an incomplete frame waiting for more input. */
  get pending(): number {
    return this.body ? 4 + this.bodyFill : this.headerFill;
  }
}
