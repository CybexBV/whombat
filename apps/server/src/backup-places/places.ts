/**
 * The backup places on the network (docs/decisions/backup-places.md BPL-03, BPL-04): the servers Whombat's helper reports
 * a `backup_place` for, the TrueNAS, Synology and QNAP connections, and those NAS the network scan found that aren't
 * connected yet, each in one of five states. The place that keeps the backups now is the one whose repository the
 * backup service reports; one Whombat set up that has left the network still shows, so Settings always says where the
 * backups are.
 */
import {
  BACKUP_PLACE_TEXT,
  type BackupPlace,
  type BackupPlaceKept,
  type BackupPlaceKind,
  type BackupPlaceLocation,
  backupPlaceClient,
  backupPlaceId,
  placeKindOfCatalog,
  placeKindOfServer,
} from '@whombat/core';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { burrowFound } from '../connections/discover';
import { applianceState, burrows, catalogConnections } from '../db/schema/index';
import { loadWhombatName } from '../desk/store';
import { HOSTS_API, seg } from '../hosts/client';
import { arr, obj, str } from '../hosts/map';
import { hostsFor, WHOMBAT_ACTOR } from '../hosts/service';
import { boxBackupStatus } from '../managed/box-backup';
import type { Services } from '../services';
import { keptOf, pickAddress } from './drivers/agent';
import { placeDriver } from './drivers/index';
import { type HubBackupPlace, hubBackupPlace, manageOn, serverAddress } from './hub';
import { type LocationFacts, placeLocations } from './locations';
import { forgetServers, serversRead } from './servers-cache';
import { type BackupPlaceRow, loadPlaceRows } from './store';
import { noteHints, placeHints } from './watch';
import { placeWords } from './words';

const T = BACKUP_PLACE_TEXT;

/** A server as the places list reads it. */
export interface ServerFacts {
  id: string;
  name: string;
  /** This Whombat runs on it. */
  self: boolean;
  unraid: boolean;
  /** Its `backup_place`; null from an agent that doesn't report one. */
  hub: HubBackupPlace | null;
  manage: boolean;
  /** The address the hosts service knows it by. */
  address: string | null;
}

/** Reasons a server is listed even though it can't keep backups: one the person can fix, or an Unraid box. */
const FIXABLE = new Set(['docker_down', 'array_stopped']);

/**
 * A server's place (pure), or null when it isn't one worth listing: a server without Docker or the one this Whombat runs
 * on is listed only when it is an Unraid box (people expect their NAS there, with the reason it can't).
 */
export function serverPlace(s: ServerFacts, client: string | null): BackupPlace | null {
  const kind: BackupPlaceKind = s.unraid ? 'unraid' : placeKindOfServer(s.hub?.platform);
  const base = {
    id: backupPlaceId({ type: 'server', id: s.id }),
    kind,
    name: s.name,
    address: (s.hub && pickAddress(s.hub.addresses, s.address)) ?? s.address,
    byHand: false,
    kept: s.hub && client ? keptOf(s.hub, client) : null,
    locations: placeLocations(s.hub?.locations ?? []),
    // Where its backups are on it as the agent reports (`placesList` keeps it only for the place in use).
    location: (client && s.hub?.clients.find((c) => c.client === client)?.location) || null,
  };
  const unsupported = (reason: string) => ({ ...base, state: 'unsupported' as const, reason });
  if (!s.hub) return s.unraid ? unsupported(placeWords.helperOld) : null;
  if (s.self || s.hub.reason === 'self') return kind === 'unraid' ? unsupported(T.reasons.self) : null;
  if (!s.hub.supported)
    return kind === 'unraid' || FIXABLE.has(s.hub.reason ?? '')
      ? unsupported(placeWords.reason(s.hub.reason))
      : null;
  if (!s.manage) return { ...base, state: 'manage_first', reason: T.reasons.manage };
  return { ...base, state: 'ready', reason: null };
}

