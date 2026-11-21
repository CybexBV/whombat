/** Encoding and decoding of CONTROL payloads (UTF-8 JSON, ≤ 64 KiB). */
import { RealtimeEvent } from '@whombat/core/contracts';
import { utf8Decode, utf8Encode } from '../bytes.js';
import { SESSION_MAX_CONTROL_BYTES } from '../limits.js';
import {
  APPLIANCE_MESSAGE_TYPES,
  ApplianceMessage,
  CLIENT_MESSAGE_TYPES,
  ClientMessage,
  type EventMessage,
  type SessionMessage,
} from './messages.js';
import { decodeTolerant } from './tolerant.js';

export type DecodeResult<T> =
  | { ok: true; message: T }
  /** A well-formed message of a type this side doesn't know (a newer minor): ignore it. */
  | { ok: false; kind: 'unknown_type'; t: string }
  /** Not JSON, too large, or schema violation: answer `error{invalid_message}` and close. */
  | { ok: false; kind: 'invalid'; error: string };

export class SessionEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionEncodeError';
  }
}

/** Validates and encodes a message as a CONTROL payload. Throws `SessionEncodeError`. */
export function encodeSessionMessage(message: SessionMessage): Uint8Array {
  const asClient = CLIENT_MESSAGE_TYPES.has(message.t) ? ClientMessage.safeParse(message) : null;
  const asAppliance =
    asClient?.success || !APPLIANCE_MESSAGE_TYPES.has(message.t) ? null : ApplianceMessage.safeParse(message);
  if (!asClient?.success && !asAppliance?.success) {
    const issue = (asAppliance ?? asClient)?.error?.issues[0];
    throw new SessionEncodeError(
      `invalid ${message.t}: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'unknown type'}`,
    );
  }
  const bytes = utf8Encode(JSON.stringify(message));
  if (bytes.length > SESSION_MAX_CONTROL_BYTES)
    throw new SessionEncodeError(
      `control message of ${bytes.length} bytes exceeds ${SESSION_MAX_CONTROL_BYTES}`,
    );
  return bytes;
}

function decodeWith<T>(
  payload: Uint8Array,
  known: ReadonlySet<string>,
  parse: (
    raw: unknown,
  ) => { success: true; data: T } | { success: false; error: { issues: { message: string }[] } },
): DecodeResult<T> {
  if (payload.length > SESSION_MAX_CONTROL_BYTES) return { ok: false, kind: 'invalid', error: 'too large' };
  let raw: unknown;
  try {
    raw = JSON.parse(utf8Decode(payload));
  } catch {
    return { ok: false, kind: 'invalid', error: 'not UTF-8 JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ok: false, kind: 'invalid', error: 'not an object' };
  const t = (raw as { t?: unknown }).t;
  if (typeof t !== 'string' || !/^[a-z_]{1,32}$/.test(t))
    return { ok: false, kind: 'invalid', error: 'bad t' };
  if (!known.has(t)) return { ok: false, kind: 'unknown_type', t };
  const parsed = parse(raw);
  if (!parsed.success)
    return { ok: false, kind: 'invalid', error: `${t}: ${parsed.error.issues[0]?.message}` };
  return { ok: true, message: parsed.data };
}

/** Appliance side: decodes a message from the client. */
export function decodeClientMessage(payload: Uint8Array): DecodeResult<ClientMessage> {
  return decodeWith(payload, CLIENT_MESSAGE_TYPES, (raw) => ClientMessage.safeParse(raw));
}

/** Client side: decodes a message from the appliance. */
export function decodeApplianceMessage(payload: Uint8Array): DecodeResult<ApplianceMessage> {
  return decodeWith(payload, APPLIANCE_MESSAGE_TYPES, (raw) => ApplianceMessage.safeParse(raw));
}

/**
 * The typed application event of an `event` message, or null for a type this client doesn't know. Decoded tolerantly
 * (CT-136): an unknown member inside a known event (a new card kind on `message.created`) is left out as
 * `decodeTolerant` does; an event it can't repair that way is null too.
 */
export function parseRealtimeEvent(message: EventMessage): RealtimeEvent | null {
  const parsed = decodeTolerant(RealtimeEvent, message.event);
  return parsed.ok ? parsed.data : null;
}
