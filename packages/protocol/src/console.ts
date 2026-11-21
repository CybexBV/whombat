/**
 * Console stream payloads (0.80.1, CT-350): a server's shell or a VM's screen from the hosts service, carried by the
 * session instead of a WebSocket, for a client that reaches its Whombat only through the relay. The client opens
 * `open{stream, spec: {kind: 'console', burrow, sessionId, token}}` with the single-use token `hosts.createConsole`
 * gave it (a `secret` op); the appliance checks it as its console WebSocket proxy does (the person, still an owner of
 * the burrow that sees servers, the same session, within 30 seconds), opens the hosts service's console and answers
 * `opened{meta: {kind: 'console', protocol}}` once that is connected, else `error{stream_refused}` with the reason in
 * `details.code` (`console_refused`, `hosts_unavailable`, …).
 *
 * DATA in both directions carries the console's messages unchanged — each one hosts-service WebSocket message
 * (`kind (1 byte) | channel (u16 BE) | payload`: kind 0 data, kind 1 a JSON control such as `{"type":"activity"}`) —
 * framed as `[u32 length BE][message]`, the collaboration stream's framing (`@whombat/protocol/collab`), at most
 * `CONSOLE_MAX_MESSAGE_BYTES` each; frame boundaries mean nothing. Credit is the back-pressure: each side grants it as
 * it hands messages on, so a slow browser slows the server's console and a busy console slows the browser's typing.
 *
 * Closing: either side's END closes the console (the appliance closes the hosts service's socket and ENDs its half;
 * the hub's `{"type":"closed","reason"}` control arrives in DATA before the appliance's END). RESET aborts it
 * (`cancelled` from a client leaving, `internal` when the service's socket failed). The hosts service's 15-minute idle
 * timer counts only `activity` controls, which the client sends while a person types, as over the WebSocket.
 */
import { CollabMessageDecoder, collabDataPayloads, encodeCollabMessages } from './collab.js';
import { CONSOLE_MAX_MESSAGE_BYTES, SESSION_MAX_DATA_BYTES } from './limits.js';

/** `[u32 len][message]` for each console message, concatenated (`CollabFramingError` for an empty or too large one). */
export function encodeConsoleMessages(messages: readonly Uint8Array[]): Uint8Array {
  return encodeCollabMessages(messages, CONSOLE_MAX_MESSAGE_BYTES);
}

/** Splits an encoded byte stream into DATA payloads of at most `maxData` bytes (default 64 KiB). */
export function consoleDataPayloads(encoded: Uint8Array, maxData = SESSION_MAX_DATA_BYTES): Uint8Array[] {
  return collabDataPayloads(encoded, maxData);
}

/** Reassembles console messages from DATA payloads, each at most `CONSOLE_MAX_MESSAGE_BYTES`. */
export class ConsoleMessageDecoder extends CollabMessageDecoder {
  constructor() {
    super(CONSOLE_MAX_MESSAGE_BYTES);
  }
}
