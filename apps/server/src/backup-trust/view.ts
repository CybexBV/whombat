/**
 * What's protected (docs/decisions/backup-trust.md): one row for everything that holds data — this Whombat, each
 * server, each machine on a server, each connected service that keeps data — with where its newest copy is kept: on
 * another machine, only on the same machine, or nowhere Whombat can see. Read from what Whombat already knows (the
 * backup service's status, the hosts service's guests, backup jobs and storages, what the health pass read about each
 * service's own backups); nothing is asked of a service just for this page. Kept a minute.
 */
import {
  type HostServer,
  isTemporaryGuest,
  isTemporaryServer,
  type ProtectedRow,
  type ProtectedState,
  type ProtectedView,
  type RestoreTestResult,
  type RestoreTestServer,
  thingHref,
} from '@whombat/core';
import { type BackupOffsite, type BackupServiceStatus, offsitePlaceName } from '@whombat/protocol/session';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { placesNow } from '../backup-places/places';
import { changeWindowOf } from '../care/window';
import {
  applianceEvents,
  burrows,
  catalogConnections,
  restoreTestServers,
  restoreTests,
  type StoredProtection,
} from '../db/schema/index';
import { BACKUPS_HREF } from '../home/box-backup';
import { arr, obj, toHostBackupJob, toHostBackupVolumes, toHostChoices, toHostGuest } from '../hosts/map';
import { hostsFor, WHOMBAT_ACTOR } from '../hosts/service';
import { G, S } from '../hosts/tools-shared';
import { offsiteNow } from '../managed/backup-offsite';
import { boxBackupStatus } from '../managed/box-backup';
import type { Services } from '../services';
import { guestLabel, machineHref } from '../things/runs-on';
import { eligibleGuests, nextTestAt } from './plan';
import { betterProtection, provenProtection } from './protection';

const VIEW_MS = 60_000;
/** Machines whose own backup lists are read in one build (each kept until its newest backup changes); the rest wait. */
const BACKUP_READS_MAX = 20;

/** Connected services that keep data of their own (photos, documents, files, a smart home's history, backups). */
export const DATA_KINDS: ReadonlySet<string> = new Set([
  'homeassistant',
  'immich',
  'paperless',
  'nextcloud',
  'proxmox_backup',
  'truenas',
  'synology',
  'qnap',
  'frigate',
  'forgejo',
  'jellyfin',
  'plex',
]);

/** Proxmox storages that live on another machine: a backup there survives the server. */
const AWAY_TYPES = new Set(['pbs', 'nfs', 'cifs', 'cephfs', 'rbd', 'glusterfs', 'iscsi', 'iscsidirect']);

type TestRow = typeof restoreTests.$inferSelect;
type Burrow = typeof burrows.$inferSelect;

/** A finished test as people read it. */
export function testResult(r: TestRow): RestoreTestResult | null {
  if (!r.outcome) return null;
  const at = r.finishedAt ?? r.stepAt;
  return {
    serverId: r.serverId,
    guestId: r.guestId,
    guestName: r.guestName.slice(0, 160),
    at: at.toISOString(),
    outcome: r.outcome,
    ...(r.reason ? { reason: r.reason as RestoreTestResult['reason'] } : {}),
    ...(r.durationS !== null ? { durationS: Math.min(86_400, r.durationS) } : {}),
    ...(r.booted !== null ? { booted: r.booted } : {}),
    backupAt: r.backupAt?.toISOString() ?? null,
  };
}

/** The newest test of one machine that came to an outcome, or null. */
export async function latestRestoreTest(
  services: Services,
  burrowId: string,
  serverId: string,
  guestId: string,
): Promise<RestoreTestResult | null> {
  const rows = await services.db
    .select()
    .from(restoreTests)
    .where(
      and(
        eq(restoreTests.burrowId, burrowId),
        eq(restoreTests.serverId, serverId),
        eq(restoreTests.guestId, guestId),
        isNotNull(restoreTests.outcome),
      ),
    )
    .orderBy(desc(restoreTests.startedAt))
    .limit(1);
  return rows[0] ? testResult(rows[0]) : null;
}

/* The offsite copy of this Whombat's own backups ------------------------------------------------------------------ */

