/**
 * What a connection is called on its page and its tile, and the server a Proxmox or Unraid connection is part of
 * (connection-pages.md CP-01, CP-10; connection-pages-server.md CP-S06): kept apart from the page so Home can use them.
 */
import { catalogEntry, connectionHost, thingId } from '@whombat/core';
import type { CatalogConnectionRow } from '../connections/types';
import type { ConnectionGlance } from '../home/types';
import type { Services } from '../services';
import {
  addressIndex,
  addressIndexIfReady,
  connectionAddresses,
  connectionHostname,
  hostsServing,
  matchMachine,
  matchServerName,
} from './runs-on';

/** Kinds that can be part of a server Whombat watches (CP-10), and their API's name. */
export const PART_OF: Record<string, string> = { proxmox: 'Proxmox API', unraid: 'Unraid API' };

/** The connection's name as the sidebar shows it, without “ · <its address>”. */
export function displayName(row: Pick<CatalogConnectionRow, 'label' | 'catalogId' | 'fields'>): string {
  const entry = catalogEntry(row.catalogId);
  const host = entry ? connectionHost(entry, row.fields) : null;
  const bare = host?.replace(/:\d+$/, '');
  for (const h of [host, bare])
    if (h && row.label.endsWith(` · ${h}`) && row.label.length > h.length + 3)
      return row.label.slice(0, -(h.length + 3));
  return row.label;
}

/** A promise's value, or `fallback` past `ms`. */
export async function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The server a Proxmox or Unraid connection reaches, when Whombat watches it (CP-10): its thingId. By the address it
 * talks to, else by the name the service gave itself (Unraid's hostname, the health pass's glance) or the name in its
 * address (`tower.local`), SB-09: a server with a second network card reports one address only.
 */
export async function partOfServer(
  services: Services,
  burrowId: string,
  row: Pick<CatalogConnectionRow, 'catalogId' | 'baseUrl' | 'fields'> & { glance?: unknown },
  options: { wait?: boolean } = {},
): Promise<string | null> {
  if (!PART_OF[row.catalogId]) return null;
  const hosts = await hostsServing(services, burrowId);
  if (!hosts) return null;
  const index =
    options.wait === false ? addressIndexIfReady(hosts) : await addressIndex(hosts).catch(() => null);
  if (!index) return null;
  const addresses = await connectionAddresses(services, row).catch(() => []);
  const servers = { ...index, machines: index.machines.filter((m) => m.guestId === null) };
  const names = [(row.glance as ConnectionGlance | null | undefined)?.hostname, connectionHostname(row)];
  const found =
    (addresses.length ? matchMachine(servers, addresses) : null) ??
    names.reduce<ReturnType<typeof matchServerName>>(
      (hit, n) => hit ?? (n ? matchServerName(servers, n) : null),
      null,
    );
  return found ? thingId('server', found.serverId) : null;
}

/** Shared connections a burrow's Proxmox and Unraid point at, for Home (doesn't wait for the address index). */
export async function partOfMap(
  services: Services,
  burrowId: string,
  rows: readonly (Pick<CatalogConnectionRow, 'id' | 'catalogId' | 'baseUrl' | 'fields'> & {
    glance?: unknown;
  })[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const candidates = rows.filter((r) => PART_OF[r.catalogId]);
  if (!candidates.length) return out;
  await Promise.all(
    candidates.map(async (r) => {
      const server = await within(partOfServer(services, burrowId, r, { wait: false }), 1_500, null);
      if (server) out.set(r.id, server);
    }),
  );
  return out;
}
