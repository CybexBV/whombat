/**
 * The `call` tool of a socket connection (docs/decisions/connections-more.md CM-14…CM-17): one method of the service's
 * API over its socket, like `request` is one HTTP request of a REST one.
 *
 * - Input `{ method, params?, seconds? }`: `params` positional (an array) for JSON-RPC, the args object for ESPHome;
 *   `seconds` (1…25, default 10) only for a streaming method. A method the spec refuses, or the one Whombat signs in
 *   with, is never sent.
 * - Reads (core's `socketReads`: the spec's `reads`) run at once; every other method is a write under the tool's tier,
 *   the entry's sensitive rules (`tools: ['call'], arg: 'method'`) apply, and Look only refuses it. The tool's
 *   definition is core's `socketToolDef`.
 * - The answer is JSON up to 64 KiB (a stream: its events' text, then its result), cut and marked like `request`'s, and
 *   withheld whole when it holds the secret or a session the sign-in gave (CM-12, VT-D22).
 * - One socket per call under the connection's destination policy and pinned certificate, the whole call within
 *   `callDeadlineMs` (30 s).
 */
import {
  type CatalogEntry,
  CONNECTION_OUTPUT_MAX,
  type JsonValue,
  SOCKET_STREAM_SECONDS_DEFAULT,
  SOCKET_STREAM_SECONDS_MAX,
  socketReads,
  socketRefused,
  socketRefusedText,
  socketStreams,
} from '@whombat/core';
import { externalEffect } from '../../commit/scope';
import { OutboundError } from '../../lib/outbound';
import type { Services } from '../../services';
import { callDeadlineMs, summarise, VaultCallError, VaultEchoError } from '../../vault/net';
import { holdsSecret, type SecretForms } from '../../vault/scrub';
import { resolveCredential } from '../credentials';
import { connectionPolicy } from '../destination';
import { pinOf } from '../http';
import { type CallOutput, ConnectionArgumentError } from '../request';
import type { CatalogConnectionRow } from '../types';
import { SocketClosed, SocketUpgradeRefused } from './channel';
import { SocketProtocolError, type SocketReply, SocketSignInRefused } from './dialect';
import { runOnSocket } from './run';
import { type SocketLoginValues, type SocketSpec, socketHttpUrl } from './spec';

/** Never sent for an agent (CM-16): the spec's refused methods, and the one Whombat signs in with. */
export function refusedForAgents(entry: CatalogEntry, method: string): boolean {
  const login = entry.socket?.login?.method;
  return socketRefused(entry, method) || (!!login && login.toLowerCase() === method.toLowerCase());
}

/**
 * A `call`'s arguments as the server decides on them (`method` trimmed, `params` an array or object, `seconds` within
 * 1…25). Throws `ConnectionArgumentError`, also for a method that is never sent (`socketRefusedText`).
 */
export function normaliseSocketArgs(
  entry: CatalogEntry,
  args: Readonly<Record<string, unknown>>,
  label: string = entry.name,
): Record<string, unknown> {
  const method = typeof args.method === 'string' ? args.method.trim() : '';
  if (!/^[A-Za-z0-9_.:/-]{1,200}$/.test(method))
    throw new ConnectionArgumentError('method: name one method of the API, like pool.query or devices/list.');
  if (refusedForAgents(entry, method)) throw new ConnectionArgumentError(socketRefusedText(method, label));
  const params = args.params;
  if (params !== undefined && params !== null && typeof params !== 'object')
    throw new ConnectionArgumentError(
      entry.socket?.dialect === 'esphome'
        ? 'params: an object of the command’s arguments.'
        : 'params: a list of the method’s parameters, like ["tank"].',
    );
  const out: Record<string, unknown> = { method };
  if (params !== undefined && params !== null) out.params = params;
  if (args.seconds !== undefined) {
    if (typeof args.seconds !== 'number' || !Number.isInteger(args.seconds))
      throw new ConnectionArgumentError(`seconds: a whole number from 1 to ${SOCKET_STREAM_SECONDS_MAX}.`);
    out.seconds = Math.min(SOCKET_STREAM_SECONDS_MAX, Math.max(1, args.seconds));
  }
  for (const key of Object.keys(args))
    if (!['method', 'params', 'seconds'].includes(key))
      throw new ConnectionArgumentError(`${key}: not an argument of call (method, params, seconds).`);
  return out;
}

/** A socket failure in words for the agent, as the call path reads it (`failureOf`). */
export class SocketCallError extends VaultCallError {}