/**
 * The second place this Whombat's backups are copied to, as its row says it: the storage's name (never its address),
 * the last copy only once the bucket's own list showed a backup in it, and when copying there failed while it fails.
 */
export function offsiteOf(offsite: BackupOffsite | null | undefined): ProtectedRow['offsite'] {
  if (!offsite) return null;
  const confirmed = offsite.newestInCopyAt !== null;
  return {
    name: offsitePlaceName(offsite).slice(0, 160),
    lastAt: confirmed ? offsite.lastCopyAt : null,
    ...(offsite.state === 'failing' && offsite.lastFailure ? { failedAt: offsite.lastFailure.at } : {}),
  };
}

/* Machines ------------------------------------------------------------------------------------------------------------ */

interface StorageInfo {
  type: string;
  shared: boolean;
}

function storageState(s: StorageInfo | undefined): 'copied' | 'local' | null {
  if (!s) return null;
  return AWAY_TYPES.has(s.type) || s.shared ? 'copied' : 'local';
}

/**
 * An Incus or QEMU/KVM machine's state: its snapshots stay in its own storage pool, its backups on its own server, and
 * only a backup that worked counts (a failed one is none worked yet).
 */
export function sameMachineState(
  platform: string,
  f: { snapshots?: number | null; last: { result: string } | null },
): ProtectedState {
  if (platform === 'incus') return (f.snapshots ?? 0) > 0 ? 'local' : 'none';
  return f.last && f.last.result !== 'error' ? 'local' : 'none';
}

/** The newest backup on a machine's backup list: the storage it is on (its id and kind, when known) and when. */
export interface NewestOnList {
  storageId: string;
  storage: StorageInfo | undefined;
  at: string | null;
}

/** What a Proxmox machine's row says about its backups. */
export interface PveProtection {
  state: ProtectedState;
  lastAt: string | null;
  where: string | null;
  failedAt?: string;
  planned?: true;
}

/**
 * Where a Proxmox machine's backups are, from what was read. Copied or local only for a backup that worked, by the
 * storage its own backup list shows it on (a plan's storage says where backups should go, not where one is); none when
 * no backup of it has worked (planned when a plan covers it); “can't see” when its backup list or the server's storages
 * weren't read, or a backup worked that its list doesn't show.
 */
export function pveProtection(f: {
  /** The newest backup the server reported for it (worked or failed); null: none ever. */
  last: { result: string; at: string } | null;
  planned: boolean;
  /** The newest backup on its backup list; null: the list has none; undefined: not read. */
  newest: NewestOnList | null | undefined;
  /** The server's storages were read. */
  listsRead: boolean;
}): PveProtection {
  const plan = f.planned ? { planned: true as const } : {};
  if (!f.last) return { state: 'none', lastAt: null, where: null, ...plan };
  const failed = f.last.result === 'error';
  const fail = failed ? { failedAt: f.last.at } : {};
  // The newest that worked: the reported one, or after a failure the newest still on its list.
  const lastAt = failed ? (f.newest?.at ?? null) : f.last.at;
  if (f.newest === undefined || !f.listsRead) return { state: 'unseen', lastAt, where: null, ...fail };
  if (f.newest === null)
    return failed
      ? { state: 'none', lastAt: null, where: null, ...fail, ...plan }
      : { state: 'unseen', lastAt, where: null };
  const at = storageState(f.newest.storage);
  if (at === null || !lastAt) return { state: 'unseen', lastAt, where: null, ...fail };
  return { state: at, lastAt, where: f.newest.storageId, ...fail };
}

type ListPlace = Omit<NewestOnList, 'storage'> | null;

/** Machines' newest backups read from their lists, kept while each one's newest reported backup stays the same. */
const listPlaces = new WeakMap<Services, Map<string, { mark: string; place: ListPlace }>>();
const LIST_PLACES_MAX = 5_000;

/**
 * The newest backup on a machine's own backup list (one read through its server). A read is kept until the machine's
 * newest backup changes, so each build reads only machines not read yet, at most `budget.reads` of them; undefined
 * when it wasn't read this time (past the budget, or the server didn't answer).
 */
