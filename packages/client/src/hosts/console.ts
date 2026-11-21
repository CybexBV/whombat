/**
 * Console frames (the hosts service's wire format, ported from Rackoon's `features/console/frames.ts`): every binary
 * WebSocket message is `kind (1 byte) | channel (uint16 BE) | payload`; kind 0 is data for the channel, kind 1 a JSON
 * control. Whombat proxies the frames unchanged (contracts 0.80 `HostConsoleSession`), so this is pure and shared; the
 * web's transport (`features/things/console/transport.ts`) speaks it over `whombat.console.v1`. Also the words for why
 * a console closed.
 */
import {
  HOSTS_CONSOLE_SUBPROTOCOL,
  HOSTS_CONSOLE_TOKEN_PREFIX,
  type HostConsoleSession,
} from '@whombat/core/domain';

export const FRAME_DATA = 0;
export const FRAME_CONTROL = 1;
export const FRAME_HEADER = 3;
/** Larger writes are split into several frames. */
export const MAX_FRAME_PAYLOAD = 1 << 20;

export interface Frame {
  kind: number;
  channel: number;
  payload: Uint8Array;
}

/** Browser → agent. */
export type OutgoingControl =
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'open'; channel: number }
  | { type: 'close'; channel: number }
  | { type: 'ping'; id: number }
  | { type: 'activity' };

/** Agent → browser. */
export type IncomingControl =
  | { type: 'status'; state?: string; protocol?: string; resolution?: string }
  | { type: 'opened'; channel?: number }
  | { type: 'closed'; channel?: number; reason?: string }
  | { type: 'pong'; id?: number }
  | { type: 'error'; code?: string; message?: string };

// Made on first use: a runtime without `TextDecoder` (older React Native) can still import the rest of the module.
let encoder: TextEncoder | null = null;
let decoder: TextDecoder | null = null;
const enc = () => {
  encoder ??= new TextEncoder();
  return encoder;
};
const dec = () => {
  decoder ??= new TextDecoder();
  return decoder;
};

function bytesOf(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function encodeFrame(
  kind: number,
  channel: number,
  payload: ArrayBuffer | ArrayBufferView = new Uint8Array(0),
): ArrayBuffer {
  if (!Number.isInteger(channel) || channel < 0 || channel > 0xffff)
    throw new RangeError(`console channel out of range: ${channel}`);
  const p = bytesOf(payload);
  if (p.byteLength > MAX_FRAME_PAYLOAD) throw new RangeError('console frame too large');
  const out = new Uint8Array(FRAME_HEADER + p.byteLength);
  out[0] = kind & 0xff;
  out[1] = (channel >> 8) & 0xff;
  out[2] = channel & 0xff;
  out.set(p, FRAME_HEADER);
  return out.buffer;
}

/** A data write as frames of at most `MAX_FRAME_PAYLOAD` bytes. */
export function encodeData(channel: number, data: ArrayBuffer | ArrayBufferView | string): ArrayBuffer[] {
  const bytes = typeof data === 'string' ? enc().encode(data) : bytesOf(data);
  if (bytes.byteLength <= MAX_FRAME_PAYLOAD) return [encodeFrame(FRAME_DATA, channel, bytes)];
  const out: ArrayBuffer[] = [];
  for (let off = 0; off < bytes.byteLength; off += MAX_FRAME_PAYLOAD)
    out.push(encodeFrame(FRAME_DATA, channel, bytes.subarray(off, off + MAX_FRAME_PAYLOAD)));
  return out;
}

export function encodeControl(c: OutgoingControl): ArrayBuffer {
  return encodeFrame(FRAME_CONTROL, 0, enc().encode(JSON.stringify(c)));
}

/** One message as a frame; null when shorter than the header. */
export function decodeFrame(buf: ArrayBuffer): Frame | null {
  if (buf.byteLength < FRAME_HEADER) return null;
  const b = new Uint8Array(buf);
  return { kind: b[0] ?? 0, channel: ((b[1] ?? 0) << 8) | (b[2] ?? 0), payload: b.subarray(FRAME_HEADER) };
}

const INCOMING = new Set(['status', 'opened', 'closed', 'pong', 'error']);

/** A control payload; unknown types and bad JSON are null. */
export function parseControl(payload: Uint8Array): IncomingControl | null {
  let v: unknown;
  try {
    v = JSON.parse(dec().decode(payload));
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.type !== 'string' || !INCOMING.has(o.type)) return null;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  const int = (k: string) =>
    typeof o[k] === 'number' && Number.isInteger(o[k]) ? (o[k] as number) : undefined;
  switch (o.type) {
    case 'status':
      return {
        type: 'status',
        state: str('state'),
        protocol: str('protocol'),
        resolution: str('resolution'),
      };
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

/** The subprotocols a console WebSocket offers (contracts 0.80). */
export function consoleSubprotocols(session: Pick<HostConsoleSession, 'token'>): string[] {
  return [HOSTS_CONSOLE_SUBPROTOCOL, `${HOSTS_CONSOLE_TOKEN_PREFIX}${session.token}`];
}

/** The console WebSocket's URL on an origin (`https://box.lan` → `wss://box.lan/api/v1/…`). */
export function consoleSocketUrl(session: Pick<HostConsoleSession, 'path'>, origin: string): string {
  const u = new URL(origin);
  const scheme = u.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = session.path.startsWith('/api/') ? session.path : `/api/v1${session.path}`;
  return `${scheme}//${u.host}${path}`;
}

/** Why a console closed, in plain words (empty when there is nothing to say). */
export function consoleCloseText(reason: string | null | undefined): string {
  switch (reason) {
    case 'idle_timeout':
      return 'Closed after 15 minutes without typing.';
    case 'max_age':
      return 'This console was open for as long as it may be.';
    case 'revoked':
      return 'Someone closed this console.';
    case 'remote_control_disabled':
      return 'Consoles were switched off for this server.';
    case 'agent_disconnected':
      return 'The server stopped answering.';
    case 'guest_stopped':
      return 'The guest was switched off.';
    case 'ended':
      return 'The session ended.';
    default:
      return '';
  }
}
