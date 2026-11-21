/**
 * Servers in a backup file (docs/decisions/backup-file.md BF-13; BF-S30…BF-S34): only where this Whombat watches
 * servers — the hosts service is here and this is the servers' burrow (ONE-DH02). The file holds the hosts service's
 * own backup (`servers/hub.tar.gz`: its servers, settings, history and certificate authority, as the service gives it)
 * and Whombat's choices per server (“Asks you first”, `server_ask`), with one `servers_hub` record saying which
 * authority, which address and which servers. The backup carries the authority's key: it waits for the file's body in
 * an encrypted spool (BF-D04), streamed, never held whole.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { type BackupCategoryEstimate, hostsAgentAddress } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { serverAsks } from '../../db/schema/index';
import { agentAddresses } from '../../hosts/address';
import { arr, obj, str } from '../../hosts/map';
import { loadServerNames } from '../../hosts/names-store';
import { hostsFor } from '../../hosts/service';
import { iso } from '../../lib/time';
import type { Services } from '../../services';
import { backupError } from '../errors';
import { Spool } from '../spool';
import type { CategoryOut, CollectOut, CollectScope } from './scope';

/** Largest hosts service backup a file takes: what `POST /hub/restore` accepts (1 GiB). */
export const HUB_BACKUP_MAX_BYTES = 1024 * 1024 * 1024;

/** Whether this Whombat can put servers in a file for this burrow (BF-13). */
export async function serversOffered(services: Services, burrowId: string): Promise<boolean> {
  const hosts = hostsFor(services);
  if (!hosts.present) return false;
  return hosts.serves(burrowId).catch(() => false);
}

/**
 * The servers' line in the make panel (BF-D08: cheap): how many servers the hosts service watches and its database's
 * size for the bytes (its backup is the database, compressed); not offered where it watches no servers for this burrow.
 */
export async function estimateServers(services: Services, burrowId: string): Promise<BackupCategoryEstimate> {
  const base = { id: 'servers' as const, othersPrivate: null };
  if (!(await serversOffered(services, burrowId))) return { ...base, count: 0, bytes: 0, offered: false };
  const hub = await hostsFor(services)
    .hub()
    .catch(() => null);
  return { ...base, count: hub?.servers ?? 0, bytes: hub?.databaseBytes ?? 0, offered: true };
}

/** The hosts service's backup into an encrypted spool: its size and sha256 (the answer read to its very end). */
async function spoolHubBackup(
  services: Services,
  scratch: string,
): Promise<{ spool: Spool; size: number; sha256: string }> {
  const spool = await Spool.create(join(scratch, 'hub.tar.gz'));
  const hash = createHash('sha256');
  let size = 0;
  try {
    const res = await hostsFor(services).hubBackup();
    try {
      for await (const piece of res) {
        const chunk = piece as Buffer;
        size += chunk.length;
        if (size > HUB_BACKUP_MAX_BYTES) throw backupError('too_large');
        hash.update(chunk);
        await spool.write(chunk);
      }
      if (!res.complete) throw new Error('the hosts service’s backup was cut off');
    } finally {
      res.destroy();
    }
    if (size === 0) throw new Error('the hosts service gave an empty backup');
    await spool.close();
    return { spool, size, sha256: hash.digest('hex') };
  } catch (err) {
    await spool.remove().catch(() => {});
    throw err;
  }
}

export async function collectServers(scope: CollectScope, out: CategoryOut, all: CollectOut): Promise<void> {
  const services = scope.services;
  if (!(await serversOffered(services, scope.burrow.id))) return;
  const hosts = hostsFor(services);
  const hub = await hosts.hub();
  if (!hub.caSha256 || !hub.agentUrl) throw new Error('the hosts service didn’t say who it is');
  const backup = await spoolHubBackup(services, scope.scratch);
  all.hostsBackup = backup;
  // The servers as the backup holds them (read right after it), with their own addresses for pointing them here.
  hosts.forget('fleet', 'agents');
  const fleet = await hosts.fleetRaw();
  const addresses = agentAddresses(await hosts.agentsRaw().catch(() => [] as unknown[]));
  // The names people gave them come back with them (Whombat's, not the hosts service's).
  const named = await loadServerNames(scope.db, scope.burrow.id);
  const servers = arr(fleet.servers)
    .map(obj)
    .map((c) => {
      const id = str(c.id) ?? '';
      return {
        id,
        name: (str(c.hostname)?.trim() || id).slice(0, 200),
        address: addresses.get(id) ?? null,
        givenName: named.get(id.toLowerCase()) ?? null,
      };
    })
    .filter((s) => s.id);
  await out.record({
    type: 'servers_hub',
    caSha256: hub.caSha256,
    agentUrl: hub.agentUrl,
    address: hostsAgentAddress(hub.agentUrl) ?? hub.agentUrl,
    madeAt: iso(services.clock()),
    servers,
    backup: { size: backup.size, sha256: backup.sha256 },
  });
  out.bytes += backup.size;
  const asks = await scope.db.select().from(serverAsks).where(eq(serverAsks.burrowId, scope.burrow.id));
  for (const row of asks) {
    out.ref(row.changedById);
    await out.record({
      type: 'server_ask',
      server: row.serverId,
      asksFirst: row.asksFirst,
      changedBy: row.changedById,
      changedAt: iso(row.changedAt),
    });
  }
}