async function newestOnList(
  services: Services,
  serverId: string,
  guestId: string,
  last: { result: string; at: string },
  budget: { reads: number },
): Promise<ListPlace | undefined> {
  let byGuest = listPlaces.get(services);
  if (!byGuest) {
    byGuest = new Map();
    listPlaces.set(services, byGuest);
  }
  const key = `${serverId}\n${guestId}`;
  const mark = `${last.result}@${last.at}`;
  const kept = byGuest.get(key);
  if (kept?.mark === mark) return kept.place;
  if (budget.reads <= 0) return undefined;
  budget.reads--;
  try {
    const volumes = toHostBackupVolumes(
      await hostsFor(services).call<unknown>({
        path: `${G(serverId, guestId)}/backups`,
        actor: { ...WHOMBAT_ACTOR, role: 'operator' },
      }),
    );
    const time = (v: { created?: string | null }) => Date.parse(v.created ?? '') || 0;
    const newest = [...volumes].filter((v) => v.storage).sort((a, b) => time(b) - time(a))[0];
    const place: ListPlace = newest
      ? { storageId: newest.storage, at: time(newest) ? new Date(time(newest)).toISOString() : null }
      : null;
    if (byGuest.size >= LIST_PLACES_MAX) byGuest.clear();
    byGuest.set(key, { mark, place });
    return place;
  } catch {
    return undefined;
  }
}

interface MachineFacts {
  row: ProtectedRow;
  /** For a service on it: its state as a stored fact. */
  fact: StoredProtection | null;
}

/** A server's machines and where their backups go. */
async function serverMachines(
  services: Services,
  server: HostServer,
  tests: ReadonlyMap<string, RestoreTestResult>,
  budget: { reads: number },
  unread: string[],
): Promise<MachineFacts[]> {
  const hosts = hostsFor(services);
  let raw: unknown[];
  try {
    raw = await hosts.guestsRaw(server.id);
  } catch {
    unread.push(server.name);
    return [];
  }
  const guests = raw
    .map((g) => ({ raw: obj(g), g: toHostGuest(g, server.id) }))
    .filter(
      ({ raw: r, g }) =>
        (g.platform === 'pve' || g.platform === 'incus' || g.platform === 'libvirt') &&
        r.template !== true &&
        !g.self &&
        !isTemporaryGuest(g),
    );
  if (!guests.length) return [];
  const pve = guests.some(({ g }) => g.platform === 'pve');
  const [jobs, storages] = pve
    ? await Promise.all([
        hosts
          .call<unknown>({ path: `${S(server.id)}/backup-jobs`, actor: WHOMBAT_ACTOR })
          .then((r) => arr(obj(r).items).map(toHostBackupJob))
          .catch(() => null),
        hosts
          .call<unknown>({
            path: `${S(server.id)}/manage/choices`,
            query: { platform: 'pve' },
            actor: { ...WHOMBAT_ACTOR, role: 'operator' },
          })
          .then(
            (r) =>
              new Map(toHostChoices(r).storages.map((s) => [s.id, { type: s.type, shared: !!s.shared }])),
          )
          .catch(() => null),
      ])
    : [null, null];
  const out: MachineFacts[] = [];
  for (const { g } of guests) {
    const name = guestLabel(g).slice(0, 120);
    const base = {
      key: `guest:${server.id}:${g.id}`.slice(0, 300),
      kind: g.kind === 'vm' ? ('vm' as const) : ('container' as const),
      name,
      on: server.name.slice(0, 160),
      href: machineHref(server.id, g.id).slice(0, 500),
      serverId: server.id,
      guestId: g.id,
      restoreTest: tests.get(`${server.id}\n${g.id}`) ?? null,
    };
    const last = g.lastBackup ?? null;
    const failed = last?.result === 'error';
    let state: ProtectedState;
    let lastAt = last && !failed ? last.at : null;
    let where: string | null = null;
    let planned = false;
    if (g.platform === 'pve') {
      const enabled = (jobs ?? []).filter((j) => j.enabled);
      const covering = enabled.find(
        (j) =>
          (j.selection === 'all' &&
            !(j.exclude ?? []).includes(g.id) &&
            !(j.exclude ?? []).includes(String(g.vmid))) ||
          (j.selection === 'guests' &&
            ((j.guests ?? []).includes(g.id) || (j.guests ?? []).includes(String(g.vmid)))),
      );
      const newest = last ? await newestOnList(services, server.id, g.id, last, budget) : null;
      const p = pveProtection({
        last,
        planned: !!covering || g.backupJob === true,
        newest: newest && { ...newest, storage: storages?.get(newest.storageId) },
        listsRead: !!storages,
      });
      state = p.state;
      lastAt = p.lastAt;
      where = p.where;
      planned = !!p.planned;
    } else {
      state = sameMachineState(g.platform, { snapshots: g.snapshots, last });
    }
    const row: ProtectedRow = {
      ...base,
      state,
      lastAt,
      where: where ? where.slice(0, 160) : null,
      ...(failed && last ? { failedAt: last.at } : {}),
      ...(planned ? { planned: true } : {}),
    };
    out.push({
      row,
      fact:
        state === 'unseen'
          ? null
          : {
              state,
              lastAt,
              where: row.where,
              ...(failed && last ? { failedAt: last.at } : {}),
              ...(planned ? { planned: true } : {}),
            },
    });
  }
  return out;
}

