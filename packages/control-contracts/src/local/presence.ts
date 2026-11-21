/**
 * The presence socket (0.103, CT-597…CT-599; Whombat docs/decisions/desk-display.md DK-28…DK-33): the runtime → the
 * appliance's camera service `whombat-presence`, HTTP/1.1 JSON over a unix socket at `WHOMBAT_PRESENCE_SOCKET`
 * (`PRESENCE_SOCKET_DEFAULT`; unset: no presence). The service has no network, keeps no picture and stores no face: it
 * says only whether, and when, it last saw one (DK-31). It detects; it doesn't recognize.
 *
 * | Path | Request | Answer |
 * |---|---|---|
 * | `GET /v1/presence/health` | — | `PresenceHealth {v, camera, detector}` |
 * | `POST /v1/presence/watch` | `PresenceWatchRequest {v}` | `PresenceWatch {v, state, face, seenAt?, frameAt?}` |
 * | `POST /v1/presence/stop` | `PresenceStopRequest {v}` | `PresenceAck {v}` |
 *
 * The runtime watches every `DESK_PRESENCE_CHECK_S` (core) while the screen is unlocked with *Stay unlocked while you’re
 * here* on, and stops at every lock (DK-30); the service closes the camera by itself `PRESENCE_KEEP_S` after the last
 * watch. Errors are `LocalError` with the codes of `PRESENCE_ERRORS`: 400 `bad_request`, 413 `too_large` (a body over
 * `PRESENCE_REQUEST_MAX_BYTES`), 503 `unavailable`. Requests are strict, answers tolerant.
 */
import { Rfc3339 } from '@whombat/protocol/session';
import { z } from 'zod';

const V = z.literal(1);

export const PRESENCE_SOCKET_ENV = 'WHOMBAT_PRESENCE_SOCKET';
export const PRESENCE_SOCKET_DEFAULT = '/run/whombat-presence/presence.sock';

export const PRESENCE_PATHS = {
  /** GET: whether there is a camera and the detector runs. */
  health: '/v1/presence/health',
  /** Starts the camera when it isn't on, keeps it on `PRESENCE_KEEP_S` more, and says what it saw. */
  watch: '/v1/presence/watch',
  /** Closes the camera now. */
  stop: '/v1/presence/stop',
} as const;

/** The camera closes this long after the last watch by itself (DK-30). */
export const PRESENCE_KEEP_S = 6;
/** The largest request body. */
export const PRESENCE_REQUEST_MAX_BYTES = 1_024;

export const PRESENCE_ERRORS = ['bad_request', 'too_large', 'unavailable'] as const;

/** `camera`: a capture camera exists; `detector`: the model loads and runs. */
export const PresenceHealth = z.object({ v: V, camera: z.boolean(), detector: z.boolean() });
export type PresenceHealth = z.infer<typeof PresenceHealth>;

/**
 * - `starting`: the camera is opening (no frame yet); `watching`: frames arrive and are checked;
 * - `dark`: frames arrive but are too dark to find a face (the runtime treats it as no camera, DK-28);
 * - `failed`: the camera or the detector stopped working; `no_camera`: there is none.
 */
export const PRESENCE_STATES = ['starting', 'watching', 'dark', 'failed', 'no_camera'] as const;
export const PresenceState = z.enum(PRESENCE_STATES);
export type PresenceState = z.infer<typeof PresenceState>;

/**
 * What the camera sees, answered from the latest checked frame. `face`: a face in it. `seenAt`: the last frame with a
 * face since the camera came on. `frameAt`: the last frame checked.
 */
export const PresenceWatch = z.object({
  v: V,
  state: PresenceState,
  face: z.boolean(),
  seenAt: Rfc3339.optional(),
  frameAt: Rfc3339.optional(),
});
export type PresenceWatch = z.infer<typeof PresenceWatch>;

/** A watch starts the camera when it isn't on and keeps it on `PRESENCE_KEEP_S` more. */
export const PresenceWatchRequest = z.strictObject({ v: V });
export type PresenceWatchRequest = z.infer<typeof PresenceWatchRequest>;
export const PresenceStopRequest = z.strictObject({ v: V });
export type PresenceStopRequest = z.infer<typeof PresenceStopRequest>;
/** `stop` answers only the version. */
export const PresenceAck = z.object({ v: V });
export type PresenceAck = z.infer<typeof PresenceAck>;
