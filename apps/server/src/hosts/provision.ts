/**
 * The built-in Servers connection (contracts CT-342; one-whombat-servers.md ONE-DH14, ONE-DH15): provisioned by the
 * server in the burrow that sees the servers (ONE-DH02) once the hosts service is configured, never added by a person.
 * A shared connection (`whombat_servers`, handle `servers`, transport `builtin`) whose tools are `SERVERS_TOOLS` with
 * the catalog's default tiers (reads Allowed, changes Ask); the person changes the tiers like any connection's. Without the
 * service it stays, marked `error` (agents are told it isn't connected), so its tiers survive a restart of the box
 * without the service. Unsigned, like a migration: it is the server's own, nobody's action.
 *
 * Its sign-in is `none` (nobody signs in to it), like a device's connection: a builtin entry offers no sign-in, and
 * `ConnectionView.signIn` takes only the contract's kinds. Rows the first version made say `builtin`, which clients drop
 * from the Connections list (“1 item needs a newer version of the app.”); `ensureServersConnection` sets them right.
 */
import { newId, type SignInKind } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { lockBurrow } from '../audit/events';
import { syncTools } from '../connections/sync';
import { catalogConnections } from '../db/schema/index';
import type { Services } from '../services';
import { hostsFor } from './service';

export const SERVERS_CATALOG_ID = 'whombat_servers';
export const SERVERS_LABEL = 'Servers';
/** The Servers connection's sign-in: nobody signs in to it. */
export const SERVERS_SIGN_IN: SignInKind = 'none';

/** Makes (or brings back) the Servers connection; returns its id, or null when no burrow sees servers. */
export async function ensureServersConnection(services: Services): Promise<string | null> {
  const hosts = hostsFor(services);
  const burrowId = await hosts.homeBurrowId();
  if (!burrowId) return null;
  const [existing] = await services.db
    .select()
    .from(catalogConnections)
    .where(
      and(eq(catalogConnections.burrowId, burrowId), eq(catalogConnections.catalogId, SERVERS_CATALOG_ID)),
    );
  const status = hosts.present ? ('active' as const) : ('error' as const);
  if (existing) {
    if (existing.status !== status || existing.signIn !== SERVERS_SIGN_IN)
      await services.pipeline.transactAccount((tx) =>
        tx
          .update(catalogConnections)
          .set({ status, signIn: SERVERS_SIGN_IN, updatedAt: services.clock() })
          .where(eq(catalogConnections.id, existing.id)),
      );
    if (status === 'active' && existing.toolsSyncedAt === null)
      await syncTools(services, existing.id).catch(() => {});
    return existing.id;
  }
  if (!hosts.present) return null;
  const id = newId('connection');
  const now = services.clock();
  const inserted = await services.pipeline.transactAccount(async (tx) => {
    // The background start and an explicit readiness check may both see no row.
    // Account-level writes are unsigned and do not take this lock automatically.
    // Share the normal burrow write lock so provisioning and handle allocation
    // also serialize with a person adding a different shared connection.
    await lockBurrow(tx, burrowId);
    const [again] = await tx
      .select({ id: catalogConnections.id })
      .from(catalogConnections)
      .where(
        and(eq(catalogConnections.burrowId, burrowId), eq(catalogConnections.catalogId, SERVERS_CATALOG_ID)),
      );
    if (again) return again.id;
    const taken = new Set(
      (
        await tx
          .select({ handle: catalogConnections.handle })
          .from(catalogConnections)
          .where(eq(catalogConnections.burrowId, burrowId))
      ).map((r) => r.handle),
    );
    let handle = 'servers';
    for (let n = 2; taken.has(handle); n++) handle = `servers-${n}`;
    await tx.insert(catalogConnections).values({
      id,
      catalogId: SERVERS_CATALOG_ID,
      burrowId,
      connectedById: null,
      label: SERVERS_LABEL,
      handle,
      transport: 'builtin',
      signIn: SERVERS_SIGN_IN,
      baseUrl: 'whombat-hosts:',
      fields: {},
      status: 'active',
      access: 'manage',
      createdAt: now,
      updatedAt: now,
    });
    return id;
  });
  await syncTools(services, inserted).catch((err: unknown) =>
    services.log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'hosts: Servers tools not synced',
    ),
  );
  return inserted;
}

/**
 * Keeps the connection in step with the service (every minute until there is a burrow, then every ten): a fresh box
 * has no burrow at start, so the person's burrow gets it shortly after it is made.
 */
export function startServersConnection(services: Services): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const tick = async () => {
    let id: string | null = null;
    try {
      id = await ensureServersConnection(services);
    } catch (err) {
      services.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'hosts: Servers connection not ready',
      );
    }
    if (stopped) return;
    timer = setTimeout(() => void tick(), id ? 10 * 60_000 : 60_000);
    timer.unref?.();
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