/* Restore tests per server -------------------------------------------------------------------------------------------- */

export async function restoreTestServerView(
  services: Services,
  burrow: Pick<Burrow, 'id' | 'timeZone' | 'changeWindowStart' | 'changeWindowEnd'>,
  server: Pick<HostServer, 'id' | 'name' | 'status' | 'remoteControl'>,
  rows?: { setting: typeof restoreTestServers.$inferSelect | null; tests: TestRow[] },
): Promise<RestoreTestServer> {
  const db = services.db;
  const setting =
    rows?.setting ??
    (
      await db
        .select()
        .from(restoreTestServers)
        .where(and(eq(restoreTestServers.burrowId, burrow.id), eq(restoreTestServers.serverId, server.id)))
    )[0] ??
    null;
  const tests =
    rows?.tests ??
    (await db
      .select()
      .from(restoreTests)
      .where(and(eq(restoreTests.burrowId, burrow.id), eq(restoreTests.serverId, server.id)))
      .orderBy(desc(restoreTests.startedAt))
      .limit(50));
  const raw = await hostsFor(services)
    .guestsRaw(server.id)
    .catch(() => null);
  const eligible = eligibleGuests(raw ?? []).slice(0, 200);
  const blocked =
    server.status === 'offline' || raw === null
      ? ('offline' as const)
      : server.remoteControl.manage === false
        ? ('manage_off' as const)
        : !eligible.length
          ? ('no_guests' as const)
          : undefined;
  const running = tests.find((t) => !t.finishedAt) ?? null;
  const last = tests.map(testResult).find((r) => r !== null) ?? null;
  const weekly = tests.find((t) => !t.manual) ?? null;
  const on = setting?.on === true;
  const next = on
    ? nextTestAt(services.clock(), changeWindowOf(burrow), burrow.timeZone, weekly?.startedAt ?? null)
    : null;
  return {
    serverId: server.id,
    serverName: server.name.slice(0, 120),
    on,
    guests: (setting?.guests ?? []).slice(0, 200),
    eligible: eligible.map((g) => ({ id: g.id, name: g.name.slice(0, 160), kind: g.kind })),
    ...(blocked ? { blocked } : {}),
    last,
    running: running
      ? {
          guestId: running.guestId,
          guestName: running.guestName.slice(0, 160),
          startedAt: running.startedAt.toISOString(),
        }
      : null,
    next: next?.toISOString() ?? null,
  };
}

/* The whole view ---------------------------------------------------------------------------------------------------- */

/**
 * When backups started going to the repository they go to now, from the places Whombat set (oldest first): the newest
 * change to it from another one, or the first. A move of the same repository to a new address isn't a change. Null
 * when Whombat set no place or the newest one it set isn't this repository (set some other way): then it can't tell.
 */
export function placeChosenAt(
  sets: readonly { repositoryId: string | null; at: string }[],
  repositoryId: string | null | undefined,
): string | null {
  let since: string | null = null;
  let current: string | null = null;
  for (const set of sets) {
    if (set.repositoryId !== current) since = set.at;
    current = set.repositoryId;
  }
  return repositoryId && current === repositoryId ? since : null;
}