/** A NAS connection as the places list reads it. */
export interface ConnectionFacts {
  id: string;
  kind: BackupPlaceKind;
  name: string;
  address: string | null;
  active: boolean;
  manage: boolean;
  /** What its driver says, when it has a say (Manage on). */
  status: {
    supported: boolean;
    reason: string | null;
    byHand: boolean;
    freeBytes: number | null;
    locations?: LocationFacts[];
    wasIn?: string | null;
  } | null;
  kept: BackupPlaceKept | null;
}

/** A connection's place (pure). */
export function connectionPlace(c: ConnectionFacts): BackupPlace {
  const base = {
    id: backupPlaceId({ type: 'connection', id: c.id }),
    kind: c.kind,
    name: c.name,
    address: c.address,
    byHand: false,
    kept: c.kept,
    locations: [] as BackupPlaceLocation[],
    location: null as string | null,
  };
  if (!c.active) return { ...base, state: 'connect_first', reason: T.reasons.connect(c.name) };
  if (!c.manage) return { ...base, state: 'manage_first', reason: T.reasons.manage };
  const st = c.status;
  if (st && !st.supported)
    return { ...base, state: 'unsupported', reason: st.reason ?? T.reasons.other, byHand: st.byHand };
  const kept =
    c.kept ??
    (st?.freeBytes != null
      ? {
          usedBytes: null,
          freeBytes: st.freeBytes,
          cleanup: { on: false, keepDays: 90, lastAt: null, ok: null },
          byHand: false,
        }
      : null);
  return {
    ...base,
    state: 'ready',
    reason: null,
    kept,
    byHand: st?.byHand ?? false,
    locations: placeLocations(st?.locations ?? []),
    // A place set up before there was a choice keeps them where the driver put them then (`placesList`: in use only).
    location: st?.wasIn ?? null,
  };
}

/** A NAS the scan found (pure): `connect_first`, said as “Synology at 192.168.1.40”. */
export function foundPlace(f: { catalogId: string; host: string }): BackupPlace | null {
  const kind = f.catalogId === 'unraid' ? 'unraid' : placeKindOfCatalog(f.catalogId);
  if (!kind) return null;
  const name = T.kind(kind);
  return {
    id: backupPlaceId({ type: 'found', host: f.host }),
    kind,
    name,
    address: f.host,
    state: 'connect_first',
    reason: T.reasons.connect(`${name} at ${f.host}`),
    byHand: false,
    kept: null,
    locations: [],
    location: null,
  };
}

/**
 * The places in the order they are listed (pure): servers with most free space first, then connections, then finds; the
 * one whose record holds the repository in use marked `in_use` (and added from its record when it isn't on the network
 * now). Only the place in use says where on it the backups are: a server as its agent reports it (it moves them), else
 * the record's, else where a NAS put them before there was a choice.
 */
export function placesList(input: {
  servers: readonly BackupPlace[];
  connections: readonly BackupPlace[];
  found: readonly BackupPlace[];
  rows: readonly BackupPlaceRow[];
  repositoryId: string | null;
}): { places: BackupPlace[]; currentPlaceId: string | null } {
  const free = (p: BackupPlace) => p.kept?.freeBytes ?? -1;
  const places = [
    ...[...input.servers].sort((a, b) => free(b) - free(a)),
    ...input.connections,
    ...input.found,
  ].map((p) => (p.location === null ? p : { ...p, location: null }));
  const reported = new Map([...input.servers, ...input.connections].map((p) => [p.id, p.location] as const));
  const current = input.repositoryId
    ? input.rows.find((r) => r.repositoryId === input.repositoryId)
    : undefined;
  if (!current) return { places, currentPlaceId: null };
  const i = places.findIndex((p) => p.id === current.id);
  const listed = places[i];
  const kept: BackupPlaceKept = listed?.kept
    ? { ...listed.kept, byHand: current.byHand }
    : {
        usedBytes: null,
        freeBytes: null,
        cleanup: { on: current.cleanupAt !== null, keepDays: 90, lastAt: null, ok: null },
        byHand: current.byHand,
      };
  const inUse: BackupPlace = {
    id: current.id,
    kind: listed?.kind ?? current.kind,
    name: listed?.name ?? current.name,
    address: current.address ?? listed?.address ?? null,
    state: 'in_use',
    reason: null,
    byHand: listed?.byHand ?? current.byHand,
    kept,
    locations: listed?.locations ?? [],
    location: current.id.startsWith('server:')
      ? (reported.get(current.id) ?? current.location ?? null)
      : (current.location ?? reported.get(current.id) ?? null),
  };
  if (i >= 0) places[i] = inUse;
  else places.unshift(inUse);
  return { places, currentPlaceId: current.id };
}

