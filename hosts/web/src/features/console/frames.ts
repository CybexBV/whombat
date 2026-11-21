// Console frame format (CONTRACT 4, internal/wire/wire.go): every binary
// WebSocket message is one frame
//
//   kind (1 byte) | channel (uint16, big endian) | payload
//
// kind 0 = data for `channel`, kind 1 = control (JSON ConsoleControl; the
// channel field of the header is 0 and ignored).

export const FRAME_DATA = 0;
export const FRAME_CONTROL = 1;
export const FRAME_HEADER = 3;
/** wire.MaxFramePayload: larger writes are split into several frames. */
export const MAX_FRAME_PAYLOAD = 1 << 20;

export interface Frame {
  kind: number;
  channel: number;
  /** View into the received buffer (no copy). */
  payload: Uint8Array;
}

/** Closed reasons the hub sends before it closes the socket (CONTRACT 4 + hub extras). */
export type HubCloseReason =
  | 'idle_timeout'
  | 'max_age'
  | 'revoked'
  | 'remote_control_disabled'
  | 'agent_disconnected'
  | 'guest_stopped'
  | 'switched'
  | 'ended'
  | 'client_closed'
  | (string & {});

/** Browser -> agent/hub. */
export type OutgoingControl =
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'open'; channel: number }
  | { type: 'close'; channel: number }
  | { type: 'ping'; id: number }
  | { type: 'activity' };

/** Agent/hub -> browser. Fields follow wire.ConsoleControl (omitempty: zero values are absent). */
export type IncomingControl =
  | { type: 'status'; state?: string; protocol?: string; resolution?: string }
  | { type: 'opened'; channel?: number }
  | { type: 'closed'; channel?: number; reason?: HubCloseReason }
  | { type: 'pong'; id?: number }
  | { type: 'error'; code?: string; message?: string };

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesOf(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Encode one frame as a WebSocket binary message. */
export function encodeFrame(kind: number, channel: number, payload: ArrayBuffer | ArrayBufferView = new Uint8Array(0)): ArrayBuffer {
  if (!Number.isInteger(channel) || channel < 0 || channel > 0xffff) throw new RangeError(`console channel out of range: ${channel}`);
  const p = bytesOf(payload);
  if (p.byteLength > MAX_FRAME_PAYLOAD) throw new RangeError('console frame too large');
  const out = new Uint8Array(FRAME_HEADER + p.byteLength);
  out[0] = kind & 0xff;
  out[1] = (channel >> 8) & 0xff;
  out[2] = channel & 0xff;
  out.set(p, FRAME_HEADER);
  return out.buffer;
}

/** Split a data write into frames of at most MAX_FRAME_PAYLOAD bytes. */
export function encodeData(channel: number, data: ArrayBuffer | ArrayBufferView | string): ArrayBuffer[] {
  const bytes = typeof data === 'string' ? enc.encode(data) : bytesOf(data);
  if (bytes.byteLength <= MAX_FRAME_PAYLOAD) return [encodeFrame(FRAME_DATA, channel, bytes)];
  const out: ArrayBuffer[] = [];
  for (let off = 0; off < bytes.byteLength; off += MAX_FRAME_PAYLOAD) {
    out.push(encodeFrame(FRAME_DATA, channel, bytes.subarray(off, off + MAX_FRAME_PAYLOAD)));
  }
  return out;
}

export function encodeControl(c: OutgoingControl): ArrayBuffer {
  return encodeFrame(FRAME_CONTROL, 0, enc.encode(JSON.stringify(c)));
}

/** Decode one WebSocket message; null for a frame shorter than the header. */
export function decodeFrame(buf: ArrayBuffer): Frame | null {
  if (buf.byteLength < FRAME_HEADER) return null;
  const b = new Uint8Array(buf);
  return { kind: b[0]!, channel: (b[1]! << 8) | b[2]!, payload: b.subarray(FRAME_HEADER) };
}

const INCOMING = new Set(['status', 'opened', 'closed', 'pong', 'error']);

/** Parse a control payload. Unknown types and malformed JSON return null (the hub filters too). */
export function parseControl(payload: Uint8Array): IncomingControl | null {
  let v: unknown;
  try {
    v = JSON.parse(dec.decode(payload));
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.type !== 'string' || !INCOMING.has(o.type)) return null;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  const int = (k: string) => (typeof o[k] === 'number' && Number.isInteger(o[k]) ? (o[k] as number) : undefined);
  switch (o.type) {
    case 'status':
      return { type: 'status', state: str('state'), protocol: str('protocol'), resolution: str('resolution') };
    case 'opened':
      return { type: 'opened', channel: int('channel') };
    case 'closed':
      return { type: 'closed', channel: int('channel'), reason: str('reason') };
    case 'pong':
      return { type: 'pong', id: int('id') };
    default:
      return { type: 'error', code: str('code'), message: str('message') };
  }
}
