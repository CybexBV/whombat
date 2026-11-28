/**
 * The servers' changes (docs/decisions/outside-changes.md), every 10 minutes: each server the hosts service reports
 * online is read once (the same detail its page reads) and compared with the read before: a restart, a new kernel, its
 * system's own version, waiting updates that were installed, and its containers' images. Whombat's own containers
 * (`whombat.service`) are left out, as people never see them. Kept in the server's History.
 */
import { type HostGuest, type HostServerDetail, thingId } from '@whombat/core';
import { HOSTS_API, seg } from '../hosts/client';
import { arr, guestsOfDetail, obj, toHostServerDetail } from '../hosts/map';
import { hostsFor, WHOMBAT_ACTOR } from '../hosts/service';
import type { Services } from '../services';
import {
  type ContainerRead,
  type ContainerState,
  containerState,
  diffContainers,
  diffServer,
  nextServerState,
  type ServerRead,
  type ServerState,
} from './diff';
import { pruneChanges, readBaseline, recordRead } from './store';

export const CHANGES_SERVERS_MS = 10 * 60_000;
/** The most servers one pass reads. */
const SERVERS_MAX = 60;

/** What a server's detail says about what can change on it. */
export function serverReadOf(d: HostServerDetail): ServerRead {
  const os = d.server.os;
  const system = d.health?.system ?? null;
  return {
    os: os ? `${os.name} ${os.version}`.trim() || null : null,
    kernel: os?.kernel?.trim() || null,
    bootAt: d.server.lastBoot,
    updates: typeof system?.updates === 'number' ? system.updates : null,
  };
}

/** The Docker containers people see on a server, by name with their image. */
export function containersOf(guests: readonly HostGuest[]): ContainerRead[] {
  return guests
    .filter((g) => g.platform === 'docker' && g.labels?.['whombat.service'] !== '1')
    .map((g) => ({ name: g.name, image: g.image, ...(g.imageId ? { imageId: g.imageId } : {}) }));
}

/** Keeps one server's read and records what changed since the read before. */
export async function trackServer(
  services: Services,
  burrowId: string,
  serverId: string,
  detail: HostServerDetail,
  now: Date,
): Promise<number> {
  const thing = thingId('server', serverId);
  const [server, containers] = await Promise.all([
    readBaseline<ServerState>(services.db, burrowId, thing, 'server'),
    readBaseline<ContainerState>(services.db, burrowId, thing, 'containers'),
  ]);
  const nextServer = nextServerState(server?.state ?? null, serverReadOf(detail));
  let added = await recordRead(services, {
    burrowId,
    thing,
    source: 'server',
    state: nextServer as Record<string, unknown>,
    drafts: diffServer(server?.state ?? null, nextServer),
    since: server?.readAt ?? null,
    now,
  });
  const read = containersOf(guestsOfDetail(detail));
  // A server without Docker keeps no container state.
  if (read.length || containers) {
    const nextContainers = containerState(read);
    added += await recordRead(services, {
      burrowId,
      thing,
      source: 'containers',
      state: nextContainers,
      drafts: diffContainers(containers?.state ?? null, nextContainers),
      since: containers?.readAt ?? null,
      now,
    });
  }
  return added;
}

/** One pass over the online servers; returns how many changes are new. Changes older than 90 days go too. */
export async function changesServerPass(services: Services): Promise<number> {
  const now = services.clock();
  await pruneChanges(services.db, now);
  const hosts = hostsFor(services);
  if (!hosts.present) return 0;
  const burrow = await hosts.homeBurrow();
  if (!burrow) return 0;
  const fleet = await hosts.fleetRaw();
  const ids = arr(fleet.servers)
    .map(obj)
    .filter((c) => typeof c.id === 'string' && c.status !== 'offline' && c.status !== 'pending')
    .map((c) => String(c.id))
    .slice(0, SERVERS_MAX);
  let added = 0;
  for (const serverId of ids) {
    try {
      const raw = await hosts.call<unknown>({
        path: `${HOSTS_API}/servers/${seg(serverId)}`,
        actor: WHOMBAT_ACTOR,
      });
      added += await trackServer(services, burrow.id, serverId, toHostServerDetail(raw, [], null, now), now);
    } catch (err) {
      services.log.debug({ err: String(err), serverId }, 'server changes: read failed');
    }
  }
  return added;
}
