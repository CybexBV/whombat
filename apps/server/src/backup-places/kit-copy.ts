/**
 * The locked copy next to the backups (docs/decisions/backup-passkey.md): every backup app Whombat installs has a second
 * user, `kit` (`PLACE_KIT_USER`, password `PLACE_KIT_PASSWORD`, `@whombat/core/backup`), whose own repository path
 * `/kit/` keeps the envelopes of the backup details, one file each. They open only with the person's passkey, and the
 * app only ever adds, so the user's password can be well known: a new Whombat on the same network finds them without
 * any account or server.
 *
 * rest-server 0.14.0's rules, checked against the pinned image in a throwaway container (BPK-S…): a file is uploaded
 * with `POST /kit/keys/<name>` (PUT is 405), the name is 64 lowercase hex characters (anything else 404) and must be the
 * SHA-256 of the body (400 otherwise); the same name again is 403 (append-only); `GET /kit/keys/` lists them (`v2`:
 * `[{name, size}]`); private repositories keep the kit user out of every other path and every other user out of `/kit/`.
 *
 * - **Writing** (`writeKitFiles`): `POST /kit/?create=true`, then each envelope file once (a HEAD first; 403 = there).
 * - **Finding** (`findPlaceKits`): the hosts this network's scan found, the servers and connections Whombat knows, on
 *   the backup apps' ports 8747–8766; each app's list and files, each file checked against its name.
 * - **A place's new address** (`findRepository`): a kit whose address doesn't answer finds its repository by the place's
 *   `config`, which only that app's user can read.
 * - **Places from before the kit user** (`keepPlaceKit`): the app is set up again with it, once a day at most, by the
 *   keep-the-place-right job.
 *
 * Plain http goes only to private IPv4 addresses (BK-29), never with the repository's own password except to check its
 * `config` on such an address.
 */
import { createHash } from 'node:crypto';
import { parseBackupPlaceId } from '@whombat/core';
import {
  PLACE_KIT_PASSWORD,
  PLACE_KIT_RECORD_MAX_BYTES,
  PLACE_KIT_USER,
  PlaceKitRecord,
} from '@whombat/core/backup';
import type { BackupRecoveryMaterial } from '@whombat/protocol/session';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { boxFound, burrowFound, scanAsBox, scanBurrow } from '../connections/discover';
import { foundViewerOf } from '../connections/found-scans';
import { catalogConnections } from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import type { HostsActor } from '../hosts/client';
import { hostsFor, WHOMBAT_ACTOR } from '../hosts/service';
import type { BackupPort } from '../managed/backup';
import { loadBackupKeyState, updateBackupKeyState } from '../managed/backup-key-store';
import type { Services } from '../services';
import { placeDriver } from './drivers';
import { isPrivateIpv4 } from './hub';
import { FIRST_PLACE_PORT } from './nas/compose';
import { serverFacts } from './places';
import { loadPlaceRows } from './store';
import { recoveryMaterial } from './use';

type Material = z.output<typeof BackupRecoveryMaterial>;

/** The ports Whombat's backup apps answer on: the first and the 19 after it. */
export const PLACE_PORTS: readonly number[] = Array.from({ length: 20 }, (_, i) => FIRST_PLACE_PORT + i);
/** How long one app may take to answer a look (a closed port on the home network answers at once). */
const PROBE_MS = 1_500;
const READ_MS = 5_000;
/** Apps looked at once, files read once per app, and the most of each. */
const PROBES_AT_ONCE = 64;
const READS_AT_ONCE = 8;
const HOSTS_MAX = 64;
const FILES_MAX = 200;
const LIST_MAX_BYTES = 512 * 1024;
/** How long a new Whombat waits for its first scan of the network before it looks at what it has. */
export const SCAN_WAIT_MS = 75_000;
/** A place without the kit user is set up again at most this often. */
export const KIT_ENSURE_EVERY_MS = 24 * 60 * 60_000;

/** `fetch` as these calls use it (tests hand in a fake backup app). */
export type KitFetch = (url: string, init: RequestInit) => Promise<Response>;
const defaultFetch: KitFetch = (url, init) => fetch(url, init);

