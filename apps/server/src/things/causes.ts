/**
 * One cause, one message (docs/decisions/monitoring.md MON-07, MON-08). A connection whose machine is down is down
 * because of it: its server offline in the hosts service's fleet, or its machine (a guest) stopped. So is one on a
 * server or machine kept quiet (MON-04, MON-05), and one on an internet address that fails while Whombat's own way out
 * is down. Every minute a job finds each such connection's cause and keeps it in `thing_causes` (operational, like the
 * glance); the quiet reads bring it with a thing's quiet rows, so its lines are quiet with the cause's words (“while
 * pve-02 is down”) everywhere — no dot colour, look, Inbox item or incident of its own — and the cause's Inbox item and
 * look name what it takes with it (“Plex and 4 more are down with it”). Once the cause is gone, its row goes, and what
 * is still failing counts again from the start.
 *
 * What a connection runs on is what its last health pass found (`ConnectionGlance.machine`, kept while it doesn't
 * answer). Servers held by a parent are grouped by the hosts service itself (`suppressed_by`); nothing is added here.
 * The same minute's job also gives back the maintenance windows of quiet windows that are over (`sweepQuietWindows`).
 */
import { BlockList, isIP } from 'node:net';
import { catalogEntry, type HostAlert, type NeedsYouItem, thingId } from '@whombat/core';
import { and, eq, inArray, isNull, lte } from 'drizzle-orm';
import type { CatalogConnectionRow } from '../connections/types';
import type { Db, Tx } from '../db/client';
import { catalogConnections, quietWindows, thingCauses } from '../db/schema/index';
import { homeAudience, publishHomeChanged } from '../home/notify';
import type { ConnectionGlance } from '../home/types';
import { arr, obj, str } from '../hosts/map';
import { HEARTBEAT_RULE } from '../hosts/quiet-lines';
import { serverLabel } from '../hosts/self';
import {
  openWayOut,
  registerWayOutSource,
  setWayOutTakenBy,
  WAY_OUT_CAUSE,
  WAY_OUT_THING,
  type WayOutStep,
} from '../managed/way-out';
import type { Services } from '../services';
import { displayName } from './part-of';
import { sweepQuietWindows } from './quiet/window-work';
import { takenWords, windowHolds } from './quiet/windows';
import { connectionHostname, guestLabel, hostsServing } from './runs-on';

/** How often the causes are found again. */
export const CAUSES_MS = 60_000;

/* What each connection is down because of (pure) ------------------------------------------------------------------ */

/** A connection as the causes read it. */
export interface CauseConnection {
  thingId: string;
  /** Where its last check found it runs. */
  machine?: { serverId: string; guestId: string | null } | undefined;
  /** Whether its last check got an answer. */
  answering: boolean;
  /** Whether it talks to an address on the internet. */
  internet: boolean;
}

/** The world the causes are found in. */
export interface CauseWorld {
  /** Servers by id: their name and whether they are down (offline in the fleet). */
  servers: ReadonlyMap<string, { name: string; down: boolean }>;
  /** Machines by `<server>/<guest>`: their name and whether they are stopped. */
  guests: ReadonlyMap<string, { name: string; stopped: boolean }>;
  /** Servers and machines kept quiet now; `work`: by Whombat for its own work. */
  windows: readonly { serverId: string; guestId: string | null; work: boolean }[];
  /** The step of the way out that is down now. */
  wayOut: WayOutStep | null;
  /**
   * Whether the servers and machines were read. When the fleet or a server's machines couldn't be read, a cause not
   * found again may only be unseen: kept causes stay as they are and age out by themselves.
   */
  complete?: boolean;
}

/** A cause as kept. */
export interface FoundCause {
  causeThing: string;
  causeName: string;
  /** `down`: it doesn't answer because of it; `quiet`: it is quiet with a server or machine kept quiet. */
  kind: 'down' | 'quiet';
  words: string;
}

/** The id a machine goes by as a cause: `server:pve-02/guest/<id>`. */
export function machineThing(serverId: string, guestId: string | null): string {
  const server = thingId('server', serverId);
  return guestId ? `${server}/guest/${encodeURIComponent(guestId)}` : server;
}

