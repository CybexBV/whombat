/**
 * ESPHome's Device Builder over its WebSocket (`/ws`, docs/decisions/connections-more.md CM-07, CM-13; the builder's
 * `docs/API.md`): the server sends its info first (`esphome_version`, `requires_auth` …); a command is
 * `{"command","message_id","args"}`, answered with `{"message_id","result"}` or `{"message_id","error_code","details"}`;
 * a streaming command sends `{"message_id","event":"output","data"}` events and ends with `{"event":"result","data"}`.
 * Messages for other ids (broadcast events) are skipped.
 *
 * Signing in (`auth/login {username, password}`) happens only when the server info says `requires_auth`; it answers a
 * session token (kept for the echo guard, never reused). `rate_limited` means the Builder paused sign-ins (ten wrong
 * ones in five minutes): never retried. An older dashboard sends no server info: the socket isn't the Builder's.
 */
import type { JsonValue } from '@whombat/core';
import { SOCKET_CONNECT_DEADLINE_MS } from '@whombat/core';
import { OutboundError } from '../../lib/outbound';
import { type SocketChannel, SocketClosed } from './channel';
import {
  eventText,
  msUntil,
  nextBefore,
  type SocketCallOptions,
  type SocketHello,
  SocketProtocolError,
  type SocketReply,
  type SocketSession,
  SocketSignInRefused,
} from './dialect';

/** The server info the Builder sends first, or null when the message isn't one. */
export function esphomeServerInfo(message: Record<string, unknown>): SocketHello | null {
  if (typeof message.requires_auth !== 'boolean') return null;
  if (typeof message.esphome_version !== 'string' && typeof message.server_version !== 'string') return null;
  return {
    version: typeof message.esphome_version === 'string' ? message.esphome_version.slice(0, 40) : null,
    asksSignIn: message.requires_auth,
  };
}

/** ESPHome's error as the agent reads it. */
function esphomeError(message: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { error_code: String(message.error_code).slice(0, 80) };
  if (message.details !== undefined && message.details !== null)
    out.details = typeof message.details === 'string' ? message.details.slice(0, 2000) : message.details;
  return out;
}

/** Reads the server info and gives the session. Throws `SocketProtocolError` (`missing`) when there is none. */
export async function esphomeSession(channel: SocketChannel, deadlineAt: number): Promise<SocketSession> {
  let first: Record<string, unknown>;
  try {
    // It speaks first: a socket that says nothing within the connect deadline isn't the Builder's.
    first = await channel.next(Math.min(SOCKET_CONNECT_DEADLINE_MS, msUntil(deadlineAt)));
  } catch (err) {
    // A socket that opened and said nothing, or closed: not the Builder's.
    if (err instanceof SocketClosed || err instanceof OutboundError)
      throw new SocketProtocolError('It didn’t say what it is.', true);
    throw err;
  }
  const hello = esphomeServerInfo(first);
  if (!hello) throw new SocketProtocolError('It didn’t say what it is.', true);
  let nextId = 1;

  const call = async (
    command: string,
    args: JsonValue | undefined,
    options: SocketCallOptions,
  ): Promise<SocketReply> => {
    const id = String(nextId++);
    channel.send({ command, message_id: id, args: args ?? {} });
    const output: string[] = [];
    for (;;) {
      let message: Record<string, unknown> | null;
      try {
        message = await nextBefore(channel, options);
      } catch (err) {
        // A stream (`devices/logs`) may end with the socket: what it said is the answer.
        if (options.streamUntil !== undefined && output.length && err instanceof SocketClosed)
          return { ok: true, result: null, output, stopped: true };
        throw err;
      }
      if (message === null) return { ok: true, result: null, output, stopped: true };
      if (String(message.message_id) !== id) continue;
      if (message.error_code !== undefined) {
        const error = esphomeError(message);
        return { ok: false, error, code: String(error.error_code), output };
      }
      if ('result' in message) return { ok: true, result: message.result ?? null, output, stopped: false };
      if (message.event === 'result')
        return { ok: true, result: message.data ?? null, output, stopped: false };
      if (typeof message.event === 'string') {
        const text = eventText(message.data);
        if (text) output.push(text);
      }
    }
  };

  return {
    hello,
    async signIn(method, params, deadlineAt) {
      const reply = await call(method, params, { deadlineAt });
      if (!reply.ok) {
        if (reply.code === 'rate_limited') throw new SocketSignInRefused('locked');
        if (reply.code === 'unknown_command')
          throw new SocketProtocolError('It doesn’t know the way Whombat signs in.');
        throw new SocketSignInRefused('refused');
      }
      const token = (reply.result as Record<string, unknown> | null)?.token;
      return typeof token === 'string' && token ? [token] : [];
    },
    call,
  };
}
