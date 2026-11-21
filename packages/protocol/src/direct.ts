/**
 * The direct connection (Whombat hermes-engine.md HE-50; CT-1250, CT-1251): a client reaches the box itself — over the
 * local network or Tailscale — instead of through the relay. The same session runs inside: Noise XX
 * (`@whombat/secure-channel`, the box's PeerId pinned), then session protocol frames. Only the outer step differs, and
 * it is smaller than the relay's: no admission ticket and no control, because the box admits a client itself from the
 * client's Noise static key.
 *
 * 1. The client opens a WebSocket to `DIRECT_PATH` on one of the box's routes (`DirectRoute.socket`, learnt in
 *    `welcome.direct`) with the subprotocol `DIRECT_SUBPROTOCOL`, and sends `DirectHello` (text, within
 *    `DIRECT_HELLO_TIMEOUT_MS`).
 * 2. The box answers `DirectWelcome` (text). From then on only binary messages pass: the Noise handshake (the client is
 *    the initiator), then the secure channel's records.
 * 3. Admission, by the box, from the Noise static key the client proved in the handshake (MA-04): an enrolled endpoint
 *    gets the `app` channel; a key the box doesn't know gets the `enroll` channel only (enrollment and recovery
 *    operations, the unenrolled budget), as through the relay; a revoked endpoint's session ends with `revoked`.
 *
 * Cross-language (JSON Schema and Go `protocol.Direct*`) like the relay's messages, so tools and the harness share them.
 */
import { z } from 'zod';
import { utf8ByteLength } from './bytes.js';
import { Edition } from './edition.js';
import { DIRECT_MAX_TEXT_MESSAGE_BYTES } from './limits.js';
import { RelayClass, RelayDrainReason } from './relay.js';
import { PeerIdString } from './session/common.js';

/** Where the box's direct listener takes the WebSocket. */
export const DIRECT_PATH = '/v1/direct';
export const DIRECT_SUBPROTOCOL = 'whombat-direct.v1';
export const DIRECT_PROTOCOL_VERSION = 1;
/**
 * The box's direct port, on its local-network addresses and its Tailscale name (HE-51: the only port the firewall opens
 * inbound, and only on the local network and `tailscale0`). The listener answers the page for browsers
 * (`DirectRoute.web`) and the WebSocket (`DIRECT_PATH`) on it. Clients use the routes the box reports, never this
 * constant: it is the default the runtime and the image agree on.
 */
export const DIRECT_PORT = 4480;

const Version = z.literal(DIRECT_PROTOCOL_VERSION);

/**
 * The answer to a plain `GET` of `DIRECT_PATH` (JSON, no session; CT-1301): which box this is, before anything else.
 * The box's page reads it first: `appliance` is the PeerId a browser pins for the Noise handshake on this origin (the page
 * came from the same place, so nothing better vouches for it); `edition` and `claimed` choose the first screen — on a
 * community box that isn't claimed, the claim (`enroll.claim.local.start`). Both are absent from a box before contracts
 * 1.1, which is `commercial` (`editionOf`). Nothing here is a secret: the console shows as much.
 */
export const DirectIdentity = z.object({
  v: Version,
  appliance: PeerIdString,
  edition: Edition.optional(),
  claimed: z.boolean().optional(),
});
export type DirectIdentity = z.infer<typeof DirectIdentity>;

/**
 * First message of a direct connection (text). `class` as through the relay: interactive and bulk traffic use separate
 * connections, so a big transfer never holds up a reply.
 */
export const DirectHello = z.object({
  t: z.literal('hello'),
  v: Version,
  class: RelayClass,
});
export type DirectHello = z.infer<typeof DirectHello>;

/**
 * The box's answer; after it, binary only. `heartbeatMs`: the box pings at this interval (a connection without traffic
 * for three of them is gone). `maxMessage`: the largest binary message either side sends (the secure channel's
 * `webSocketByteStream` `maxMessageBytes`).
 */
export const DirectWelcome = z.object({
  t: z.literal('welcome'),
  v: Version,
  heartbeatMs: z.number().int().min(1_000).max(120_000),
  maxMessage: z.number().int().min(1_024).max(16_777_216),
});
export type DirectWelcome = z.infer<typeof DirectWelcome>;

/** Messages a client sends before the binary phase. */
export const DirectUpstreamMessage = z.discriminatedUnion('t', [DirectHello]);
export type DirectUpstreamMessage = z.infer<typeof DirectUpstreamMessage>;
/** Messages the box sends before the binary phase. */
export const DirectDownstreamMessage = z.discriminatedUnion('t', [DirectWelcome]);
export type DirectDownstreamMessage = z.infer<typeof DirectDownstreamMessage>;

/**
 * WebSocket close codes of the direct listener: the relay's numbers where the meaning is the same. Whatever the code, a
 * client that can't get a session directly tries its next route, then the relay.
 */
export const DIRECT_CLOSE = {
  /** Malformed, late or unexpected hello, or text after the welcome. */
  badHello: 4400,
  /** Not taken here: the connection didn't come from the local network or Tailscale, or its Origin is refused. */
  forbidden: 4403,
  /** A message above `maxMessage`. */
  messageTooLarge: 4413,
  /** Too many connections or handshakes from this address, or the box is at capacity. */
  rateLimited: 4429,
  /** The box is restarting; the close reason carries `{"retryAfterMs":n}` (`RelayDrainReason`). */
  draining: 4503,
} as const;
export type DirectCloseName = keyof typeof DIRECT_CLOSE;
export type DirectCloseCode = (typeof DIRECT_CLOSE)[DirectCloseName];

/** Close reason of 4503: the relay's drain reason. */
export const DirectDrainReason = RelayDrainReason;
export type DirectDrainReason = RelayDrainReason;

export type DirectParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; close: typeof DIRECT_CLOSE.badHello; error: string };

function parseText<T>(text: string, schema: z.ZodType<T>): DirectParseResult<T> {
  if (utf8ByteLength(text) > DIRECT_MAX_TEXT_MESSAGE_BYTES)
    return { ok: false, close: DIRECT_CLOSE.badHello, error: 'text message too large' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, close: DIRECT_CLOSE.badHello, error: 'not JSON' };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, close: DIRECT_CLOSE.badHello, error: parsed.error.issues[0]?.message ?? 'invalid' };
  return { ok: true, value: parsed.data };
}

/** Parses a client's text message (the box's side). Failures close with 4400. */
export function parseDirectUpstream(text: string): DirectParseResult<DirectUpstreamMessage> {
  return parseText(text, DirectUpstreamMessage);
}

/** Parses the box's text message (the client's side). */
export function parseDirectDownstream(text: string): DirectParseResult<DirectDownstreamMessage> {
  return parseText(text, DirectDownstreamMessage);
}
