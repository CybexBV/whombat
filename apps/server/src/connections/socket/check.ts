/**
 * A socket connection's check (docs/decisions/connections-more.md CM-13, CM-17): open the socket, sign in as the spec
 * says, send the check's method (TrueNAS `system.info`, ESPHome `config/version`) and read the version it answers for
 * the check line (“TrueNAS 25.10.1”, “ESPHome 2026.6.5”). No socket there is the entry's “too old” sentence (CM-05,
 * CM-07); a refused sign-in is a refused credential, as a 401 is for a REST check.
 */
import { type CatalogEntry, type JsonValue, jsonPathValue } from '@whombat/core';
import { externalEffect } from '../../commit/scope';
import { OutboundError } from '../../lib/outbound';
import type { Services } from '../../services';
import { connectionPolicy } from '../destination';
import { SocketClosed, SocketUpgradeRefused } from './channel';
import { SocketProtocolError, type SocketReply, SocketSignInRefused } from './dialect';
import { runOnSocket } from './run';
import { type SocketLoginValues, socketHttpUrl } from './spec';

/** CM-13's `CatalogCheck` `socket`. */
export type SocketCheckSpec = Extract<NonNullable<CatalogEntry['check']>, { kind: 'socket' }>;

/** The entry's socket check, or null. */
export function socketCheckOf(entry: CatalogEntry): SocketCheckSpec | null {
  return entry.check?.kind === 'socket' ? entry.check : null;
}

export type SocketCheckResult =
  | { kind: 'ok'; version: string | null; json: unknown }
  | { kind: 'failed'; refused: boolean; status: number | null; message: string }
  /** The address, the network or the certificate: the caller words it (and offers a fingerprint, CX-D33). */
  | { kind: 'outbound'; error: OutboundError };

/** “25.10.1” of “TrueNAS-25.10.1”, or the text as it is when it has no version number. */
export function versionText(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const digits = /\d+(?:\.\d+)+(?:-?[A-Za-z]+\d*)?/.exec(value)?.[0];
  return (digits ?? value.trim()).slice(0, 40);
}

/** Where the check's version is: the check's `version` path, a string result, `result.version`, the greeting's. */
export function checkVersion(check: SocketCheckSpec, result: unknown, hello: string | null): string | null {
  if (check.version) {
    const at = versionText(jsonPathValue(result, check.version));
    if (at) return at;
  }
  if (typeof result === 'string') return versionText(result);
  const own =
    result && typeof result === 'object' && !Array.isArray(result)
      ? versionText((result as Record<string, unknown>).version)
      : null;
  return own ?? versionText(hello);
}

/** A check method's error that says the sign-in isn't good (ESPHome's `not_authenticated`, TrueNAS's `EACCES`). */
function refusedReply(reply: Extract<SocketReply, { ok: false }>): boolean {
  if (reply.code === 'not_authenticated') return true;
  const data = reply.error.data as Record<string, unknown> | undefined;
  return data?.errname === 'EACCES' || data?.errname === 'ENOTAUTHENTICATED';
}

/** Runs the entry's socket check with these login values (null: a connection that signs in with nothing). */
export async function socketCheck(
  services: Services,
  input: {
    entry: CatalogEntry;
    baseUrl: string;
    pinnedCertSha256?: string;
    login: SocketLoginValues | null;
  },
): Promise<SocketCheckResult> {
  const { entry } = input;
  const spec = entry.socket;
  const check = socketCheckOf(entry);
  if (!spec || !check)
    return { kind: 'failed', refused: false, status: null, message: 'This connection has no socket check.' };
  const refusedText = `${entry.name} refused the sign-in. Check it and try again.`;
  try {
    const outcome = await externalEffect(
      'connections.check',
      async () => {
        const policy = await connectionPolicy(services, socketHttpUrl(input.baseUrl, spec), {
          ...(input.pinnedCertSha256 ? { pinnedCertSha256: input.pinnedCertSha256 } : {}),
          deadlineMs: 15_000,
        });
        return runOnSocket(
          { spec, baseUrl: input.baseUrl, login: input.login, policy, deadlineMs: 15_000 },
          { method: check.method, params: check.params as JsonValue | undefined },
        );
      },
      { idempotent: true },
    );
    const reply = outcome.reply;
    if (!reply.ok)
      return refusedReply(reply)
        ? { kind: 'failed', refused: true, status: null, message: refusedText }
        : {
            kind: 'failed',
            refused: false,
            status: null,
            message: `${entry.name} answered the check with an error.`,
          };
    return {
      kind: 'ok',
      version: checkVersion(check, reply.result, outcome.hello.version),
      json: reply.result,
    };
  } catch (err) {
    if (err instanceof OutboundError) return { kind: 'outbound', error: err };
    if (err instanceof SocketUpgradeRefused)
      return err.refused
        ? { kind: 'failed', refused: true, status: err.status, message: refusedText }
        : {
            kind: 'failed',
            refused: false,
            status: err.status,
            message:
              spec.missing ?? `There is no ${entry.name} socket at that address (it answered ${err.status}).`,
          };
    if (err instanceof SocketSignInRefused) {
      if (err.reason === 'locked')
        return {
          kind: 'failed',
          refused: false,
          status: null,
          message: `${entry.name} paused sign-ins after too many tries. Wait a few minutes, then try again.`,
        };
      return {
        kind: 'failed',
        refused: true,
        status: null,
        message:
          err.reason === 'needed'
            ? `${entry.name} asks for a username and password. Connect it with them.`
            : refusedText,
      };
    }
    if (err instanceof SocketProtocolError)
      return {
        kind: 'failed',
        refused: false,
        status: null,
        message:
          err.missing && spec.missing
            ? spec.missing
            : `That address answered, but not as ${entry.name} does.`,
      };
    if (err instanceof SocketClosed)
      return {
        kind: 'failed',
        refused: false,
        status: null,
        message: 'The connection closed before it answered.',
      };
    throw err;
  }
}
