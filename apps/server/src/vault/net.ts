/**
 * Where a Vault entry may connect, and every outbound call it makes (docs/decisions/vault.md VT-10…VT-13, VT-43).
 *
 * - Calls are made by the server only, through `lib/outbound.ts` with the entry's destination rule as the per-call
 *   `destination`: the host is resolved once, every address is checked with core's `vaultDestinationProblem` against
 *   the home network list as it is *now* (or the whole local network, when it is open: local-network.md LN-01), and the socket dials one of exactly those addresses (DNS pinned, so a
 *   rebinding answer between the check and the connect can't slip through). No redirect is followed, the whole call
 *   has a 30 s deadline, and request and answer bodies are capped.
 * - The same rule runs when an entry is saved or its address changes (`at: 'save'`, the reason in full) and on every
 *   call (`at: 'call'`: “This Vault entry’s address isn’t allowed any more.”).
 *
 * Tests reach in-process fakes on 127.0.0.1 only through `useVaultNetForTests` (refused outside `NODE_ENV=test`): a
 * resolver and a dial map, so the fakes stand behind home-network addresses the real checks accept. No production
 * check is relaxed for them.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  type VaultFailure as CoreVaultFailure,
  parseVaultUrl,
  VAULT_CALL_DEADLINE_MS,
  VAULT_FAILURE_TEXT,
  type VaultDestinationProblem,
  vaultDestinationProblem,
  vaultStatusText,
} from '@whombat/core';
import {
  OutboundError,
  type OutboundInit,
  type OutboundPolicy,
  type OutboundResponse,
  outboundRequest,
} from '../lib/outbound';
import type { Services } from '../services';
import { VAULT_REQUEST_BODY_MAX } from './limits';
import { destinationReach } from './store';

/** DNS for Vault destinations, and (tests only) where a checked address is really dialled. */
export interface VaultNet {
  resolve(hostname: string): Promise<{ address: string; family: number }[]>;
  dialAddress?: (address: string) => string;
  /** Tests only: a shorter deadline than `VAULT_CALL_DEADLINE_MS` (the refusal still reads “30 seconds”). */
  deadlineMs?: number;
  /**
   * Tests only: TCP_NODELAY on dialled SSH sockets, so a loopback fake answers each SSH round trip at once instead of
   * after Nagle's and delayed-ACK waits (~40 ms each). On by default under `useVaultNetForTests` (test-speed.md TS-S02).
   */
  noDelay?: boolean;
  /** Tests only: a shorter wait than `SSH_CLOSE_GRACE_MS` for a channel that never closes (VT-D56, TS-S03). */
  closeGraceMs?: number;
  /** Tests only: a shorter answer deadline for Modbus devices than `DEVICE_TIMEOUT_MS` (TS-S10). */
  deviceTimeoutMs?: number;
}