/**
 * The places that kept this Whombat's backups before the one in use (pure): records that hold a repository other than
 * the one backups go to now, the most recently changed first, by the name the network gives them now. The backups made
 * there stay there and drop out of the list, so the Backups page says where they are. Nothing while the backup service
 * hasn't said where backups go: any record could be the one in use.
 */
export function earlierPlaces(
  now: Pick<PlacesNow, 'places' | 'rows' | 'currentPlaceId' | 'statusKnown'>,
): { placeId: string; name: string }[] {
  if (!now.statusKnown) return [];
  const current = now.rows.find((r) => r.id === now.currentPlaceId)?.repositoryId ?? null;
  return now.rows
    .filter((r) => r.id !== now.currentPlaceId && r.repositoryId && r.repositoryId !== current)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, 20)
    .map((r) => ({ placeId: r.id, name: now.places.find((p) => p.id === r.id)?.name ?? r.name }));
}

/* Reading the network ------------------------------------------------------------------------------------------------ */

/** The burrow the places belong to: the hosts service's (this Whombat's oldest). */
async function homeBurrowId(services: Services): Promise<string | null> {
  return hostsFor(services)
    .homeBurrowId()
    .catch(() => null);
}

/** How long the servers' details are kept for the Inbox and the lists (the flows read them fresh). */
const SERVERS_TTL_MS = 30_000;

/** The servers' facts, kept half a minute unless `fresh`. */
function serversNow(services: Services, fresh: boolean): Promise<ServerFacts[]> {
  const now = Date.now();
  const hit = serversRead.get(services);
  if (!fresh && hit && now - hit.at < SERVERS_TTL_MS) return hit.value;
  const value = serverFacts(services);
  serversRead.set(services, { at: now, value });
  return value;
}

export { forgetServers };

/** Every server the hosts service lists, with its detail (read as admin, so its switches show). */
export async function serverFacts(services: Services): Promise<ServerFacts[]> {
  const hosts = hostsFor(services);
  if (!hosts.present) return [];
  const fleet = await hosts.fleetRaw().catch(() => null);
  const cards = arr(fleet?.servers).map(obj);
  const out = await Promise.all(
    cards.map(async (card): Promise<ServerFacts | null> => {
      const id = str(card.id);
      if (!id) return null;
      const raw = await hosts
        .call<unknown>({
          path: `${HOSTS_API}/servers/${seg(id)}`,
          actor: { ...WHOMBAT_ACTOR, role: 'admin' },
        })
        .catch(() => null);
      if (!raw) return null;
      const server = obj(obj(raw).server);
      const hostname = str(card.hostname) ?? str(server.hostname) ?? '';
      const os = obj(server.os);
      return {
        id,
        name: hostname && hostname.toLowerCase() === id.toLowerCase() ? hostname : id,
        self: card.hosts_this_whombat === true || server.hosts_this_whombat === true,
        unraid: card.detail_view === 'unraid' || /unraid/i.test(str(os.name) ?? ''),
        hub: hubBackupPlace(raw),
        manage: manageOn(raw),
        address: serverAddress(raw),
      };
    }),
  );
  return out.filter((s): s is ServerFacts => s !== null);
}

const NAS_CATALOG = ['truenas', 'synology', 'qnap'] as const;

