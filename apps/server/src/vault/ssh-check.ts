/**
 * A server's Check and the host key “Trust this server” reads again (docs/decisions/vault.md VT-S05, VT-S06; VT-D47).
 * The person's, run by the REST handler outside the burrow lock and recorded through `vault.record_ssh_check` (no signed
 * event, like Check connection, VT-D08).
 *
 * - The destination rule first (the reason in full, `not_allowed`).
 * - No trusted key: first contact (vault-self-serve.md VS-10, `firstContact`): the key it shows is the one to trust when
 *   no server of the person's at that host and port pins another — the route trusts it, then checks as below; else
 *   `host_key_changed` with it (nothing is signed in to). `host_key_unconfirmed` is only a probe's answer now.
 * - Trusted and shown: sign in with the entry's key and run nothing → `reached` “Signed in as deploy”.
 * - Another key than the trusted one → `host_key_changed` with it (not signed in).
 * - Otherwise `rejected` (“The server refused the key.”), `timeout`, `unreachable` or `bad_answer`, never the server's
 *   own words.
 */
import {
  type VaultCheckOutcome,
  type VaultSshCheckResult,
  type VaultSshHostKey,
  vaultSshCheckStatus,
  vaultSshCheckSummary,
} from '@whombat/core';
import { iso } from '../lib/time';
import type { Services } from '../services';
import { openSsh, SshFailure, sshDestination } from './ssh';
import { type VaultEntryRow, type VaultSshServerRow, vaultPins, vaultSecretAad } from './store';

function result(
  services: Services,
  server: VaultSshServerRow,
  outcome: VaultCheckOutcome,
  hostKey: VaultSshHostKey | null,
  reason?: string,
): VaultSshCheckResult {
  return {
    serverId: server.id,
    outcome,
    status: vaultSshCheckStatus(outcome),
    summary: vaultSshCheckSummary(outcome, {
      username: server.username,
      ...(reason ? { reason } : {}),
    }).slice(0, 300),
    hostKey,
    checkedAt: iso(services.clock()),
  };
}

/** The pinned host key of a server, or null. */
export function pinOf(server: VaultSshServerRow): VaultSshHostKey | null {
  return server.hostKeyAlgorithm && server.hostKeyFingerprint
    ? { algorithm: server.hostKeyAlgorithm, fingerprint: server.hostKeyFingerprint }
    : null;
}

/** Where a server is, as a connection dials it. */
export function targetOf(entry: Pick<VaultEntryRow, 'id'>, server: VaultSshServerRow) {
  return {
    entryId: entry.id,
    serverId: server.id,
    host: server.host,
    port: server.port,
    username: server.username,
  };
}

function outcomeOf(failure: SshFailure): VaultCheckOutcome {
  switch (failure.reason) {
    case 'host_key_unconfirmed':
    case 'host_key_changed':
    case 'rejected':
    case 'timeout':
    case 'unreachable':
    case 'not_allowed':
    case 'bad_answer':
      return failure.reason;
    default:
      return 'unreachable';
  }
}

/** Check (VT-S05): what the server shows now, signing in only when its host key is the trusted one. */
export async function runSshCheck(
  services: Services,
  entry: VaultEntryRow,
  server: VaultSshServerRow,
): Promise<VaultSshCheckResult> {
  const { problem } = await sshDestination(services, server.host, server.port, 'save');
  if (problem) return result(services, server, 'not_allowed', null, problem.message);
  const pinned = pinOf(server);
  const privateKey =
    pinned && entry.sealed ? services.custody.open(vaultSecretAad(entry.id), entry.sealed) : null;
  try {
    const opened = await openSsh(services, { ...targetOf(entry, server), pinned }, { privateKey });
    opened.client.end();
    return result(services, server, 'reached', opened.hostKey);
  } catch (err) {
    if (!(err instanceof SshFailure)) return result(services, server, 'unreachable', null);
    const outcome = outcomeOf(err);
    return result(
      services,
      server,
      outcome,
      err.hostKey,
      outcome === 'not_allowed' ? err.message : undefined,
    );
  }
}