/**
 * This Whombat's own row from its backup service's status: copied or local only once a backup worked at the place
 * backups go now. The service keeps its last backup when the place changes, so one from before the place was chosen
 * doesn't count; until a backup works there the place is a plan (with the failure while backups there fail).
 */
export function whombatProtection(
  status: Pick<BackupServiceStatus, 'state' | 'destination' | 'lastSuccess' | 'lastFailure'>,
  chosenAt: string | null,
): { state: ProtectedState; lastAt: string | null; planned?: true; failedAt?: string } {
  const failed = status.state === 'failing' && status.lastFailure ? { failedAt: status.lastFailure.at } : {};
  if (!status.destination.configured) return { state: 'none', lastAt: null, ...failed };
  const last = status.lastSuccess?.at ?? null;
  const here = last !== null && (chosenAt === null || Date.parse(last) >= Date.parse(chosenAt));
  if (!here) return { state: 'none', lastAt: null, planned: true, ...failed };
  return { state: status.destination.kind === 'local' ? 'local' : 'copied', lastAt: last, ...failed };
}

/** The places Whombat set for this Whombat's backups, oldest first (the newest 200). */
async function placeSets(services: Services): Promise<{ repositoryId: string | null; at: string }[]> {
  const rows = await services.db
    .select({ payload: applianceEvents.payload, at: applianceEvents.createdAt })
    .from(applianceEvents)
    .where(eq(applianceEvents.type, 'backup.destination_set'))
    .orderBy(desc(applianceEvents.seq))
    .limit(200);
  return rows.reverse().map((r) => ({
    repositoryId: typeof r.payload.repositoryId === 'string' ? r.payload.repositoryId : null,
    at: r.at.toISOString(),
  }));
}

async function whombatRow(services: Services, unread: string[], name: string): Promise<ProtectedRow | null> {
  const status = await boxBackupStatus(services).catch(() => null);
  // A development box has no backup service: nothing to say about it.
  if (status === undefined) return null;
  const base = { key: 'whombat', kind: 'whombat' as const, name, href: BACKUPS_HREF };
  if (!status) {
    unread.push(name);
    return { ...base, state: 'unseen', lastAt: null, where: null };
  }
  const configured = status.destination.configured;
  const now = configured ? await placesNow(services).catch(() => null) : null;
  const place = now?.places.find((p) => p.id === now.currentPlaceId);
  const where = configured ? (place?.name ?? status.destination.display ?? null) : null;
  const chosenAt = configured
    ? placeChosenAt(await placeSets(services).catch(() => []), status.destination.repositoryId)
    : null;
  const p = whombatProtection(status, chosenAt);
  return {
    ...base,
    ...p,
    where: p.state === 'copied' && where ? where.slice(0, 160) : null,
    offsite: offsiteOf(await offsiteNow(services).catch(() => undefined)),
  };
}