/**
 * Each connection's cause, by thing: its server down first, then its machine stopped, then its server or machine kept
 * quiet, then the way out. A connection that still answers is down because of nothing; one on a quiet server is quiet
 * with it whatever it answers.
 */
export function causesFor(
  connections: readonly CauseConnection[],
  world: CauseWorld,
): Map<string, FoundCause> {
  const out = new Map<string, FoundCause>();
  const quiet = (serverId: string, guestId: string | null) =>
    world.windows.find((w) => w.serverId === serverId && (w.guestId === null || w.guestId === guestId));
  for (const c of connections) {
    const m = c.machine;
    const server = m ? world.servers.get(m.serverId) : undefined;
    const guest = m?.guestId ? world.guests.get(`${m.serverId}/${m.guestId}`) : undefined;
    if (m && server?.down && !c.answering) {
      out.set(c.thingId, {
        causeThing: machineThing(m.serverId, null),
        causeName: server.name,
        kind: 'down',
        words: `while ${server.name} is down`,
      });
      continue;
    }
    if (m?.guestId && guest?.stopped && !c.answering) {
      out.set(c.thingId, {
        causeThing: machineThing(m.serverId, m.guestId),
        causeName: guest.name,
        kind: 'down',
        words: `while ${guest.name} is stopped`,
      });
      continue;
    }
    const window = m ? quiet(m.serverId, m.guestId) : undefined;
    if (m && window) {
      const onGuest = window.guestId !== null;
      const name = onGuest ? (guest?.name ?? m.guestId ?? m.serverId) : (server?.name ?? m.serverId);
      out.set(c.thingId, {
        causeThing: machineThing(m.serverId, window.guestId),
        causeName: name,
        kind: 'quiet',
        words: window.work ? `while Whombat is updating ${name}` : `while ${name} is kept quiet`,
      });
      continue;
    }
    if (world.wayOut && c.internet && !c.answering)
      out.set(c.thingId, {
        causeThing: WAY_OUT_THING,
        causeName: WAY_OUT_CAUSE[world.wayOut].name,
        kind: 'down',
        words: WAY_OUT_CAUSE[world.wayOut].words,
      });
  }
  return out;
}

/** Host names that stay inside the house. */
const LOCAL_NAMES = /(^|\.)(local|lan|home|internal|intranet|localdomain|home\.arp|localhost)$/i;

/** Addresses inside the house or a private network: private, shared (a tailnet's), loopback and link-local ranges. */
const LOCAL_ADDRESSES = new BlockList();
for (const [net, bits] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
] as const)
  LOCAL_ADDRESSES.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['fc00::', 7],
  ['fe80::', 10],
  ['::1', 128],
] as const)
  LOCAL_ADDRESSES.addSubnet(net, bits, 'ipv6');

/**
 * Whether a connection talks to an address on the internet (pure): a fixed public service, a public address, or a
 * name that isn't a local one. One that runs on a server Whombat watches is in the house.
 */
export function onInternet(
  row: Pick<CatalogConnectionRow, 'catalogId' | 'baseUrl' | 'fields'>,
  machine: unknown,
): boolean {
  if (machine) return false;
  let host = connectionHostname(row);
  if (!host) {
    const entry = catalogEntry(row.catalogId);
    try {
      host = entry?.baseUrl && !entry.baseUrl.includes('{') ? new URL(entry.baseUrl).hostname : null;
    } catch {
      host = null;
    }
  }
  if (!host) return false;
  const bare = host.replace(/^\[|\]$/g, '');
  const family = isIP(bare);
  if (family) return !LOCAL_ADDRESSES.check(bare, family === 4 ? 'ipv4' : 'ipv6');
  return bare.includes('.') && !LOCAL_NAMES.test(bare);
}

/* The job --------------------------------------------------------------------------------------------------------- */