/** Why a socket call failed, as a `VaultCallError` (a 401 status: the sign-in was refused, so the check decides). */
export function socketCallError(entry: CatalogEntry, spec: SocketSpec, err: unknown): VaultCallError {
  const missing = spec.missing || `${entry.name} has no socket at this address any more.`;
  if (err instanceof VaultCallError) return err;
  if (err instanceof OutboundError) return summarise(err);
  if (err instanceof SocketUpgradeRefused)
    return err.refused
      ? new SocketCallError('rejected', `${entry.name} refused Whombat’s sign-in.`, 401)
      : new SocketCallError('rejected', missing, err.status);
  if (err instanceof SocketSignInRefused)
    return err.reason === 'locked'
      ? new SocketCallError(
          'rejected',
          `${entry.name} paused sign-ins after too many tries. Try again in a few minutes.`,
        )
      : new SocketCallError('rejected', `${entry.name} refused Whombat’s sign-in.`, 401);
  if (err instanceof SocketProtocolError)
    return new SocketCallError(
      'rejected',
      err.missing ? missing : `${entry.name} didn’t answer as expected.`,
    );
  if (err instanceof SocketClosed)
    return err.reason === 'too_large'
      ? new VaultCallError('too_large')
      : new SocketCallError('unreachable', 'The connection closed before it answered.');
  return new VaultCallError('unreachable');
}

/** Lines of a stream's output, each ending in a line break. */
function joined(output: readonly string[]): string {
  return output.map((line) => (line.endsWith('\n') ? line : `${line}\n`)).join('');
}

/** A reply as the agent reads it (CM-14): the result's JSON, or a stream's output and then its result, or the error. */
export function socketAnswerText(reply: SocketReply, seconds?: number): { text: string; isError: boolean } {
  const stream = reply.output.length ? joined(reply.output) : '';
  if (!reply.ok) return { text: `${stream}${JSON.stringify({ error: reply.error })}`, isError: true };
  if (reply.stopped)
    return {
      text: `${stream}[still going after ${seconds ?? SOCKET_STREAM_SECONDS_DEFAULT} s; Whombat stopped reading]`,
      isError: false,
    };
  return { text: `${stream}${JSON.stringify(reply.result ?? null)}`, isError: false };
}

/** Text cut at 64 KiB (marked), as `request`'s answers are. */
export function cutAnswer(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= CONNECTION_OUTPUT_MAX) return { text, truncated: false };
  const cut = Buffer.from(text, 'utf8').subarray(0, CONNECTION_OUTPUT_MAX).toString('utf8').replace(/�$/, '');
  return { text: `${cut}\n[answer cut at ${CONNECTION_OUTPUT_MAX} bytes]`, truncated: true };
}

/** The login's values of a connection: its secret and fields, or null when it signs in with nothing (`none`). */
export function socketLogin(
  credential: { secret?: string | undefined },
  fields: Readonly<Record<string, string>>,
): SocketLoginValues | null {
  return credential.secret ? { secret: credential.secret, fields } : null;
}

/**
 * Sends one (normalised) `call` as the connection. Throws `ConnectionArgumentError` for one that may not be sent,
 * `VaultCallError` (summarised, `SocketCallError` with our words), `VaultEchoError` when the answer holds a secret, or
 * `ConnectionAuthError`.
 */
export async function runSocketCall(
  services: Services,
  row: CatalogConnectionRow,
  entry: CatalogEntry,
  raw: Readonly<Record<string, unknown>>,
): Promise<CallOutput> {
  const spec = entry.socket;
  if (!spec) throw new ConnectionArgumentError('This connection has no socket.');
  const args = normaliseSocketArgs(entry, raw, row.label);
  const method = String(args.method);
  const stream = socketStreams(entry, method);
  const seconds = stream
    ? ((args.seconds as number | undefined) ?? SOCKET_STREAM_SECONDS_DEFAULT)
    : undefined;
  const { credential, forms } = await resolveCredential(services, row);
  const deadlineMs = callDeadlineMs(services);
  const outcome = await externalEffect(
    'connections.socket',
    async () => {
      const policy = await connectionPolicy(services, socketHttpUrl(row.baseUrl, spec), {
        ...pinOf(row),
        deadlineMs,
      });
      try {
        return await runOnSocket(
          {
            spec,
            baseUrl: row.baseUrl,
            login: socketLogin(credential, row.fields),
            policy,
            deadlineMs,
          },
          { method, params: args.params as JsonValue | undefined, streamSeconds: seconds },
        );
      } catch (err) {
        throw socketCallError(entry, spec, err);
      }
    },
    // A read changes nothing; anything else may not be repeated blindly.
    { idempotent: socketReads(entry, method) },
  );
  const { text, isError } = socketAnswerText(outcome.reply, seconds);
  const secrets: SecretForms[] = [...forms, ...outcome.learned.map((secret) => ({ secret }))];
  if (holdsSecret(text, secrets)) throw new VaultEchoError(null);
  const cut = cutAnswer(text);
  return { content: cut.text, isError, truncated: cut.truncated, bytes: Buffer.byteLength(text) };
}
