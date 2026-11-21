/**
 * What the two socket dialects share (docs/decisions/connections-more.md CM-13…CM-15): a session on an open socket that
 * reads the server's greeting, signs in, and sends one method at a time, matched to its answer by id. Each dialect is
 * its own file (`jsonrpc.ts` for TrueNAS, `esphome.ts` for ESPHome's Device Builder).
 */
import type { JsonValue } from '@whombat/core';
import { OutboundError } from '../../lib/outbound';
import type { SocketChannel } from './channel';

/** What the server said when the socket opened. */
export interface SocketHello {
  /** Its version (ESPHome's `esphome_version`), or null when it says none. */
  version: string | null;
  /** It asks for a sign-in before anything else (ESPHome's `requires_auth`). */
  asksSignIn: boolean;
}

/** One method's answer: its result (and a stream's output), or the service's error. */
export type SocketReply =
  | {
      ok: true;
      result: unknown;
      /** A stream's events as text, in order (ESPHome's `output` lines). */
      output: string[];
      /** A stream that was still going when its time was up (or its socket closed). */
      stopped: boolean;
    }
  | {
      ok: false;
      /** The service's error as the agent sees it (JSON-RPC's `error` without its trace; ESPHome's code and details). */
      error: Record<string, unknown>;
      /** Its code (`-32601`, `not_found`, `not_authenticated`). */
      code: string | null;
      output: string[];
    };

export interface SocketCallOptions {
  /** When the whole call ends (epoch ms). */
  deadlineAt: number;
  /** A streaming method: when to stop reading its events (epoch ms). */
  streamUntil?: number;
}

export interface SocketSession {
  readonly hello: SocketHello;
  /**
   * Signs in with `method` and its (filled) params. Throws `SocketSignInRefused` when the service refuses, or
   * `SocketProtocolError` when it doesn't answer as the dialect expects. Answers what it learned that is secret (a
   * session token), for the echo guard.
   */
  signIn(method: string, params: JsonValue, deadlineAt: number): Promise<string[]>;
  call(method: string, params: JsonValue | undefined, options: SocketCallOptions): Promise<SocketReply>;
}

/** The service refused the sign-in: the credential (`refused`), or it paused sign-ins after too many (`locked`). */
export class SocketSignInRefused extends Error {
  constructor(readonly reason: 'refused' | 'locked' | 'needed') {
    super(
      reason === 'locked'
        ? 'It paused sign-ins after too many tries.'
        : reason === 'needed'
          ? 'It asks for a sign-in this connection doesn’t have.'
          : 'It refused the sign-in.',
    );
    this.name = 'SocketSignInRefused';
  }
}

/**
 * The service didn't answer as the dialect expects. `missing`: there is no such socket there (ESPHome's older dashboard
 * sends no server info), so the entry's “too old” sentence applies.
 */
export class SocketProtocolError extends Error {
  constructor(
    message: string,
    readonly missing = false,
  ) {
    super(message);
    this.name = 'SocketProtocolError';
  }
}

/** Milliseconds left until `at` (never below 0). */
export function msUntil(at: number): number {
  return Math.max(0, at - Date.now());
}

/** The next message, or null when a stream's own bound ran out first (the call's deadline still throws). */
export async function nextBefore(
  channel: SocketChannel,
  options: SocketCallOptions,
): Promise<Record<string, unknown> | null> {
  const until = options.streamUntil !== undefined ? Math.min(options.streamUntil, options.deadlineAt) : null;
  const ms = msUntil(until ?? options.deadlineAt);
  if (ms <= 0) {
    if (until !== null && until < options.deadlineAt) return null;
    throw new OutboundError('timeout', 'No time left.');
  }
  try {
    return await channel.next(ms);
  } catch (err) {
    if (
      err instanceof OutboundError &&
      err.reason === 'timeout' &&
      until !== null &&
      Date.now() < options.deadlineAt
    )
      return null;
    throw err;
  }
}

/** A stream event's data as one line of text. */
export function eventText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data === undefined || data === null) return '';
  try {
    return JSON.stringify(data);
  } catch {
    return '';
  }
}
