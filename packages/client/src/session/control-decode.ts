/**
 * CONTROL messages from the appliance, tolerantly (AP-257, updates.md UP-B3b). The protocol's own decoder already
 * skips a message type this client doesn't know; this also keeps the session alive when a known message carries
 * something only a newer runtime sends:
 *
 * - an `error` (or a rejected `outcome`) with a code this client doesn't know is a generic error (`internal`, with its
 *   message; the code it came with is kept as `details.code` when the details don't name one), never a broken session;
 * - a `goaway` for an unknown reason is a planned reconnect (`overload`), a `snapshot_required` for an unknown reason a
 *   plain refetch (`overflow`), a `revoked` of an unknown scope the whole account (the broadest);
 * - anything else (an unknown member in a list, an optional field) goes through `decodeTolerant`.
 *
 * What still doesn't decode is malformed, and ends the connection as before.
 *
 * Answers are decoded with a leaner copy of the protocol's schema (`LeanApplianceMessage`): an answer's `output` (and an
 * error's `details`, a stream's `output`) is taken as it comes instead of being walked as `JsonValue`. It is the result
 * of `JSON.parse`, so it is JSON already, and the endpoint's own schema checks it next (`http/client.ts`); the walk cost
 * as much as the rest of the decoding together for a large answer on the phone. The text is decoded with the platform's
 * `TextDecoder`, not protocol's pure-JS one. The contract's schema itself stays as published.
 */
import { SESSION_MAX_CONTROL_BYTES } from '@whombat/protocol';
import {
  APPLIANCE_MESSAGE_TYPES,
  type ApplianceMessage,
  ApplianceMessage as ApplianceMessageSchema,
  type DecodeResult,
  decodeTolerant,
  ErrorMessage,
  Outcome,
  ResultMessage,
  SessionErrorCode,
  StreamDone,
} from '@whombat/protocol/session';
import { z } from 'zod';

const ERROR_CODES: ReadonlySet<string> = new Set(SessionErrorCode.options);
const GOAWAY_REASONS: ReadonlySet<string> = new Set(['rekey', 'update', 'shutdown', 'overload']);
const SNAPSHOT_REASONS: ReadonlySet<string> = new Set([
  'cursor_expired',
  'restart',
  'authz_changed',
  'overflow',
]);
const REVOKED_SCOPES: ReadonlySet<string> = new Set(['endpoint', 'account']);

/** Any parsed JSON value, as long as there is one (a JSON value can't be `undefined`). */
const present = z.unknown().refine((v) => v !== undefined, { message: 'Expected a value' });

/** The messages that carry free-form JSON, with that JSON taken as it is. */
const LEAN = new Map<unknown, z.ZodType>([
  [ResultMessage, ResultMessage.extend({ output: present })],
  [ErrorMessage, ErrorMessage.extend({ details: z.unknown().optional() })],
  [
    Outcome,
    Outcome.extend({
      result: z.object({ kind: z.enum(['ok', 'approval_required']), output: present }).optional(),
    }),
  ],
  [StreamDone, StreamDone.extend({ output: z.unknown().optional() })],
]);

/** The protocol's `ApplianceMessage`, every other member as it is. */
export const LeanApplianceMessage = z.discriminatedUnion(
  't',
  ApplianceMessageSchema.options.map(
    (o) => LEAN.get(o) ?? o,
  ) as unknown as typeof ApplianceMessageSchema.options,
) as unknown as typeof ApplianceMessageSchema;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An unknown error code → `internal`, the code kept in `details.code` where the details have none. */
function genericError(e: Json): Json {
  if (typeof e.code !== 'string' || ERROR_CODES.has(e.code)) return e;
  const details = e.details;
  return {
    ...e,
    code: 'internal',
    ...(details === undefined || (isObject(details) && details.code === undefined)
      ? { details: { ...(isObject(details) ? details : {}), code: e.code } }
      : {}),
  };
}

/** The fallbacks above, on a message whose `t` this client knows. */
export function withFallbacks(m: Json): Json {
  switch (m.t) {
    case 'error':
      return genericError(m);
    case 'outcome':
      return isObject(m.error) ? { ...m, error: genericError(m.error) } : m;
    case 'goaway':
      return typeof m.reason === 'string' && !GOAWAY_REASONS.has(m.reason) ? { ...m, reason: 'overload' } : m;
    case 'snapshot_required':
      return typeof m.reason === 'string' && !SNAPSHOT_REASONS.has(m.reason)
        ? { ...m, reason: 'overflow' }
        : m;
    case 'revoked':
      return typeof m.scope === 'string' && !REVOKED_SCOPES.has(m.scope) ? { ...m, scope: 'account' } : m;
    default:
      return m;
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

const invalid = (error: string): DecodeResult<ApplianceMessage> => ({ ok: false, kind: 'invalid', error });

/**
 * A CONTROL payload from the appliance, as protocol's `decodeApplianceMessage` reads it (the same checks and answers),
 * with the lean schema, and a second, tolerant try for a known message that failed it.
 */
export function decodeControl(payload: Uint8Array): DecodeResult<ApplianceMessage> {
  if (payload.length > SESSION_MAX_CONTROL_BYTES) return invalid('too large');
  let raw: unknown;
  try {
    raw = JSON.parse(utf8.decode(payload));
  } catch {
    return invalid('not UTF-8 JSON');
  }
  if (!isObject(raw)) return invalid('not an object');
  const t = raw.t;
  if (typeof t !== 'string' || !/^[a-z_]{1,32}$/.test(t)) return invalid('bad t');
  if (!APPLIANCE_MESSAGE_TYPES.has(t)) return { ok: false, kind: 'unknown_type', t };
  const parsed = LeanApplianceMessage.safeParse(raw);
  if (parsed.success) return { ok: true, message: parsed.data };
  const r = decodeTolerant(LeanApplianceMessage, withFallbacks(raw));
  return r.ok ? { ok: true, message: r.data } : invalid(`${t}: ${parsed.error.issues[0]?.message}`);
}