/** A connection's host, as people and the scan see it. */
export function hostOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/** The NAS connections (TrueNAS, Synology, QNAP) and what their drivers say. */
async function connectionFacts(
  services: Services,
  burrowId: string,
  rows: readonly BackupPlaceRow[],
  client: string,
): Promise<ConnectionFacts[]> {
  const list = await services.db
    .select({
      id: catalogConnections.id,
      catalogId: catalogConnections.catalogId,
      label: catalogConnections.label,
      baseUrl: catalogConnections.baseUrl,
      status: catalogConnections.status,
      access: catalogConnections.access,
    })
    .from(catalogConnections)
    .where(
      and(eq(catalogConnections.burrowId, burrowId), inArray(catalogConnections.catalogId, [...NAS_CATALOG])),
    )
    .orderBy(asc(catalogConnections.createdAt));
  return Promise.all(
    list.map(async (c): Promise<ConnectionFacts> => {
      const kind = placeKindOfCatalog(c.catalogId) as BackupPlaceKind;
      const id = backupPlaceId({ type: 'connection', id: c.id });
      const active = c.status === 'active';
      const manage = c.access === 'manage';
      let status: ConnectionFacts['status'] = null;
      let kept: BackupPlaceKept | null = null;
      if (active && manage) {
        const driver = placeDriver({
          services,
          target: { id, ref: { type: 'connection', id: c.id }, kind, name: c.label },
          actor: WHOMBAT_ACTOR,
        });
        status = (await driver.status?.().catch(() => null)) ?? null;
        if (rows.some((r) => r.id === id)) kept = await driver.kept(client).catch(() => null);
      }
      return { id: c.id, kind, name: c.label, address: hostOf(c.baseUrl), active, manage, status, kept };
    }),
  );
}

/**
 * The client name this Whombat's backups go under (BPL-01): the one it used before, else made from its name and its
 * device id (`wb-3fkq-…` → `3fkq`), or its burrow's id on a box that has none.
 */
export async function clientName(services: Services, rows?: readonly BackupPlaceRow[]): Promise<string> {
  const had = (rows ?? (await loadPlaceRows(services.db)))[0]?.client;
  if (had) return had;
  const [state] = await services.db.select({ device: applianceState.claimDeviceId }).from(applianceState);
  const [burrow] = await services.db
    .select({ id: burrows.id, name: burrows.name })
    .from(burrows)
    .orderBy(asc(burrows.createdAt), asc(burrows.id))
    .limit(1);
  const name = (await loadWhombatName(services.db).catch(() => null)) ?? burrow?.name ?? '';
  const device = state?.device?.split('-')[1];
  const short = device || (burrow?.id ?? 'box').replace(/[^a-z0-9]/gi, '').slice(-6);
  return backupPlaceClient(name, short);
}

/** Everything `backup.places` answers, plus the records and facts the flows reuse. */
export interface PlacesNow {
  places: BackupPlace[];
  currentPlaceId: string | null;
  /** The backup service said where backups go (else no place is known to be in use, which isn't “none is”). */
  statusKnown: boolean;
  rows: BackupPlaceRow[];
  client: string;
  servers: ServerFacts[];
}

/** The places now (`fresh`: the backup service asked again rather than its last report). */
export async function placesNow(services: Services, options: { fresh?: boolean } = {}): Promise<PlacesNow> {
  const [rows, status, burrowId, servers] = await Promise.all([
    loadPlaceRows(services.db),
    boxBackupStatus(services, options),
    homeBurrowId(services),
    serversNow(services, options.fresh === true),
  ]);
  const client = await clientName(services, rows);
  const connections = burrowId ? await connectionFacts(services, burrowId, rows, client) : [];
  const taken = new Set([
    ...servers.flatMap((s) => [s.address, ...(s.hub?.addresses ?? [])]),
    ...connections.map((c) => c.address),
  ]);
  const finds = burrowId ? (burrowFound(services, burrowId).last?.found ?? []) : [];
  const seen = new Set<string>();
  const found = finds.flatMap((f) => {
    const host = f.host.toLowerCase();
    if (taken.has(host) || seen.has(host)) return [];
    seen.add(host);
    return foundPlace(f) ?? [];
  });
  const repositoryId =
    status?.destination.configured && status.destination.repositoryId
      ? status.destination.repositoryId
      : null;
  const list = placesList({
    servers: servers.flatMap((s) => serverPlace(s, client) ?? []),
    connections: connections.map(connectionPlace),
    found,
    rows,
    repositoryId,
  });
  if (hostsFor(services).present) noteHints(services, placeHints(servers, rows, client, services.clock()));
  return { ...list, statusKnown: !!status, rows, client, servers };
}
