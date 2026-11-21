/**
 * Relay protocol v1 (MA-05): the outer, cleartext-to-the-relay messages exchanged over
 * `GET /v1/connect` (WebSocket subprotocol `whombat-relay.v1`) before the connection turns into an opaque
 * binary pipe. These schemas are cross-language (docs/contracts/cross-language.md) and exported to JSON Schema and Go.
 */
import { z } from 'zod';
import { AdmissionErrorCode } from './admission.js';
import { utf8ByteLength } from './bytes.js';
import { RELAY_MAX_TEXT_MESSAGE_BYTES, RELAY_MAX_TICKET_BYTES } from './limits.js';

export const RELAY_PATH = '/v1/connect';
export const RELAY_SUBPROTOCOL = 'whombat-relay.v1';
export const RELAY_PROTOCOL_VERSION = 1;

/** Opaque ids the relay hands out or routes by (connection ids, session ids). */
export const RelayId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
export type RelayId = z.infer<typeof RelayId>;

/** Compact JWS (three base64url segments). The admission verifier checks the rest. */
export const CompactJws = z
  .string()
  .min(16)
  .max(RELAY_MAX_TICKET_BYTES)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

/** Traffic class; interactive and bulk use separate connections (no shared head-of-line blocking). */
export const RelayClass = z.enum(['interactive', 'bulk']);
export type RelayClass = z.infer<typeof RelayClass>;

/**
 * Door classes (4.3; Whombat own-address.md): a stream the relay's door hands a box on its own address. `web`: a
 * browser's TLS connection, from its ClientHello on; `acme`: a certificate authority's TLS-ALPN-01 validation.
 */
export const RelayDoorClass = z.enum(['web', 'acme']);
export type RelayDoorClass = z.infer<typeof RelayDoorClass>;
/** What a session carries: the app's classes (`RelayClass`), or a door stream (`RelayDoorClass`). */
export const RelayStreamClass = z.enum(['interactive', 'bulk', 'web', 'acme']);
export type RelayStreamClass = z.infer<typeof RelayStreamClass>;

/**
 * A door visitor's IP address as the door saw it (4.3): IPv4 dotted quad, or IPv6 in lower-case hex (no zone, no
 * brackets, no port; the relay unmaps IPv4-mapped addresses). For the box's fair sharing only, never for trust.
 */
export const RelayPeerAddress = z
  .string()
  .max(39)
  .regex(
    /^(((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])[.]){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])|[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7})$/,
  );

const Version = z.literal(RELAY_PROTOCOL_VERSION);
const RetryAfterMs = z.number().int().min(0).max(3_600_000);

/**
 * First message of every connection (text, within 10 s). Without `session`: a client connection, or the
 * appliance control connection (`rol: appliance` in the ticket). With `session`: an appliance data connection
 * answering `incoming`.
 */
export const RelayHello = z.object({
  t: z.literal('hello'),
  v: Version,
  ticket: CompactJws,
  /**
   * Required; ignored on an appliance control connection (which sends `interactive`). A client connection may name only
   * `interactive` or `bulk` (the relay closes one naming a door class with 4400); a box's data connection names the
   * class of the `incoming` it answers.
   */
  class: RelayStreamClass,
  session: RelayId.optional(),
  /**
   * Control connection only (4.3): the door classes this box takes. Absent or empty: none (every runtime before 4.3).
   * The relay sends `incoming` of a door class only to a control connection that declared it; ignored elsewhere.
   */
  accepts: z.array(RelayDoorClass).max(2).optional(),
});
export type RelayHello = z.infer<typeof RelayHello>;

/**
 * How long a box's control connection's grant holds (4.5; Whombat whombat-link.md LNK-34): unless a `renew` the relay
 * takes arrives within `renewWithinS` seconds, it closes the connection with 4401, reason `lease`.
 */
