/**
 * Size, time and count limits of relay protocol v1 (MA-05), admission tickets (MA-06) and session protocol v1
 * (MA-08). Every parser in this package enforces them; the Go bindings export the same values.
 */

/* Relay (outer) ---------------------------------------------------------------------------------- */

/** Largest WebSocket message the relay accepts or forwards (256 KiB). */
export const RELAY_MAX_MESSAGE_BYTES = 262_144;
/** Largest text message before `ready` (hello, welcome, control); far below the binary limit. */
export const RELAY_MAX_TEXT_MESSAGE_BYTES = 8_192;
/** Buffered bytes per direction per spliced session before reading pauses (1 MiB). */
export const RELAY_MAX_BUFFERED_BYTES = 1_048_576;
/** The client/appliance must send `hello` within this time of the WebSocket opening. */
export const RELAY_HELLO_TIMEOUT_MS = 10_000;
/** The appliance must open the data connection within this time of `incoming`. */
export const RELAY_JOIN_TIMEOUT_MS = 10_000;
/** WebSocket ping interval announced in `welcome`. */
export const RELAY_HEARTBEAT_MS = 20_000;
/** A connection without traffic (pongs count) closes after this long. */
export const RELAY_IDLE_TIMEOUT_MS = 120_000;
/** A receiver that makes no progress for this long is closed with 4508. */
export const RELAY_SLOW_CONSUMER_MS = 30_000;
/** Concurrent spliced sessions per appliance. */
export const RELAY_MAX_SESSIONS_PER_APPLIANCE = 64;
/** Largest admission ticket (compact JWS) accepted in `hello`. */
export const RELAY_MAX_TICKET_BYTES = 4_096;

/* Direct (outer, HE-50) -------------------------------------------------------------------------- */

/** Largest text message of the direct listener (hello, welcome). */
export const DIRECT_MAX_TEXT_MESSAGE_BYTES = 1_024;
/** The client must send `hello` within this time of the WebSocket opening. */
export const DIRECT_HELLO_TIMEOUT_MS = 10_000;
/** Largest binary message on a direct connection (the relay's, so the secure channel's defaults fit both). */
export const DIRECT_MAX_MESSAGE_BYTES = 262_144;
/** WebSocket ping interval the box announces in the direct `welcome`. */
export const DIRECT_HEARTBEAT_MS = 20_000;

/* Admission tickets ------------------------------------------------------------------------------ */

/** `exp - iat` may not exceed this. */
export const TICKET_MAX_LIFETIME_S = 300;
/** Tolerated clock skew when checking `iat`/`nbf`/`exp`. */
export const TICKET_CLOCK_SKEW_S = 30;

/* Session protocol (inner) ----------------------------------------------------------------------- */

/** Frame header: u32 length, u8 type, u32 stream id. */
export const FRAME_HEADER_BYTES = 9;
/** Largest CONTROL payload (UTF-8 JSON `SessionMessage`), 64 KiB. */
export const SESSION_MAX_CONTROL_BYTES = 65_536;
/** Largest DATA payload in one frame, 64 KiB. */
export const SESSION_MAX_DATA_BYTES = 65_536;
/** Largest frame body (type + stream id + payload) the decoder accepts. */
export const SESSION_MAX_FRAME_BODY_BYTES = 5 + Math.max(SESSION_MAX_CONTROL_BYTES, SESSION_MAX_DATA_BYTES);
/** Credit each side grants per stream when it opens (bytes of DATA the peer may send before a CREDIT). */
export const SESSION_INITIAL_STREAM_CREDIT = 262_144;
/** Largest credit a single CREDIT frame or the outstanding window may reach (16 MiB). */
export const SESSION_MAX_STREAM_CREDIT = 16_777_216;
/** Open streams (besides the control stream) per session. */
export const SESSION_MAX_OPEN_STREAMS = 32;
/** In-flight requests (sent, no final `result`/`error`) per session. */
export const SESSION_MAX_INFLIGHT_REQUESTS = 64;
/** Subscriptions per session and topics per subscription. */
export const SESSION_MAX_SUBSCRIPTIONS = 16;
export const SESSION_MAX_TOPICS_PER_SUBSCRIPTION = 64;
/** Burrow principals listed in a principal summary. */
export const SESSION_MAX_PRINCIPALS = 256;
/** Request deadline bounds; `deadlineMs` is relative to when the appliance receives the request. */
export const SESSION_MIN_DEADLINE_MS = 100;
export const SESSION_MAX_DEADLINE_MS = 300_000;
/** The first message on the control stream (`hello`) must arrive within this time of the handshake. */
export const SESSION_HELLO_TIMEOUT_MS = 10_000;
/** Capabilities advertised in `hello`/`welcome`. */
export const SESSION_MAX_CAPABILITIES = 64;
/** Upload chunk size bounds (bytes); a chunk is sent as one or more DATA frames. */
export const UPLOAD_MIN_CHUNK_BYTES = 65_536;
export const UPLOAD_MAX_CHUNK_BYTES = 4_194_304;
/** Largest file accepted by the chunked upload protocol (the application may impose a lower quota). */
export const UPLOAD_MAX_FILE_BYTES = 10_737_418_240;
/** Unenrolled endpoints: requests per minute on the enrollment channel. */
export const ENROLL_MAX_REQUESTS_PER_MINUTE = 20;
/** How long the appliance keeps a session's `enroll.claim.begin` state (CC-07): `enroll.claim` must follow within it. */
export const ENROLL_CLAIM_BEGIN_TTL_S = 120;
/** Largest Yjs message on a collab stream (inner `[u32 len][bytes]` framing, CT-22). */
export const COLLAB_MAX_MESSAGE_BYTES = 16_777_216;
/**
 * Largest console message on a console stream (0.80.1, CT-350; the same `[u32 len][bytes]` framing): one hosts-service
 * WebSocket message (`kind | channel | payload`, payloads ≤ 1 MiB), with room to spare (Whombat's proxy reads ≤ 2 MiB).
 */
export const CONSOLE_MAX_MESSAGE_BYTES = 2_097_152;
/** Largest `result`/`outcome` CONTROL message; above it the appliance answers `too_large` + `use_export_stream`. */
export const SESSION_MAX_RESULT_BYTES = 65_536;
