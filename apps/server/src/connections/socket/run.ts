/**
 * One method over a connection's socket (docs/decisions/connections-more.md CM-14, CM-15): open the socket under the
 * policy, read the server's greeting, sign in as the spec says, send the method, read its answer (a stream's events
 * until its time is up), close. One socket per call; the whole call has one deadline.
 *
 * Signing in (CM-13): `always` signs in right away (TrueNAS); `asked` only when the greeting asks (ESPHome's
 * `requires_auth`); a connection without a secret (`none`) never signs in, and a server that asks anyway is refused
 * (`SocketSignInRefused` `needed`).
 *
 * This file knows nothing of the database: the caller gives the policy (`connectionPolicy` for the socket's URL) and the
 * login's values. Failures are thrown as they are (`OutboundError`, `SocketUpgradeRefused`, `SocketClosed`,
 * `SocketProtocolError`, `SocketSignInRefused`); the call and the check put them in words.
 */
import { type JsonValue, SOCKET_CONNECT_DEADLINE_MS } from '@whombat/core';
import type { OutboundPolicy } from '../../lib/outbound';
import { openChannel, type SocketChannel } from './channel';
import { type SocketHello, type SocketReply, type SocketSession, SocketSignInRefused } from './dialect';
import { esphomeSession } from './esphome';
import { jsonRpcSession } from './jsonrpc';
import { fillLoginParams, type SocketLoginValues, type SocketSpec, socketHttpUrl } from './spec';

export interface SocketTarget {
  spec: SocketSpec;
  /** The connection's base URL; the socket is at its `path`. */
  baseUrl: string;
  /** What the login's templates are filled with, or null for a connection that doesn't sign in. */
  login: SocketLoginValues | null;
  /** The destination policy of the socket's URL (`connectionPolicy`), its pin included. */
  policy: OutboundPolicy;
  /** The whole call, from the connect to the last message. */
  deadlineMs: number;
  /** The handshake (default 10 s, never past the deadline). */
  connectMs?: number;
}

export interface SocketMethod {
  method: string;
  params?: JsonValue | undefined;
  /** A streaming method: how long to read its events. */
  streamSeconds?: number | undefined;
}

export interface SocketOutcome {
  hello: SocketHello;
  reply: SocketReply;
  /** What signing in gave that is secret (a session token), for the echo guard. */
  learned: string[];
}

function startSession(spec: SocketSpec, channel: SocketChannel, deadlineAt: number): Promise<SocketSession> {
  return spec.dialect === 'esphome'
    ? esphomeSession(channel, deadlineAt)
    : Promise.resolve(jsonRpcSession(channel));
}

/** Signs in on the session when the spec (and the greeting) say so; answers what it learned. */
async function signIn(target: SocketTarget, session: SocketSession, deadlineAt: number): Promise<string[]> {
  const login = target.spec.login;
  if (!login) return [];
  if (login.when === 'asked' && !session.hello.asksSignIn) return [];
  if (!target.login) {
    // Nothing to sign in with: fine unless the server asks (a Builder that has a password now).
    if (login.when === 'asked') throw new SocketSignInRefused('needed');
    return [];
  }
  const params = fillLoginParams(login.params, target.login);
  if (params === null) throw new SocketSignInRefused('needed');
  return session.signIn(login.method, params, deadlineAt);
}

/** Opens the socket, signs in and sends one method. The socket is closed whatever happens. */
export async function runOnSocket(target: SocketTarget, call: SocketMethod): Promise<SocketOutcome> {
  const started = Date.now();
  const deadlineAt = started + target.deadlineMs;
  const channel = await openChannel(socketHttpUrl(target.baseUrl, target.spec), target.policy, {
    connectMs: Math.min(target.connectMs ?? SOCKET_CONNECT_DEADLINE_MS, target.deadlineMs),
  });
  try {
    const session = await startSession(target.spec, channel, deadlineAt);
    const learned = await signIn(target, session, deadlineAt);
    const seconds = call.streamSeconds;
    const reply = await session.call(call.method, call.params, {
      deadlineAt,
      ...(seconds !== undefined ? { streamUntil: Date.now() + seconds * 1000 } : {}),
    });
    return { hello: session.hello, reply, learned };
  } finally {
    channel.close();
  }
}