export const RelayLease = z.object({ renewWithinS: z.number().int().min(0).max(3_600) });
export type RelayLease = z.infer<typeof RelayLease>;

export const RelayWelcome = z.object({
  t: z.literal('welcome'),
  v: Version,
  conn: RelayId,
  heartbeatMs: z.number().int().min(1_000).max(120_000),
  maxMessage: z.number().int().min(1_024).max(16_777_216),
  /**
   * Control connections of a relay that takes `renew` only (4.5). Absent: an older relay, which closes a connection
   * sending `renew` with 4400, so never send one.
   */
  lease: RelayLease.optional(),
});
export type RelayWelcome = z.infer<typeof RelayWelcome>;

/** Relay → appliance control connection: a client wants a session; open a data connection with `session`. */
export const RelayIncoming = z.object({
  t: z.literal('incoming'),
  session: RelayId,
  /** A door class only to a control connection that declared it in `accepts` (4.3). */
  class: RelayStreamClass,
  /** Door sessions only (4.3): the visitor's address, for the box's fair sharing. Never for lockouts or trust. */
  src: RelayPeerAddress.optional(),
});
export type RelayIncoming = z.infer<typeof RelayIncoming>;

/** Appliance → relay (control connection): at capacity, reject the waiting client (it gets 4429). */
export const RelayRefuse = z.object({
  t: z.literal('refuse'),
  session: RelayId,
});
export type RelayRefuse = z.infer<typeof RelayRefuse>;

/** Relay → appliance control connection: the worker is shutting down; reconnect elsewhere after the delay. */
export const RelayDrain = z.object({
  t: z.literal('drain'),
  retryAfterMs: RetryAfterMs,
});
export type RelayDrain = z.infer<typeof RelayDrain>;

/** Relay → both ends of a spliced session: from now on only binary messages, forwarded unmodified. */
export const RelayReady = z.object({
  t: z.literal('ready'),
});
export type RelayReady = z.infer<typeof RelayReady>;

/**
 * Appliance → relay (control connection, 4.5): a fresh appliance ticket for the same appliance, renewing the lease
 * (route, own-address label, door classes) without reconnecting. Only after a welcome with `lease`.
 */
export const RelayRenew = z.object({
  t: z.literal('renew'),
  ticket: CompactJws,
});
export type RelayRenew = z.infer<typeof RelayRenew>;

/**
 * Why the relay didn't take a `renew` (4.5): the ticket failed admission (`AdmissionErrorCode`), or `replayed` (that
 * ticket already renewed a lease), `replay_cache_full`, `appliance_mismatch` (it names another appliance), `stale`
 * (it expires before the grant it would replace), `rate` (renewing too often).
 */
export const RelayRenewRefusal = z.enum([
  ...AdmissionErrorCode.options,
  'replayed',
  'replay_cache_full',
  'appliance_mismatch',
  'stale',
  'rate',
]);
export type RelayRenewRefusal = z.infer<typeof RelayRenewRefusal>;

/** Relay → appliance control connection (4.5): the renew was taken; the lease runs from this message. */
export const RelayRenewed = z.object({
  t: z.literal('renewed'),
  lease: RelayLease,
});
export type RelayRenewed = z.infer<typeof RelayRenewed>;

/** Relay → appliance control connection (4.5): the renew wasn't taken; the lease is unchanged. */
export const RelayRenewRefused = z.object({
  t: z.literal('renew_refused'),
  reason: RelayRenewRefusal,
  lease: RelayLease,
});
export type RelayRenewRefused = z.infer<typeof RelayRenewRefused>;

/** Messages a client or appliance sends to the relay. */
export const RelayUpstreamMessage = z.discriminatedUnion('t', [RelayHello, RelayRefuse, RelayRenew]);
export type RelayUpstreamMessage = z.infer<typeof RelayUpstreamMessage>;
/** Messages the relay sends. */
export const RelayDownstreamMessage = z.discriminatedUnion('t', [
  RelayWelcome,
  RelayIncoming,
  RelayDrain,
  RelayReady,
  RelayRenewed,
  RelayRenewRefused,
]);
export type RelayDownstreamMessage = z.infer<typeof RelayDownstreamMessage>;

