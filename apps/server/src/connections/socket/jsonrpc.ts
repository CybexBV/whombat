/**
 * JSON-RPC 2.0 over a WebSocket, as TrueNAS 25.04 and later speak it at `/api/current` (docs/decisions/connections-more.md
 * CM-05, CM-13): `{"jsonrpc":"2.0","id":n,"method","params"}` answered by `{"jsonrpc":"2.0","id":n,"result"}` or
 * `{…,"error":{"code","message","data"}}`. The server says nothing first, and its notifications (`collection_update`,
 * no id) are skipped. One request at a time (TrueNAS refuses batches).
 *
 * Signing in (`auth.login_with_api_key [key]`) answers `true`, or `false` for a key it doesn't take (revoked, or
 * turned off after it was used over plain http); `auth.login_ex` answers `{response_type: "SUCCESS"}` or another type.
 * Anything else is the protocol's problem, not the key's.
 */
import type { JsonValue } from '@whombat/core';
import type { SocketChannel } from './channel';
import {
  nextBefore,
  type SocketCallOptions,
  SocketProtocolError,
  type SocketReply,
  type SocketSession,
  SocketSignInRefused,
} from './dialect';

/** JSON-RPC's code for a method the server doesn't have. */
const METHOD_NOT_FOUND = -32601;

/** A JSON-RPC error as the agent reads it: code, message and the service's reason, without its Python trace. */
export function jsonRpcError(raw: unknown): Record<string, unknown> {
  const error = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  if (typeof error.code === 'number' || typeof error.code === 'string') out.code = error.code;
  if (typeof error.message === 'string') out.message = error.message.slice(0, 2000);
  const data = error.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    for (const key of ['error', 'errname', 'reason', 'extra'])
      if (d[key] !== undefined && d[key] !== null) kept[key] = d[key];
    if (Object.keys(kept).length) out.data = kept;
  }
  return out;
}

export function jsonRpcSession(channel: SocketChannel): SocketSession {
  let nextId = 1;

  const call = async (
    method: string,
    params: JsonValue | undefined,
    options: SocketCallOptions,
  ): Promise<SocketReply> => {
    const id = nextId++;
    channel.send({ jsonrpc: '2.0', id, method, params: params ?? [] });
    for (;;) {
      const message = await nextBefore(channel, options);
      // A streaming method's time ran out (TrueNAS has none; the spec may still name one).
      if (message === null) return { ok: true, result: null, output: [], stopped: true };
      if (message.id !== id) continue;
      if (message.error !== undefined) {
        const error = jsonRpcError(message.error);
        return {
          ok: false,
          error,
          code: error.code === undefined ? null : String(error.code),
          output: [],
        };
      }
      if (!('result' in message)) throw new SocketProtocolError('It answered in a way Whombat doesn’t know.');
      return { ok: true, result: message.result ?? null, output: [], stopped: false };
    }
  };

  return {
    hello: { version: null, asksSignIn: false },
    async signIn(method, params, deadlineAt) {
      const reply = await call(method, params, { deadlineAt });
      if (!reply.ok) {
        if (reply.code === String(METHOD_NOT_FOUND))
          throw new SocketProtocolError('It doesn’t know the way Whombat signs in.');
        throw new SocketProtocolError('It didn’t let Whombat sign in.');
      }
      const result = reply.result;
      if (result === true) return [];
      if (result === false) throw new SocketSignInRefused('refused');
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        const type = (result as Record<string, unknown>).response_type;
        if (type === 'SUCCESS') return [];
        if (typeof type === 'string') throw new SocketSignInRefused('refused');
      }
      throw new SocketProtocolError('It answered the sign-in in a way Whombat doesn’t know.');
    },
    call,
  };
}