/** How a box reaches the backup apps on its network: `fetch`, and whether it may scan the network for them. */
export interface KitNet {
  fetch: KitFetch;
  scan: boolean;
  /** How long a first scan is waited for (tests make it short). */
  scanWaitMs?: number;
}
const LIVE: KitNet = { fetch: defaultFetch, scan: true };
/** In tests nothing on the network is reached unless the test hands in its own (`useKitNet`). */
const OFFLINE: KitNet = {
  fetch: async () => {
    throw new TypeError('no network in tests');
  },
  scan: false,
};
const nets = new WeakMap<Services, KitNet>();

/** Tests: the network this box's backup apps are on. */
export function useKitNet(services: Services, net: KitNet): void {
  nets.set(services, net);
}

export function kitNetOf(services: Services): KitNet {
  return nets.get(services) ?? (services.config.NODE_ENV === 'test' ? OFFLINE : LIVE);
}
const scanWaitOf = (services: Services) => kitNetOf(services).scanWaitMs ?? SCAN_WAIT_MS;

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
const KIT_AUTH = basic(PLACE_KIT_USER, PLACE_KIT_PASSWORD);
const V2 = 'application/vnd.x.restic.rest.v2';

/** A file's name on a place: the SHA-256 of its bytes, lowercase hex (rest-server checks it). */
export function kitFileName(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** An envelope file's bytes: the record's JSON, members in a fixed order. */
export function kitFileBody(record: PlaceKitRecord): string {
  return JSON.stringify({
    kind: record.kind,
    appliance: record.appliance,
    applianceName: record.applianceName,
    credentialId: record.credentialId,
    salt: record.salt,
    envelope: record.envelope,
    generation: record.generation,
    createdAt: record.createdAt,
  });
}

/** The backup app a repository names, when it is a REST one Whombat may talk plain http to. */
export interface RestTarget {
  /** `http://192.168.1.40:8747` */
  origin: string;
  host: string;
  port: number;
  /** The repository's path, `/client/`. */
  path: string;
}

export function restTarget(repository: string): RestTarget | null {
  if (!repository.startsWith('rest:')) return null;
  let url: URL;
  try {
    url = new URL(repository.slice('rest:'.length));
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === 'http:' && !isPrivateIpv4(url.hostname)) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return { origin: url.origin, host: url.hostname, port, path };
}

async function call(
  fetchFn: KitFetch,
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; timeoutMs: number },
): Promise<Response | null> {
  try {
    return await fetchFn(url, {
      method: init.method,
      headers: init.headers ?? {},
      ...(init.body !== undefined ? { body: init.body } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch {
    return null;
  }
}

/** A response's text up to `max` bytes; null when it is longer or can't be read. */
async function textOf(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  try {
    const text = await res.text();
    return Buffer.byteLength(text, 'utf8') <= max ? text : null;
  } catch {
    return null;
  }
}

export type KitWrite = 'written' | 'no_kit_user' | 'unreachable' | 'refused';

/** Writes the envelope files to a backup app (each once; one that is there already counts as written). */
export async function writeKitFiles(
  origin: string,
  bodies: readonly string[],
  fetchFn: KitFetch = defaultFetch,
): Promise<KitWrite> {
  const auth = { authorization: KIT_AUTH };
  const made = await call(fetchFn, `${origin}/${PLACE_KIT_USER}/?create=true`, {
    method: 'POST',
    headers: auth,
    timeoutMs: READ_MS,
  });
  if (!made) return 'unreachable';
  if (made.status === 401) return 'no_kit_user';
  if (made.status !== 200) return 'refused';
  for (const body of bodies) {
    if (Buffer.byteLength(body, 'utf8') > PLACE_KIT_RECORD_MAX_BYTES) return 'refused';
    const url = `${origin}/${PLACE_KIT_USER}/keys/${kitFileName(body)}`;
    const there = await call(fetchFn, url, { method: 'HEAD', headers: auth, timeoutMs: READ_MS });
    if (there?.status === 200) continue;
    const put = await call(fetchFn, url, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      body,
      timeoutMs: READ_MS,
    });
    if (!put) return 'unreachable';
    if (put.status === 401) return 'no_kit_user';
    // 403: the same file is there already (the app only adds).
    if (put.status !== 200 && put.status !== 403) return 'refused';
  }
  return 'written';
}

/** Whether a backup app has the kit user: true, false (an app from before it), null (it didn't answer). */
export async function hasKitUser(origin: string, fetchFn: KitFetch = defaultFetch): Promise<boolean | null> {
  const res = await call(fetchFn, `${origin}/${PLACE_KIT_USER}/keys/`, {
    method: 'GET',
    headers: { authorization: KIT_AUTH, accept: V2 },
    timeoutMs: PROBE_MS,
  });
  if (!res) return null;
  await res.body?.cancel().catch(() => {});
  // 404: the user is there, its folder not yet (nothing written so far).
  if (res.status === 200 || res.status === 404) return true;
  return res.status === 401 ? false : null;
}

/** The envelope files a backup app keeps (each checked against its name); null when it has none to show. */
export async function readKitFiles(
  origin: string,
  fetchFn: KitFetch = defaultFetch,
): Promise<PlaceKitRecord[] | null> {
  const auth = { authorization: KIT_AUTH };
  const res = await call(fetchFn, `${origin}/${PLACE_KIT_USER}/keys/`, {
    method: 'GET',
    headers: { ...auth, accept: V2 },
    timeoutMs: PROBE_MS,
  });
  if (res?.status !== 200) {
    await res?.body?.cancel().catch(() => {});
    return null;
  }
  const text = await textOf(res, LIST_MAX_BYTES);
  let listed: unknown;
  try {
    listed = text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
  if (!Array.isArray(listed)) return null;
  const names = listed
    .flatMap((e: unknown) => {
      if (typeof e === 'string') return [{ name: e, size: 0 }];
      const o = e as { name?: unknown; size?: unknown } | null;
      return typeof o?.name === 'string' ? [{ name: o.name, size: Number(o.size) || 0 }] : [];
    })
    .filter((e) => /^[0-9a-f]{64}$/.test(e.name) && e.size <= PLACE_KIT_RECORD_MAX_BYTES)
    .slice(0, FILES_MAX);
  const out: PlaceKitRecord[] = [];
  await atMost(READS_AT_ONCE, names, async ({ name }) => {
    const file = await call(fetchFn, `${origin}/${PLACE_KIT_USER}/keys/${name}`, {
      method: 'GET',
      headers: auth,
      timeoutMs: READ_MS,
    });
    if (file?.status !== 200) return;
    const body = await textOf(file, PLACE_KIT_RECORD_MAX_BYTES);
    // A file whose bytes aren't its name was changed on the disk: left out.
    if (!body || kitFileName(body) !== name) return;
    try {
      const parsed = PlaceKitRecord.safeParse(JSON.parse(body));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // not an envelope file
    }
  });
  return out;
}

/** The newest file of each (Whombat, passkey), newest first. */
export function newestKits<T extends PlaceKitRecord>(records: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const r of records) {
    const key = `${r.appliance}|${r.credentialId}`;
    const had = best.get(key);
    if (
      !had ||
      r.generation > had.generation ||
      (r.generation === had.generation && Date.parse(r.createdAt) > Date.parse(had.createdAt))
    )
      best.set(key, r);
  }
  return [...best.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Runs `fn` over `items`, `n` at a time. */
async function atMost<T>(n: number, items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/** The envelope files on the backup apps of `hosts` (ports 8747–8766), with where each was found. */
export async function findKitsOn(
  hosts: readonly string[],
  fetchFn: KitFetch = defaultFetch,
): Promise<{ kits: (PlaceKitRecord & { at: string })[]; places: number }> {
  const targets = hosts.flatMap((host) => PLACE_PORTS.map((port) => ({ host, port })));
  const found: (PlaceKitRecord & { at: string })[] = [];
  let places = 0;
  await atMost(PROBES_AT_ONCE, targets, async ({ host, port }) => {
    const records = await readKitFiles(`http://${host}:${port}`, fetchFn);
    if (!records) return;
    places++;
    for (const r of records) found.push({ ...r, at: `${host}:${port}` });
  });
  return { kits: newestKits(found), places };
}

/**
 * The hosts on this network a backup app may be on (private IPv4 only): the places Whombat set up, the servers the
 * hosts service lists, the connections' hosts and what the network scan found. With `scan`, a Whombat that hasn't
 * scanned yet scans first and waits for it (up to 75 s): as its person when it has one, else as the box itself (right
 * after the claim there is no burrow or person yet, and no scan has run).
 */
export async function kitCandidateHosts(
  services: Services,
  options: { scan?: boolean } = {},
): Promise<string[]> {
  const hosts = new Set<string>();
  const add = (h: string | null | undefined) => {
    if (h && isPrivateIpv4(h)) hosts.add(h);
  };
  for (const r of await loadPlaceRows(services.db).catch(() => [])) add(r.address);
  for (const s of await serverFacts(services).catch(() => [])) {
    add(s.address);
    for (const a of s.hub?.addresses ?? []) add(a);
  }
  const burrowId = await hostsFor(services)
    .homeBurrowId()
    .catch(() => null);
  if (burrowId) {
    const rows = await services.db
      .select({ baseUrl: catalogConnections.baseUrl })
      .from(catalogConnections)
      .where(and(eq(catalogConnections.burrowId, burrowId), eq(catalogConnections.status, 'active')))
      .catch(() => []);
    for (const r of rows) {
      try {
        add(new URL(r.baseUrl).hostname);
      } catch {
        // no host to read
      }
    }
  }
  for (const f of await scannedHosts(services, burrowId, options.scan === true)) add(f.host);
  return [...hosts].slice(0, HOSTS_MAX);
}

/**
 * What this network's scans found: the burrow's last and the box's own; with `scan` and neither, a first scan, waited
 * for up to `SCAN_WAIT_MS` (as the person when there is one, else as the box).
 */
async function scannedHosts(
  services: Services,
  burrowId: string | null,
  scan: boolean,
): Promise<readonly { host: string }[]> {
  const had = [
    ...(burrowId ? (burrowFound(services, burrowId).last?.found ?? []) : []),
    ...(boxFound(services).last?.found ?? []),
  ];
  if (had.length > 0 || !scan || !kitNetOf(services).scan) return had;
  return (await firstScan(services, burrowId)) ?? [];
}

/** A first scan of the network, waited for a while (a new Whombat right after its claim). */
async function firstScan(
  services: Services,
  burrowId: string | null,
): Promise<readonly { host: string }[] | null> {
  const person = burrowId ? await thePerson(services.db, burrowId).catch(() => null) : null;
  const viewer = person ? await foundViewerOf(services.db, person.id).catch(() => null) : null;
  const scan = (viewer ? scanBurrow(services, viewer) : scanAsBox(services))
    .then((s) => s?.found ?? null)
    .catch(() => null);
  const late = new Promise<null>((resolve) => {
    const t = setTimeout(() => resolve(null), scanWaitOf(services));
    t.unref?.();
  });
  const done = await Promise.race([scan, late]);
  if (done) return done;
  // Not finished in time: what it found so far.
  return viewer
    ? (burrowFound(services, viewer.burrowId).running?.found ?? null)
    : (boxFound(services).running?.found ?? null);
}

/** On a new Whombat: the envelope files next to backups on this network, the newest per Whombat and passkey. */
export async function findPlaceKits(
  services: Services,
): Promise<{ kits: (PlaceKitRecord & { at: string })[]; places: number }> {
  return findKitsOn(await kitCandidateHosts(services, { scan: true }), kitNetOf(services).fetch);
}

/** Whether the repository's own backup app is at `origin`: its `config`, which only its user may read. */
async function configAt(
  fetchFn: KitFetch,
  origin: string,
  path: string,
  material: Pick<Material, 'restUser' | 'restPassword'>,
): Promise<boolean | null> {
  const res = await call(fetchFn, `${origin}${path}config`, {
    method: 'HEAD',
    headers: { authorization: basic(material.restUser ?? '', material.restPassword ?? '') },
    timeoutMs: PROBE_MS,
  });
  if (!res) return null;
  return res.status === 200;
}

/**
 * Where a kit's repository is now (a printed kit or an envelope from before the place's address changed): its own
 * address when the repository's `config` answers there; else the first backup app on this network whose same path
 * answers with the kit's REST user and password (only that app has them); null when it is where the kit says, isn't a
 * REST place Whombat set up, or wasn't found. The answer is the repository to use instead.
 */
export async function findRepositoryOn(
  material: Pick<Material, 'repository' | 'restUser' | 'restPassword'>,
  hosts: readonly string[],
  fetchFn: KitFetch = defaultFetch,
): Promise<string | null> {
  const target = restTarget(material.repository);
  if (!target || !material.restUser || !material.restPassword) return null;
  if ((await configAt(fetchFn, target.origin, target.path, material)) === true) return null;
  const candidates = hosts.flatMap((host) =>
    PLACE_PORTS.map((port) => ({ host, port })).filter(
      (c) => c.host !== target.host || c.port !== target.port,
    ),
  );
  let found: string | null = null;
  await atMost(PROBES_AT_ONCE, candidates, async ({ host, port }) => {
    if (found) return;
    if ((await configAt(fetchFn, `http://${host}:${port}`, target.path, material)) === true)
      found ??= `rest:http://${host}:${port}${target.path}`;
  });
  return found;
}

export async function findRepository(
  services: Services,
  material: Pick<Material, 'repository' | 'restUser' | 'restPassword'>,
): Promise<string | null> {
  const fetchFn = kitNetOf(services).fetch;
  const target = restTarget(material.repository);
  if (!target || !material.restUser || !material.restPassword) return null;
  // Where the kit says: no scan of the network.
  if ((await configAt(fetchFn, target.origin, target.path, material)) === true) return null;
  return findRepositoryOn(material, await kitCandidateHosts(services, { scan: true }), fetchFn);
}

export type KeepKitOutcome =
  /** The app in use has the kit user. */
  | 'ok'
  /** It hadn't: it was set up again with it. */
  | 'added'
  /** Nothing Whombat can do: no REST place, one set up by hand, or an older agent that can't add it. */
  | 'none'
  /** Not now: tried within the day, or the app didn't answer. */
  | 'later';

/**
 * Gives the backup app in use the kit user when it doesn't have it (a place set up before there was one): a NAS's app is
 * set up again (its compose has the user now); an Unraid or Linux server's through the hosts service's `ensure`, once
 * its agent says it can (the client's `backup_place.clients[].kit` false; an agent that doesn't say is older). At most
 * once a day per box. It changes the place, so it runs inside the place lock: the keep-the-place-right job's `placeKit`
 * step is its only caller (never call it inside another `oneAtATime`, which would wait for itself).
 */
export async function keepPlaceKit(
  services: Services,
  port: BackupPort,
  appliance: string,
  options: { actor?: HostsActor } = {},
): Promise<KeepKitOutcome> {
  const fetchFn = kitNetOf(services).fetch;
  const material = await recoveryMaterial(port);
  const target = material ? restTarget(material.repository) : null;
  if (!material || !target) return 'none';
  const has = await hasKitUser(target.origin, fetchFn);
  if (has === true) return 'ok';
  if (has === null) return 'later';
  const rows = await loadPlaceRows(services.db);
  const row =
    rows.find((r) => r.address === target.host && r.port === target.port) ??
    rows.find((r) => r.repositoryId === material.repositoryId);
  if (!row || row.byHand || material.restUser !== row.client || !material.restPassword) return 'none';
  const state = await loadBackupKeyState(services.db, appliance);
  const now = services.clock().getTime();
  if (state?.kitEnsuredAt && now - state.kitEnsuredAt.getTime() < KIT_ENSURE_EVERY_MS) return 'later';
  const ref = parseBackupPlaceId(row.id);
  if (!ref || ref.type === 'found') return 'none';
  if (ref.type === 'server') {
    const server = (await serverFacts(services).catch(() => [])).find((s) => s.id === ref.id);
    const kit = server?.hub?.clients.find((c) => c.client === row.client)?.kit ?? null;
    // An agent that doesn't report the kit user can't add it: asked again once it says it can.
    if (kit !== false) return kit === true ? 'ok' : 'none';
  }
  await updateBackupKeyState(services, appliance, { kitEnsuredAt: services.clock() });
  const driver = placeDriver({
    services,
    target: { id: row.id, ref, kind: row.kind, name: row.name },
    actor: options.actor ?? WHOMBAT_ACTOR,
  });
  // No location: where the backups are now (a NAS given another would start a new repository there).
  await driver.ensure(row.client, material.restPassword);
  services.log.info({ place: row.id }, 'backup passkey: the backup app was given the kit user');
  return 'added';
}