/** The world one burrow's connections are found in: its fleet and the machines they run on, read once. */
async function worldOf(
  services: Services,
  burrowId: string,
  machines: readonly { serverId: string; guestId: string | null }[],
  windows: readonly { serverId: string; guestId: string | null; work: boolean }[],
  wayOut: WayOutStep | null,
): Promise<CauseWorld> {
  const servers = new Map<string, { name: string; down: boolean }>();
  const guests = new Map<string, { name: string; stopped: boolean }>();
  let complete = true;
  const hosts = await hostsServing(services, burrowId);
  if (hosts) {
    const fleet = await hosts.fleetRaw().catch(() => null);
    if (!fleet) complete = false;
    for (const raw of arr(fleet?.servers)) {
      const id = str(obj(raw).id);
      if (!id) continue;
      servers.set(id, { name: serverLabel(id), down: obj(raw).status === 'offline' });
    }
    // The machines connections run on, of servers that answer (a server down says it all).
    const wanted = [
      ...new Set(
        [...machines, ...windows]
          .filter((m) => m.guestId && servers.get(m.serverId)?.down === false)
          .map((m) => m.serverId),
      ),
    ];
    for (const serverId of wanted) {
      const list = await hosts.guestsRaw(serverId).catch(() => null);
      if (!list) complete = false;
      for (const raw of arr(list)) {
        const g = obj(raw);
        const id = str(g.id);
        if (!id) continue;
        const label = guestLabel({
          platform: str(g.platform) ?? '',
          kind: str(g.kind) ?? '',
          vmid: typeof g.vmid === 'number' ? g.vmid : null,
          name: str(g.name) ?? '',
          id,
        } as Parameters<typeof guestLabel>[0]);
        const state = str(g.state) ?? '';
        guests.set(`${serverId}/${id}`, {
          name: label,
          stopped: state === 'stopped' || state === 'exited' || state === 'dead',
        });
      }
    }
  }
  return { servers, guests, windows, wayOut, complete };
}

/** One pass: finds every connection's cause and keeps them; returns how many things are down because of something. */
export async function passCauses(services: Services, now = services.clock()): Promise<number> {
  await sweepQuietWindows(services, now).catch((err) =>
    services.log.warn({ err: err instanceof Error ? err.name : 'error' }, 'quiet windows: sweep failed'),
  );
  const [rows, open, windowRows] = await Promise.all([
    services.db.select().from(catalogConnections).where(eq(catalogConnections.status, 'active')),
    openWayOut(services.db),
    services.db
      .select()
      .from(quietWindows)
      .where(and(isNull(quietWindows.endedAt), lte(quietWindows.startsAt, now))),
  ]);
  const byBurrow = new Map<string, CatalogConnectionRow[]>();
  for (const r of rows) byBurrow.set(r.burrowId, [...(byBurrow.get(r.burrowId) ?? []), r]);
  // Burrows that had causes before and have no connection now still get theirs cleared.
  const before = await services.db.select({ ownerId: thingCauses.ownerId }).from(thingCauses);
  for (const b of before) if (!byBurrow.has(b.ownerId)) byBurrow.set(b.ownerId, []);
  let total = 0;
  for (const [burrowId, list] of byBurrow) {
    const conns = list.map((row) => {
      const glance = row.glance as ConnectionGlance | null;
      const machine = glance?.machine;
      return {
        thingId: thingId('connection', row.id),
        ...(machine ? { machine: { serverId: machine.serverId, guestId: machine.guestId } } : {}),
        answering: !glance?.outcome && glance?.status !== 'offline',
        internet: onInternet(row, machine),
      } satisfies CauseConnection;
    });
    const windows = windowRows
      .filter((w) => w.ownerId === burrowId && w.thingId.startsWith('server:') && windowHolds(w, now))
      .map((w) => ({ serverId: w.thingId.slice('server:'.length), guestId: w.guestId, work: !!w.work }));
    const world = await worldOf(
      services,
      burrowId,
      conns.flatMap((c) => (c.machine ? [c.machine] : [])),
      windows,
      open?.step ?? null,
    );
    const found = causesFor(conns, world);
    total += found.size;
    await keepCauses(services, burrowId, found, now, world.complete !== false);
  }
  return total;
}

