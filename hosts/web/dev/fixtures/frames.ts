// Console frame codec of the fixture server (internal/wire/wire.go): every
// binary WebSocket message is one frame
//
//   kind (1 byte) | channel (uint16, big endian) | payload
//
// kind 0 = data for the channel, kind 1 = control (JSON ConsoleControl).

export const FRAME_DATA = 0;
export const FRAME_CONTROL = 1;
export const FRAME_HEADER = 3;
export const MAX_FRAME_PAYLOAD = 1 << 20;

export interface Frame {
  kind: number;
  channel: number;
  payload: Buffer;
}

/** wire.ConsoleControl; zero values are omitted like Go's omitempty. */
export interface ConsoleControl {
  type: string;
  channel?: number;
  cols?: number;
  rows?: number;
  id?: number;
  state?: string;
  protocol?: string;
  resolution?: string;
  code?: string;
  message?: string;
  reason?: string;
}

export function encodeFrame(kind: number, channel: number, payload: Uint8Array = new Uint8Array(0)): Buffer {
  if (!Number.isInteger(channel) || channel < 0 || channel > 0xffff) throw new RangeError(`console channel out of range: ${channel}`);
  if (payload.byteLength > MAX_FRAME_PAYLOAD) throw new RangeError('console frame too large');
  const out = Buffer.allocUnsafe(FRAME_HEADER + payload.byteLength);
  out[0] = kind & 0xff;
  out.writeUInt16BE(channel, 1);
  out.set(payload, FRAME_HEADER);
  return out;
}

/** Data for a channel, split into frames of at most 1 MiB. */
export function encodeData(channel: number, data: Uint8Array | string): Buffer[] {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  if (bytes.byteLength <= MAX_FRAME_PAYLOAD) return [encodeFrame(FRAME_DATA, channel, bytes)];
  const out: Buffer[] = [];
  for (let off = 0; off < bytes.byteLength; off += MAX_FRAME_PAYLOAD) {
    out.push(encodeFrame(FRAME_DATA, channel, bytes.subarray(off, off + MAX_FRAME_PAYLOAD)));
  }
  return out;
}

export function encodeControl(c: ConsoleControl): Buffer {
  const clean: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v !== undefined && v !== '' && v !== 0) clean[k] = v as string | number;
  }
  return encodeFrame(FRAME_CONTROL, 0, Buffer.from(JSON.stringify(clean), 'utf8'));
}

/** Decode one message; null when shorter than the header. */
export function decodeFrame(buf: Buffer): Frame | null {
  if (buf.byteLength < FRAME_HEADER) return null;
  return { kind: buf[0]!, channel: buf.readUInt16BE(1), payload: buf.subarray(FRAME_HEADER) };
}

/** Parse a control payload; null for malformed JSON or a missing type. */
export function parseControl(payload: Uint8Array): ConsoleControl | null {
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(payload).toString('utf8'));
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.type !== 'string') return null;
  const out: ConsoleControl = { type: o.type };
  for (const k of ['channel', 'cols', 'rows', 'id'] as const) {
    const n = o[k];
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = Math.trunc(n);
  }
  for (const k of ['state', 'protocol', 'resolution', 'code', 'message', 'reason'] as const) {
    const s = o[k];
    if (typeof s === 'string') out[k] = s;
  }
  return out;
}