/** WebSocket close codes used by the relay. Close of one side of a spliced session is forwarded to the other. */
export const RELAY_CLOSE = {
  /** Malformed, late or unexpected hello / text message. */
  badHello: 4400,
  /**
   * Missing, malformed, badly signed or expired ticket; also closes a control connection whose lease ran out (close
   * reason `lease`, 4.5): get a fresh ticket and connect again.
   */
  badTicket: 4401,
  /** Origin not allowed, or the ticket role does not match the connection kind. */
  forbidden: 4403,
  /**
   * No control connection for the ticket's appliance; also closes an appliance data connection whose `session`
   * is unknown or expired.
   */
  applianceOffline: 4404,
  /**
   * A single-use client ticket (`jti`) was presented again; also closes an appliance control connection that a
   * newer control connection for the same `apl` superseded (close reason `superseded`).
   */
  replayedTicket: 4409,
  /** A message above `maxMessage`. */
  messageTooLarge: 4413,
  /** The ticket names another relay worker (`wrk`); close reason `wrong_worker`. Get a fresh ticket. */
  wrongWorker: 4421,
  /** Rate limit, quota or appliance capacity (`refuse`). */
  rateLimited: 4429,
  /** Worker draining; the close reason carries `{"retryAfterMs":n}`. */
  draining: 4503,
  /** The appliance didn't open the data connection within 10 s. */
  applianceDidNotJoin: 4504,
  /** The receiver made no progress for 30 s with a full buffer. */
  slowConsumer: 4508,
} as const;
export type RelayCloseName = keyof typeof RELAY_CLOSE;
/** Close reason of 4401 when a control connection's lease ran out without a renewal (4.5). */
export const RELAY_CLOSE_REASON_LEASE = 'lease';
/**
 * How long past its ticket's `exp` a label and its door streams outlive a lapsed lease (4.5): a box that reconnects
 * within it keeps its door streams.
 */
export const RELAY_LEASE_MARGIN_S = 60;
export type RelayCloseCode = (typeof RELAY_CLOSE)[RelayCloseName];
export const RelayCloseCode = z.union(
  Object.values(RELAY_CLOSE).map((c) => z.literal(c)) as unknown as [
    z.ZodLiteral<RelayCloseCode>,
    ...z.ZodLiteral<RelayCloseCode>[],
  ],
);

/** Close reason of 4503 (JSON text, ≤ 123 bytes as WebSocket requires). */
export const RelayDrainReason = z.object({ retryAfterMs: RetryAfterMs });
export type RelayDrainReason = z.infer<typeof RelayDrainReason>;

export type RelayParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; close: RelayCloseCode; error: string };

function parseText<T>(text: string, schema: z.ZodType<T>): RelayParseResult<T> {
  if (utf8ByteLength(text) > RELAY_MAX_TEXT_MESSAGE_BYTES)
    return { ok: false, close: RELAY_CLOSE.badHello, error: 'text message too large' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, close: RELAY_CLOSE.badHello, error: 'not JSON' };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, close: RELAY_CLOSE.badHello, error: parsed.error.issues[0]?.message ?? 'invalid' };
  return { ok: true, value: parsed.data };
}

/** Parses a text message from a client/appliance (relay side). Failures map to 4400. */
export function parseRelayUpstream(text: string): RelayParseResult<RelayUpstreamMessage> {
  return parseText(text, RelayUpstreamMessage);
}

/** Parses a text message from the relay (client/appliance side). */
export function parseRelayDownstream(text: string): RelayParseResult<RelayDownstreamMessage> {
  return parseText(text, RelayDownstreamMessage);
}