const systemNet: VaultNet = {
  resolve: (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
};

const overrides = new WeakMap<Services, VaultNet>();

/** Tests only: fakes on 127.0.0.1 behind virtual addresses. Refused outside `NODE_ENV=test`. */
export function useVaultNetForTests(services: Services, net: VaultNet): void {
  if (services.config.NODE_ENV !== 'test') throw new Error('The Vault’s network seam is for tests only.');
  overrides.set(services, { noDelay: true, ...net });
}

export function vaultNetOf(services: Services): VaultNet {
  return overrides.get(services) ?? systemNet;
}

/** Every call's total deadline (VT-43): 30 s. */
export function callDeadlineMs(services: Services): number {
  return vaultNetOf(services).deadlineMs ?? VAULT_CALL_DEADLINE_MS;
}

/** The addresses a URL's host resolves to now; [] when it doesn't resolve (an IP host: the check uses the literal). */
export async function resolveHost(services: Services, url: string): Promise<string[]> {
  const parsed = parseVaultUrl(url);
  if (!parsed.ok || parsed.url.hostKind !== 'name') return [];
  try {
    const found = await vaultNetOf(services).resolve(parsed.url.host);
    return found.map((a) => a.address);
  } catch {
    return [];
  }
}

/** Why an entry may not connect to `url` now, or null (VT-11…VT-13). */
export async function destinationProblem(
  services: Services,
  url: string,
  at: 'save' | 'call' = 'save',
): Promise<VaultDestinationProblem | null> {
  const [resolved, reach] = await Promise.all([resolveHost(services, url), destinationReach(services)]);
  return vaultDestinationProblem({ url, resolved, ...reach, at });
}

/** Why a call gave the agent no answer (`VAULT_FAILURES`), with our own words, never the remote side's. */
export type VaultFailure = CoreVaultFailure;

export class VaultCallError extends Error {
  constructor(
    readonly reason: VaultFailure,
    message: string = VAULT_FAILURE_TEXT[reason],
    /** The HTTP status the remote side answered with, when it did. */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'VaultCallError';
  }
}

/** What the agent is told when an answer held the secret: the answer is withheld whole, the key stays. */
export const VAULT_WITHHELD_TEXT = 'The answer contained this entry’s secret, so Whombat held it back.';

/** An answer held a form of the secret: withheld whole (reason `protocol`). */
export class VaultEchoError extends VaultCallError {
  readonly echoed = true;
  constructor(status: number | null = null) {
    super('rejected', VAULT_WITHHELD_TEXT, status);
  }
}

/** A remote HTTP status as a failure: “The server answered 401.” */
export function statusFailure(status: number): VaultCallError {
  return new VaultCallError('rejected', vaultStatusText(status), status);
}

/** An outbound error summarised (VT-42): which kind of failure, never what the other side said. */
export function summarise(err: unknown): VaultCallError {
  if (err instanceof VaultCallError) return err;
  if (err instanceof OutboundError) {
    switch (err.reason) {
      case 'timeout':
        return new VaultCallError('timeout');
      case 'destination':
      case 'private_address':
      case 'host_not_allowed':
      case 'scheme':
        return new VaultCallError('not_allowed');
      case 'too_large':
        return new VaultCallError('too_large');
      default:
        return new VaultCallError('unreachable');
    }
  }
  return new VaultCallError('unreachable');
}

export interface VaultFetchOptions {
  /** Keep this much of the answer and stop reading (marked truncated) instead of failing. */
  truncateAt?: number;
  /** Fail `too_large` beyond this (default 1 MiB). */
  maxBytes?: number;
  /** Cap outgoing request body bytes (default `VAULT_REQUEST_BODY_MAX`). */
  maxRequestBytes?: number;
  /** Default `VAULT_CALL_DEADLINE_MS`; a caller with its own deadline passes what is left of it. */
  deadlineMs?: number;
}

/**
 * The outbound policy of one request for an entry (VT-10…VT-13, VT-43): `entryUrl` decides where it may go (scheme,
 * host, port) against the home network list as it is now, DNS pinned, a total deadline, capped bodies. Catalog
 * connections use the same rule (connections-catalog.md CX-40, `connections/destination.ts`).
 */
export async function vaultDestinationPolicy(
  services: Services,
  entryUrl: string,
  options: VaultFetchOptions = {},
): Promise<OutboundPolicy> {
  const net = vaultNetOf(services);
  const reach = await destinationReach(services);
  const deadlineMs = Math.max(1, options.deadlineMs ?? callDeadlineMs(services));
  return {
    destination: {
      schemes: ['http:', 'https:'],
      check: (_hostname, addresses) => {
        const problem = vaultDestinationProblem({
          url: entryUrl,
          resolved: addresses,
          ...reach,
          at: 'call',
        });
        if (problem) throw new OutboundError('destination', problem.message);
      },
    },
    resolve: net.resolve,
    ...(net.dialAddress ? { dialAddress: net.dialAddress } : {}),
    deadlineMs,
    timeoutMs: deadlineMs,
    maxRequestBytes: options.maxRequestBytes ?? VAULT_REQUEST_BODY_MAX,
    maxBytes: options.maxBytes ?? 1024 * 1024,
    ...(options.truncateAt !== undefined ? { truncateAt: options.truncateAt } : {}),
  };
}

/**
 * One outbound request for an entry: `entryUrl` decides where it may go (scheme, host, port), `requestUrl` is what is
 * sent (the same origin). Throws `VaultCallError` (summarised).
 */
export async function vaultFetch(
  services: Services,
  entryUrl: string,
  requestUrl: string,
  init: OutboundInit,
  options: VaultFetchOptions = {},
): Promise<OutboundResponse> {
  const policy = await vaultDestinationPolicy(services, entryUrl, options);
  try {
    return await outboundRequest(requestUrl, init, policy);
  } catch (err) {
    throw summarise(err);
  }
}