/**
 * Writes a burrow's causes: new ones from now, the same ones checked again, gone ones removed; Home hears of a change.
 * `complete` false (the fleet or a server's machines couldn't be read): kept causes are left as they are, neither
 * removed nor replaced, and stop counting once nobody confirmed them for a while (`CAUSE_FRESH_MS`); only things without
 * one get theirs.
 */
export async function keepCauses(
  services: Services,
  burrowId: string,
  found: ReadonlyMap<string, FoundCause>,
  now: Date,
  complete = true,
): Promise<void> {
  await services.pipeline.transact(burrowId, async (session) => {
    const tx = session.tx;
    const kept = await tx.select().from(thingCauses).where(eq(thingCauses.ownerId, burrowId));
    const keptBy = new Map(kept.map((k) => [k.thingId, k]));
    const gone = complete ? kept.filter((k) => !found.has(k.thingId)).map((k) => k.thingId) : [];
    let changed = gone.length > 0;
    if (gone.length)
      await tx
        .delete(thingCauses)
        .where(and(eq(thingCauses.ownerId, burrowId), inArray(thingCauses.thingId, gone)));
    for (const [thing, cause] of found) {
      if (!complete && keptBy.has(thing)) continue;
      const was = keptBy.get(thing);
      const same =
        was && was.causeThing === cause.causeThing && was.kind === cause.kind && was.words === cause.words;
      if (!same) changed = true;
      await tx
        .insert(thingCauses)
        .values({
          ownerId: burrowId,
          thingId: thing,
          ...cause,
          since: same ? was.since : now,
          checkedAt: now,
        })
        .onConflictDoUpdate({
          target: [thingCauses.ownerId, thingCauses.thingId],
          set: { ...cause, since: same ? was.since : now, checkedAt: now },
        });
    }
    if (changed)
      publishHomeChanged(session, await homeAudience(session, burrowId), ['things', 'watch', 'needsYou']);
  });
}

/* What a cause takes with it -------------------------------------------------------------------------------------- */

/**
 * The names of the things that don't answer because of `cause` in a burrow (`server:pve-02` also takes those on its
 * machines),
 * people's names for them, by name.
 */
export async function takenNames(db: Db | Tx, burrowId: string, cause: string): Promise<string[]> {
  const rows = await db.select().from(thingCauses).where(eq(thingCauses.ownerId, burrowId));
  const ids = rows
    // Only what doesn't answer because of it is down with it; what is quiet with it isn't.
    .filter((r) => r.kind === 'down')
    .filter((r) => r.causeThing === cause || r.causeThing.startsWith(`${cause}/guest/`))
    .map((r) => r.thingId)
    .filter((t) => t.startsWith('connection:') || t.startsWith('device:'))
    .map((t) => t.slice(t.indexOf(':') + 1));
  if (!ids.length) return [];
  const named = await db
    .select({
      id: catalogConnections.id,
      label: catalogConnections.label,
      catalogId: catalogConnections.catalogId,
      fields: catalogConnections.fields,
    })
    .from(catalogConnections)
    .where(inArray(catalogConnections.id, ids));
  return named.map((r) => displayName(r)).sort((a, b) => a.localeCompare(b));
}

/**
 * A server that is down names what it takes with it in its Inbox item (“Plex and 4 more are down with it”): the items of
 * its “isn't checking in” alert, by the alerts they came from.
 */
export async function addTaken(
  db: Db | Tx,
  burrowId: string,
  items: NeedsYouItem[],
  alerts: readonly Pick<HostAlert, 'id' | 'rule' | 'serverId'>[],
): Promise<void> {
  const down = new Map(
    alerts.flatMap((a) =>
      a.rule === HEARTBEAT_RULE && a.serverId ? [[`hosts.alert:${a.id}`, a.serverId]] : [],
    ),
  );
  if (!down.size) return;
  for (const item of items) {
    const server = down.get(item.id);
    if (!server) continue;
    const words = takenWords(await takenNames(db, burrowId, thingId('server', server)).catch(() => []));
    if (words) item.body = `${item.body.replace(/[.\s]*$/, '')}. ${words}.`.replace(/^\. /, '').slice(0, 600);
  }
}

// The way out's Inbox item names what is down because of it.
setWayOutTakenBy(takenNames);
registerWayOutSource();
