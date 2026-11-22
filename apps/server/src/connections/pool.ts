/**
 * Catalog connections' MCP servers (docs/decisions/connections-catalog.md CX-32): the generalised MCP client pool
 * (`mcp/client-pool.ts`, shared with the Vault) keyed by connection, reconnected when where the connection's calls go
 * or as whom (`callTarget`) or its MCP address changes, so a session opened as one account is never used as another.
 * Each JSON-RPC request reads the connection as it is now and is signed in on its own (`signedConnectionFetch`: the
 * destination rule, the credential last, one retry after a forced refresh on 401), so a refreshed OAuth token needs no
 * reconnect; a connection that goes elsewhere or as someone else by then sends nothing (`ConnectionChangedError`). 30 s
 * per exchange, 64 KiB of output kept, definitions and answers checked against the credential's forms.
 *
 * `evictConnection` is what the connect side calls when a connection is removed or its credential, address or sign-in
 * change (CX-24).
 */
import { CONNECTION_CALL_DEADLINE_MS, CONNECTION_OUTPUT_MAX } from '@whombat/core';
import { McpClientPool, type McpPoolTarget } from '../mcp/client-pool';
import type { Services } from '../services';
import { VAULT_POOL_IDLE_MS } from '../vault/limits';
import { VaultCallError, vaultNetOf } from '../vault/net';
import type { SecretForms } from '../vault/scrub';
import { callTarget, keepTarget } from './call-target';
import { closeDiscovery } from './discover';
import { currentRow, signedConnectionFetch } from './http';
import { type CatalogConnectionRow, ConnectionAuthError } from './types';

/** Calls in flight per connection (like the Vault's per entry, VT-43). */
export const CONNECTION_CALLS_IN_FLIGHT_MAX = 4;
/** A raw JSON-RPC answer is read up to this much. */
const ANSWER_MAX = 1024 * 1024;

/** One server's connection pool and in-flight counts (one per `Services`). */
export class ConnectionService {
  readonly pool: McpClientPool;
  readonly #inflight = new Map<string, number>();
  /** The credential forms seen per connection, shared by its pooled transport and its calls (echo checks). */
  readonly #forms = new Map<string, SecretForms[]>();

  constructor(readonly services: Services) {
    this.pool = new McpClientPool({
      clientName: 'whombat-connections',
      // Tests shorten the Vault's deadline through its network seam; production is 30 s for both.
      deadlineMs: () => vaultNetOf(services).deadlineMs ?? CONNECTION_CALL_DEADLINE_MS,
      idleMs: VAULT_POOL_IDLE_MS,
      outputMax: CONNECTION_OUTPUT_MAX,
    });
  }

  /** Takes one of the connection's in-flight slots; false when all are taken. */
  acquire(connectionId: string): boolean {
    const n = this.#inflight.get(connectionId) ?? 0;
    if (n >= CONNECTION_CALLS_IN_FLIGHT_MAX) return false;
    this.#inflight.set(connectionId, n + 1);
    return true;
  }

  release(connectionId: string): void {
    const n = (this.#inflight.get(connectionId) ?? 1) - 1;
    if (n <= 0) this.#inflight.delete(connectionId);
    else this.#inflight.set(connectionId, n);
  }

  /**
   * The pool target of a connection's MCP server at `mcpUrl`, as `row` is: its session is the one opened where and as
   * whom `row`'s calls go, and each request is signed only while the stored connection still goes there.
   */
  target(row: CatalogConnectionRow, mcpUrl: string): McpPoolTarget {
    const services = this.services;
    const fingerprint = callTarget(row);
    let forms = this.#forms.get(row.id);
    if (!forms) {
      forms = [];
      this.#forms.set(row.id, forms);
    }
    const seen = forms;
    return {
      key: row.id,
      url: mcpUrl,
      version: `${fingerprint}|${mcpUrl}`,
      forms: seen,
      post: async (headers, body) => {
        const now = await currentRow(services, row.id);
        keepTarget(now, fingerprint);
        if (now?.status === 'needs_reauth') throw new VaultCallError('rejected', 'needs_reauth', 401);
        return signedConnectionFetch(
          services,
          now ?? row,
          { method: 'POST', url: mcpUrl, headers, body },
          {
            maxBytes: ANSWER_MAX,
            target: fingerprint,
            onForms: (f) => {
              for (const form of f)
                if (!seen.some((s) => s.secret === form.secret && s.username === form.username))
                  seen.push(form);
              // Keep the last few only: a long-lived connection refreshes its token many times.
              if (seen.length > 4) seen.splice(0, seen.length - 4);
            },
          },
        ).catch((err: unknown) => {
          // A refused or revoked credential (the connection is marked `needs_reauth`) reads as a 401 to the pool.
          if (err instanceof ConnectionAuthError) throw new VaultCallError('rejected', 'needs_reauth', 401);
          throw err;
        });
      },
    };
  }

  /** Drops what the pool holds for a connection. */
  async evict(connectionId: string): Promise<void> {
    this.#forms.delete(connectionId);
    await this.pool.evict(connectionId);
  }

  close(): Promise<void> {
    return this.pool.close();
  }
}

const instances = new WeakMap<Services, ConnectionService>();

export function connectionsFor(services: Services): ConnectionService {
  let service = instances.get(services);
  if (!service) {
    service = new ConnectionService(services);
    instances.set(services, service);
  }
  return service;
}

/**
 * Closes a connection's pooled MCP client and forgets its credential forms (CX-24). The connect side calls it after a
 * connection is removed or its credential, address or sign-in change; a later call reconnects with what is current.
 */
export async function evictConnection(services: Services, connectionId: string): Promise<void> {
  await instances.get(services)?.evict(connectionId);
}

/** Closes every pooled connection client and stops the network scans (the server is stopping). */
export async function closeConnections(services: Services): Promise<void> {
  await Promise.all([instances.get(services)?.close(), closeDiscovery(services)]);
}
