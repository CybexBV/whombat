/**
 * The session protocol wire (MA-08, CT-05) as the client uses it: frames and message schemas come from
 * `@whombat/protocol` (single source); this file only adds the connection port the session runs on
 * (`WireConnection`, `SessionConnector`) and the connection-attempt error. Nothing here defines protocol.
 */
import { encodeFrame as encodeProtocolFrame, type Frame, FrameDecoder } from '@whombat/protocol/frame';
import { SESSION_PROTOCOL } from '@whombat/protocol/session';
import type { DisconnectReason } from './types';

export {
  CONTROL_STREAM_ID,
  FRAME_TYPE,
  type Frame,
  FrameDecoder,
  FrameError,
  STREAM_RESET,
  type StreamResetName,
} from '@whombat/protocol/frame';
export {
  type ApplianceMessage,
  CAPABILITIES as PROTOCOL_CAPABILITIES,
  type ClientMessage,
  decodeApplianceMessage,
  decodeClientMessage,
  encodeSessionMessage,
  negotiateVersion,
  requestDigest,
  SESSION_PROTOCOL,
} from '@whombat/protocol/session';

/**
 * The protocol major this client speaks: one (HE-52, CT-1260). A box that speaks another refuses with
 * `unsupported_version`, and the session ends as `client_too_old` or `appliance_too_old`.
 */
export const CLIENT_PROTOCOL = { majors: [SESSION_PROTOCOL.major] as readonly number[] };

/**
 * One secure connection as the session sees it: protocol frames in and out, authenticated and encrypted
 * below. A connector (`createManagedConnector`, the fake appliance) produces these.
 */
export interface WireConnection {
  send(frame: Frame): void;
  onFrame(listener: (frame: Frame) => void): void;
  /** Called once, when the connection ends for any reason. */
  onClose(
    listener: (info: { reason: DisconnectReason; detail?: string; retryAfterMs?: number }) => void,
  ): void;
  close(reason?: DisconnectReason): void;
  /** Bytes sent so far. */
  bytesSent(): number;
  /** True while the outbound buffer is above its high-water mark (bulk senders wait for `drained`). */
  congested(): boolean;
  drained(): Promise<void>;
}

export interface ConnectRequest {
  /** Separate connections so bulk transfers never block interactive traffic (MA-05). */
  class: 'interactive' | 'bulk';
  signal: AbortSignal;
}

export interface SessionConnector {
  connect(request: ConnectRequest): Promise<WireConnection>;
}

/** A connection attempt failed; `reason` decides whether and when the session retries. */
export class ConnectError extends Error {
  override name = 'ConnectError';
  constructor(
    readonly reason: DisconnectReason,
    readonly detail?: string,
    readonly retryAfterMs?: number,
  ) {
    super(detail ?? reason);
  }
}

/** Encodes one frame with its length prefix (`[u32 len][u8 type][u32 stream][payload]`). */
export function encodeFrame(frame: Frame): Uint8Array {
  return encodeProtocolFrame(frame);
}

/** Frames from a byte stream (any chunking). Throws `FrameError` on a framing violation. */
export function frameReader(): (chunk: Uint8Array) => Frame[] {
  const decoder = new FrameDecoder();
  return (chunk) => decoder.push(chunk);
}
