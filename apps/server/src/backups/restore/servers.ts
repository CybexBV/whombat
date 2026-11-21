/**
 * Servers from a backup file (docs/decisions/backup-file.md BF-14, BF-15; BF-S41…BF-S47).
 *
 * - **Where they fit** (the preview and the restore alike): `unavailable` without a hosts service for this burrow,
 *   `here` when its certificate authority is the file's (nothing is imported; the choices per server follow
 *   keep/replace), `blocked` when it watches other servers (or some wait to be let in), else `new`.
 * - **New**: the hosts service takes the file's backup (`POST /hub/restore`) and restarts; the restore waits up to 90 s
 *   for it to answer with the file's authority, makes sure the Servers connection is there, brings the choices per
 *   server back, and — when the file's Whombat was at another address and the person said “Point them here” (the
 *   default) — points every server it can at this Whombat with their Vault SSH keys (`hosts.repoint`). “Leave them”
 *   changes nothing, and the address change isn't put to them again under Needs you.
 * - **Choices per server** (`server_ask`) come back through the restore's batches: a server without a choice here
 *   takes the file's; one with a different choice follows keep/replace.
 */
import {
  type BackupCategoryId,
  type BackupServerAskRecord,
  type BackupServersHubRecord,
  type BackupServersLine,
  type BackupServersPreview,
  type BackupServersSummary,
  type BackupServerToPoint,
  HOST_ASKS_FIRST_DEFAULT,
  type HostAsksFirst,
  HostServerGivenName,
  parseBackupRecord,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { BurrowRow } from '../../commit/types';
import { serverAsks, serverNames } from '../../db/schema/index';
import { ignoreNeedsYou } from '../../home/snoozes';
import { ADDRESS_REF_KIND } from '../../hosts/address';
import { asksKey, loadServerAsks } from '../../hosts/asks-store';
import { addressChangeText, type HubInfo } from '../../hosts/hub';
import { arr, obj } from '../../hosts/map';
import { loadServerNames } from '../../hosts/names-store';
import { ensureServersConnection } from '../../hosts/provision';
import { RepointBusy, type RepointView, repointsFor } from '../../hosts/repoint';
import { noteServerNames } from '../../hosts/self';
import { actorOf, HostsError, hostsFor } from '../../hosts/service';
import type { PrincipalRow } from '../../read/principals';
import type { Services } from '../../services';
import { spooledLines } from '../spool';
import type { ReadUpload } from './read';
import { type CategoryTally, emptyTally, type RecordOutcome, type RestoreRun } from './run';

/** How long the restore waits for the restarted hosts service to answer with the file's authority. */
export const HUB_RESTART_WAIT_MS = 90_000;

/** Tests shorten the waits. */
export const serversTiming = { restartWaitMs: HUB_RESTART_WAIT_MS, pollMs: 1_000 };

/** The servers part of a file, read from its spool. */
export interface FileServers {
  hub: BackupServersHubRecord | null;
  asks: BackupServerAskRecord[];
  /** Lines that didn't parse. */
  unreadable: number;
}

export async function readFileServers(read: ReadUpload): Promise<FileServers> {
  const out: FileServers = { hub: null, asks: [], unreadable: 0 };
  const s = read.spools.get('servers');
  if (!s) return out;
  for await (const line of spooledLines(s.spool)) {
    const parsed = parseBackupRecord('servers', line);
    if (!parsed.ok) {
      out.unreadable++;
      continue;
    }
    const r = parsed.record;
    if (r.type === 'servers_hub') out.hub ??= r;
    else out.asks.push(r);
  }
  return out;
}

/** Where the file's servers stand on this Whombat, and the hub as it answered. */
export interface ServersFit {
  preview: BackupServersPreview;
  hub: HubInfo | null;
}

/** BF-14's states and BF-15's question (reading only). */
export async function serversFit(
  services: Services,
  burrow: Pick<BurrowRow, 'id'>,
  file: BackupServersHubRecord,
): Promise<ServersFit> {
  const count = file.servers.length;
  const none = (state: 'unavailable' | 'blocked', blockedBy: number | null, hub: HubInfo | null) => ({
    preview: { state, count, blockedBy, address: null },
    hub,
  });
  const hosts = hostsFor(services);
  if (!hosts.present || !(await hosts.serves(burrow.id).catch(() => false)))
    return none('unavailable', null, null);
  const hub = await hosts.hub().catch(() => null);
  if (!hub?.caSha256) return none('unavailable', null, hub);
  if (hub.caSha256 === file.caSha256.toLowerCase())
    return { preview: { state: 'here', count, blockedBy: null, address: null }, hub };
  let waiting = 0;
  if (hub.servers === 0) {
    hosts.forget('fleet');
    const fleet = await hosts.fleetRaw().catch(() => ({}) as Record<string, unknown>);
    waiting = Number(obj(fleet).pending_enrollments ?? 0) || 0;
  }
  if (hub.servers > 0 || waiting > 0) return none('blocked', hub.servers || waiting, hub);
  return {
    preview: {
      state: 'new',
      count,
      blockedBy: null,
      address: addressChangeText(file.agentUrl, hub.agentUrl),
    },
    hub,
  };
}

/** What a server's choice here is (no row: Never, the default). */
const askHere = (asks: ReadonlyMap<string, HostAsksFirst>, id: string) =>
  asks.get(asksKey(id)) ?? HOST_ASKS_FIRST_DEFAULT;

/**
 * The servers' counts in the preview: `new` all new; `here` already here, or different where the file's choice for a
 * server differs from this one's; nothing where they can't come back (the state says why).
 */
export async function previewServersTally(
  services: Services,
  burrowId: string,
  fit: BackupServersPreview,
  file: FileServers,
): Promise<CategoryTally> {
  const t = emptyTally();
  if (fit.state === 'new') t.added = fit.count;
  if (fit.state !== 'here' || !file.hub) return t;
  const here = await loadServerAsks(services.db, burrowId);
  const inFile = new Map(file.asks.map((a) => [asksKey(a.server), a.asksFirst] as const));
  for (const s of file.hub.servers) {
    const want = inFile.get(asksKey(s.id));
    if (want && here.has(asksKey(s.id)) && askHere(here, s.id) !== want) t.different++;
    else t.unchanged++;
  }
  return t;
}

/**
 * The names people gave the file's servers come back where a server has none here and no other server here goes by
 * it; a name given here stays.
 */
async function restoreServerNames(run: RestoreRun, hub: BackupServersHubRecord): Promise<void> {
  const here = await loadServerNames(run.tx, run.burrow.id);
  const taken = new Set([...here.values()].map((n) => n.toLowerCase()));
  for (const s of hub.servers) {
    const key = s.id.trim().toLowerCase();
    const name = s.givenName ? HostServerGivenName.safeParse(s.givenName) : null;
    if (!name?.success || here.has(key) || taken.has(name.data.toLowerCase())) continue;
    taken.add(name.data.toLowerCase());
    await run.tx.insert(serverNames).values({
      burrowId: run.burrow.id,
      serverId: key,
      name: name.data,
      changedById: run.restorer.id,
      changedAt: run.services.clock(),
    });
  }
  const { services } = run;
  const burrowId = run.burrow.id;
  run.ctx.after(async () => noteServerNames(await loadServerNames(services.db, burrowId)));
}

/**
 * A `servers.jsonl` line in a restore batch: the `servers_hub` record is the job's (`detail`); a server's choice is
 * added where this Whombat has none for it, follows keep/replace where it differs.
 */
export async function restoreServersLine(run: RestoreRun, record: BackupServersLine): Promise<RecordOutcome> {
  if (record.type === 'servers_hub') {
    if (!run.dry) await restoreServerNames(run, record);
    return 'detail';
  }
  const key = asksKey(record.server);
  const [here] = await run.db
    .select({ asksFirst: serverAsks.asksFirst })
    .from(serverAsks)
    .where(and(eq(serverAsks.burrowId, run.burrow.id), eq(serverAsks.serverId, key)));
  if (here?.asksFirst === record.asksFirst) return 'unchanged';
  const changedById = (await run.resolve(record.changedBy)) ?? run.restorer.id;
  const write = async () => {
    await run.tx
      .insert(serverAsks)
      .values({
        burrowId: run.burrow.id,
        serverId: key,
        asksFirst: record.asksFirst,
        changedById: run.isStandIn(changedById) ? run.restorer.id : changedById,
        changedAt: new Date(record.changedAt),
      })
      .onConflictDoUpdate({
        target: [serverAsks.burrowId, serverAsks.serverId],
        set: { asksFirst: record.asksFirst, changedById: run.restorer.id, changedAt: run.services.clock() },
      });
  };
  if (here) return run.different(write);
  if (run.dry) return 'added';
  await write();
  return 'added';
}

export interface ServersStep {
  services: Services;
  burrow: BurrowRow;
  restorer: PrincipalRow;
  read: ReadUpload;
  /** The answer to the address question (absent: point them here when there is a question). */
  pointHere: boolean | undefined;
  /** Commits a batch of the category's lines through the restore's own command. */
  commitBatch(category: BackupCategoryId, records: unknown[]): Promise<void>;
  log(message: string, extra?: Record<string, unknown>): void;
}

export interface ServersOutcome {
  tally: CategoryTally;
  /** Null when nothing came back (here, blocked, unavailable). */
  summary: BackupServersSummary | null;
}

/** Runs the servers part of a restore (after connections and the Vault, before automations). */
export async function restoreServersStep(step: ServersStep): Promise<ServersOutcome> {
  const { services } = step;
  const file = await readFileServers(step.read);
  const tally = emptyTally();
  if (!file.hub) return { tally, summary: null };
  const n = file.hub.servers.length;
  const fit = await serversFit(services, step.burrow, file.hub);
  // The hub's record brings the servers' names back (it is no count of its own).
  const asksLines = () => [file.hub, ...file.asks] as unknown[];
  if (fit.preview.state === 'here') {
    const before = await loadServerAsks(services.db, step.burrow.id);
    await step.commitBatch('servers', asksLines());
    const after = await loadServerAsks(services.db, step.burrow.id);
    const inFile = new Map(file.asks.map((a) => [asksKey(a.server), a.asksFirst] as const));
    for (const s of file.hub.servers) {
      const want = inFile.get(asksKey(s.id));
      const was = before.has(asksKey(s.id)) ? askHere(before, s.id) : null;
      if (!want || was === null || was === want) tally.unchanged++;
      else if (askHere(after, s.id) === want) {
        tally.updated++;
        tally.different++;
      } else {
        tally.kept++;
        tally.different++;
      }
    }
    return { tally, summary: null };
  }
  if (fit.preview.state !== 'new') {
    tally.skipped = n;
    return { tally, summary: null };
  }
  const backup = step.read.hostsBackup;
  if (!backup?.spool) {
    tally.skipped = n;
    step.log('backup restore: the file’s servers have no hosts service backup');
    return { tally, summary: null };
  }
  const hosts = hostsFor(services);
  const actor = actorOf(step.restorer, 'admin');
  const fileCa = file.hub.caSha256.toLowerCase();
  // The hosts service's clock is this box's: a refusal at its next start is dated after this.
  const askedAt = Date.now() - 1_000;
  try {
    await hosts.restoreHub(backup.spool.read(), backup.size, actor);
  } catch (err) {
    // Another restore or a server added meanwhile (`hub_not_empty`), or a backup it can't take.
    step.log('backup restore: the hosts service didn’t take the servers', {
      code: err instanceof HostsError ? err.code : String(err),
    });
    tally.skipped = n;
    return { tally, summary: null };
  }
  const waited = await hosts.waitForHub(
    (h) => {
      if (h.caSha256 === fileCa) return 'ready';
      // It refused the staged backup at its start (kept what it had): fail fast (hosts HS-170…).
      if (h.restoreError && h.restoreErrorAt && Date.parse(h.restoreErrorAt) >= askedAt) return 'failed';
      return 'wait';
    },
    { deadlineMs: serversTiming.restartWaitMs, pollMs: serversTiming.pollMs },
  );
  if (waited?.outcome !== 'ready') {
    step.log('backup restore: the hosts service didn’t come back with the servers', {
      outcome: waited?.outcome ?? 'timed_out',
    });
    tally.skipped = n;
    return { tally, summary: null };
  }
  const hub = waited.hub;
  // The Servers connection stays the one this Whombat made (ONE-DH15); its tools are there again.
  await ensureServersConnection(services).catch((err: unknown) =>
    step.log('backup restore: the Servers connection wasn’t checked', { err: String(err) }),
  );
  await step.commitBatch('servers', asksLines());
  tally.added = n;

  const summary: BackupServersSummary = { back: n, pointed: 0, toPoint: [] };
  const question = addressChangeText(file.hub.agentUrl, hub.agentUrl);
  if (!question) return { tally, summary };
  if (step.pointHere === false) {
    // “Leave them” (BF-15): nothing changes, and Needs you doesn't ask the restorer again about this change.
    if (hub.agentUrlChangedAt)
      await services.pipeline
        .commit(
          ignoreNeedsYou,
          { ref: { kind: ADDRESS_REF_KIND, id: hub.agentUrlChangedAt }, ignored: true },
          { burrowId: step.burrow.id, actorId: step.restorer.id },
        )
        .catch(() => undefined);
    return { tally, summary };
  }
  const restored = new Set(
    arr((await hosts.fleetRaw().catch(() => ({ servers: [] }))).servers).map((c) => String(obj(c).id)),
  );
  const ids = file.hub.servers.map((s) => s.id).filter((id) => restored.has(id));
  const byId = new Map(file.hub.servers.map((s) => [s.id, s] as const));
  const toPoint = (s: { id: string; name: string; address: string | null }): BackupServerToPoint => ({
    id: s.id,
    name: s.name,
    address: s.address ?? byId.get(s.id)?.address ?? null,
  });
  if (ids.length === 0) return { tally, summary };
  let ended: RepointView | null = null;
  try {
    const started = await repointsFor(services).start({
      burrowId: step.burrow.id,
      personId: step.restorer.id,
      actor,
      servers: ids,
    });
    ended = await repointsFor(services).finished(started.id);
  } catch (err) {
    if (!(err instanceof RepointBusy)) throw err;
  }
  if (!ended) {
    summary.toPoint = ids.map((id) => toPoint(byId.get(id) ?? { id, name: id, address: null }));
    return { tally, summary };
  }
  summary.pointed = ended.servers.filter((s) => s.state === 'pointed').length;
  summary.toPoint = ended.servers.filter((s) => s.state !== 'pointed').map(toPoint);
  return { tally, summary };
}