export async function buildProtectedView(services: Services, burrowId: string): Promise<ProtectedView> {
  const db = services.db;
  const now = services.clock();
  const [burrow] = await db.select().from(burrows).where(eq(burrows.id, burrowId));
  const unread: string[] = [];
  const rows: ProtectedRow[] = [];
  const own = await whombatRow(services, unread, 'Whombat');
  if (own) rows.push(own);

  const hosts = hostsFor(services);
  const serves = await hosts.serves(burrowId).catch(() => false);
  const servers = serves ? ((await hosts.fleet().catch(() => null))?.servers ?? null) : [];
  if (servers === null) unread.push('Servers');
  const settings = await db
    .select()
    .from(restoreTestServers)
    .where(eq(restoreTestServers.burrowId, burrowId));
  const testRows = await db
    .select()
    .from(restoreTests)
    .where(and(eq(restoreTests.burrowId, burrowId), isNotNull(restoreTests.serverId)))
    .orderBy(desc(restoreTests.startedAt))
    .limit(1000);
  const newestTest = new Map<string, RestoreTestResult>();
  for (const t of testRows) {
    const r = testResult(t);
    const key = `${t.serverId}\n${t.guestId}`;
    if (r && !newestTest.has(key)) newestTest.set(key, r);
  }

  const machines = new Map<string, StoredProtection | null>();
  const budget = { reads: BACKUP_READS_MAX };
  const restore: RestoreTestServer[] = [];
  for (const server of (servers ?? []).filter(
    (s) => !isTemporaryServer(s.name) && !isTemporaryServer(s.id),
  )) {
    const found = await serverMachines(services, server, newestTest, budget, unread);
    // The server itself: Whombat sees its machines' backups, not a backup of the server's own system.
    rows.push({
      key: `server:${server.id}`.slice(0, 300),
      kind: 'server',
      name: server.name.slice(0, 160),
      href: machineHref(server.id, null).slice(0, 500),
      state: 'unseen',
      lastAt: null,
      where: null,
      serverId: server.id,
    });
    machines.set(`${server.id}\n`, null);
    for (const m of found) {
      rows.push(m.row);
      machines.set(`${server.id}\n${m.row.guestId}`, m.fact);
    }
    if (server.platform === 'proxmox' && burrow)
      restore.push(
        await restoreTestServerView(services, burrow, server, {
          setting: settings.find((s) => s.serverId === server.id) ?? null,
          tests: testRows.filter((t) => t.serverId === server.id).slice(0, 50),
        }),
      );
  }

  // Connected services that keep data: their own backups' facts, else the machine they run on.
  const connections = await db
    .select({
      id: catalogConnections.id,
      catalogId: catalogConnections.catalogId,
      label: catalogConnections.label,
      status: catalogConnections.status,
      glance: catalogConnections.glance,
      protection: catalogConnections.protection,
    })
    .from(catalogConnections)
    .where(
      and(eq(catalogConnections.burrowId, burrowId), inArray(catalogConnections.catalogId, [...DATA_KINDS])),
    );
  for (const c of connections) {
    if (c.status !== 'active') continue;
    const at = (c.glance as { machine?: { serverId: string; guestId: string | null; name: string } } | null)
      ?.machine;
    const machine = at ? machines.get(`${at.serverId}\n${at.guestId ?? ''}`) : undefined;
    // A kept fact may be from before the rule that copied needs a backup that worked; the machines' are read now.
    const ownFact = provenProtection(c.protection as StoredProtection | null);
    const best = betterProtection(ownFact, machine ?? null);
    const via = best && best === machine && best !== ownFact ? (at?.name ?? null) : null;
    rows.push({
      key: `connection:${c.id}`.slice(0, 300),
      kind: 'service',
      name: c.label.slice(0, 160),
      catalogId: c.catalogId.slice(0, 80),
      ...(at ? { on: at.name.slice(0, 160) } : {}),
      href: thingHref('connection', c.id).slice(0, 500),
      state: best?.state ?? 'unseen',
      lastAt: best?.lastAt ?? null,
      where: best?.where ?? null,
      ...(best?.failedAt ? { failedAt: best.failedAt } : {}),
      ...(best?.planned ? { planned: true } : {}),
      via: via ? via.slice(0, 160) : null,
    });
  }
  return {
    rows: rows.slice(0, 1000),
    restoreTests: restore.slice(0, 100),
    unread: unread.slice(0, 100),
    at: now.toISOString(),
  };
}

const kept = new WeakMap<Services, Map<string, { at: number; view: Promise<ProtectedView> }>>();

/** The view, kept a minute; `fresh` after a change on the page. */
export function protectedView(services: Services, burrowId: string, fresh = false): Promise<ProtectedView> {
  let byBurrow = kept.get(services);
  if (!byBurrow) {
    byBurrow = new Map();
    kept.set(services, byBurrow);
  }
  const now = Date.now();
  const hit = byBurrow.get(burrowId);
  if (hit && !fresh && now - hit.at < VIEW_MS) return hit.view;
  const view = buildProtectedView(services, burrowId);
  byBurrow.set(burrowId, { at: now, view });
  view.catch(() => {
    if (byBurrow.get(burrowId)?.view === view) byBurrow.delete(burrowId);
  });
  return view;
}

/** Forgets the kept view (a test started, the switch moved). */
export function forgetProtectedView(services: Services): void {
  kept.delete(services);
}