/**
 * The host key a server shows now (for “Trust this server”), or the check that says why it couldn't be read. Never
 * signs in.
 */
export async function readHostKey(
  services: Services,
  entry: VaultEntryRow,
  server: VaultSshServerRow,
): Promise<{ hostKey: VaultSshHostKey } | { failed: VaultSshCheckResult }> {
  const { problem } = await sshDestination(services, server.host, server.port, 'save');
  if (problem) return { failed: result(services, server, 'not_allowed', null, problem.message) };
  try {
    const opened = await openSsh(
      services,
      { ...targetOf(entry, server), pinned: null },
      { privateKey: null },
    );
    opened.client.end();
    return { hostKey: opened.hostKey };
  } catch (err) {
    if (err instanceof SshFailure && err.hostKey) return { hostKey: err.hostKey };
    const outcome = err instanceof SshFailure ? outcomeOf(err) : 'unreachable';
    return { failed: result(services, server, outcome, null) };
  }
}

/**
 * The key a server shows, read without signing in (a probe: nothing is sent). Throws `SshFailure` when it can't be read
 * (the destination refused, unreachable, not an SSH server).
 */
export async function probeHostKey(
  services: Services,
  entry: Pick<VaultEntryRow, 'id'>,
  server: VaultSshServerRow,
): Promise<VaultSshHostKey> {
  try {
    const opened = await openSsh(
      services,
      { ...targetOf(entry, server), pinned: null },
      { privateKey: null },
    );
    opened.client.end();
    return opened.hostKey;
  } catch (err) {
    if (err instanceof SshFailure && err.hostKey && err.reason === 'host_key_unconfirmed') return err.hostKey;
    throw err;
  }
}

/**
 * First contact with a server that has no pin (vault-self-serve.md VS-10, OpenSSH's `accept-new` as server-signin.md
 * SI-04): the key it shows is the one to trust (`trust`) unless a server of the person's at that host and port — on any of
 * their SSH keys — pins another: then `changed` with the key it showed, and nothing is trusted or sent. Throws
 * `SshFailure` when the key can't be read.
 */
export async function firstContact(
  services: Services,
  entry: Pick<VaultEntryRow, 'id' | 'burrowId' | 'ownerId'>,
  server: VaultSshServerRow,
): Promise<{ trust: VaultSshHostKey } | { changed: VaultSshHostKey }> {
  const [shown, pins] = await Promise.all([
    probeHostKey(services, entry, server),
    vaultPins(services.db, entry.burrowId, entry.ownerId, server.host, server.port),
  ]);
  if (pins.length && !pins.some((p) => p.fingerprint === shown.fingerprint)) return { changed: shown };
  return { trust: shown };
}

/**
 * The person's Check of a server without a pin (VS-10): the key to trust, or the check that says why not — a key another
 * of their servers at that address doesn't pin (`host_key_changed`), or one that couldn't be read.
 */
export async function checkFirstContact(
  services: Services,
  entry: VaultEntryRow,
  server: VaultSshServerRow,
): Promise<{ trust: VaultSshHostKey } | { failed: VaultSshCheckResult }> {
  const { problem } = await sshDestination(services, server.host, server.port, 'save');
  if (problem) return { failed: result(services, server, 'not_allowed', null, problem.message) };
  try {
    const met = await firstContact(services, entry, server);
    if ('changed' in met) return { failed: result(services, server, 'host_key_changed', met.changed) };
    return met;
  } catch (err) {
    if (!(err instanceof SshFailure)) return { failed: result(services, server, 'unreachable', null) };
    const outcome = outcomeOf(err);
    return {
      failed: result(services, server, outcome, null, outcome === 'not_allowed' ? err.message : undefined),
    };
  }
}

/** The check a trust found: the key changed again between the card and the press (VT-S05). */
export function mismatchResult(
  services: Services,
  server: VaultSshServerRow,
  hostKey: VaultSshHostKey,
): VaultSshCheckResult {
  return result(services, server, pinOf(server) ? 'host_key_changed' : 'host_key_unconfirmed', hostKey);
}
