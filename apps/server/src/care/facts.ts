/**
 * What Whombat knows about a server when it plans its care (docs/decisions/care-plan.md): its kind, its machines and
 * apps, the storages that take backups, and which care automations it has already. Read from the hosts service and the
 * database outside any commit, then given to the command that starts or carries the plan.
 */
import {
  type CareFacts,
  type CareStepId,
  type ChangeWindow,
  careSteps,
  type HostServer,
} from '@whombat/core';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { placeDriver } from '../backup-places/drivers/index';
import { hubBackupPlace, serverAddress } from '../backup-places/hub';
import { serverFacts } from '../backup-places/places';
import type { Db, Tx } from '../db/client';
import {
  automations,
  burrows,
  catalogConnections,
  type LookCareRow,
  type LookPlanStepRow,
  restoreTestServers,
  serverCares,
} from '../db/schema/index';
import { HOSTS_API, seg } from '../hosts/client';
import { arr, guestsOfDetail, obj, str, toHostServerDetail } from '../hosts/map';
import { hostsFor, WHOMBAT_ACTOR } from '../hosts/service';
import { burrowLocale } from '../i18n/locale';
import type { Services } from '../services';
import { changeWindowOf } from './window';

/** The care automations a server has that are still there (not deleted): those steps aren't offered again. */
export async function careAutomationsOf(
  db: Db | Tx,
  burrowId: string,
  serverId: string,
): Promise<Partial<Record<CareStepId, string>>> {
  const [row] = await db
    .select({ automations: serverCares.automations })
    .from(serverCares)
    .where(and(eq(serverCares.burrowId, burrowId), eq(serverCares.serverId, serverId.toLowerCase())));
  const ids = Object.entries(row?.automations ?? {}).filter((e): e is [CareStepId, string] => !!e[1]);
  if (!ids.length) return {};
  const live = new Set(
    (
      await db
        .select({ id: automations.id })
        .from(automations)
        .where(
          and(
            inArray(
              automations.id,
              ids.map(([, id]) => id),
            ),
            isNull(automations.deletedAt),
          ),
        )
    ).map((r) => r.id),
  );
  return Object.fromEntries(ids.filter(([, id]) => live.has(id)));
}

/** A server's facts: its row from the fleet and its page's detail (guests, Proxmox storages). */
export async function careFactsOf(services: Services, burrowId: string, row: HostServer): Promise<CareFacts> {
  const raw = await hostsFor(services).call<unknown>({
    path: `${HOSTS_API}/servers/${seg(row.id)}`,
    actor: WHOMBAT_ACTOR,
  });
  const detail = toHostServerDetail(raw, [], null, services.clock());
  const has: Partial<Record<CareStepId, unknown>> = await careAutomationsOf(services.db, burrowId, row.id);
  // Restore tests are a switch, not an automation.
  const [tests] = await services.db
    .select({ on: restoreTestServers.on })
    .from(restoreTestServers)
    .where(and(eq(restoreTestServers.burrowId, burrowId), eq(restoreTestServers.serverId, row.id)));
  if (tests?.on) has.restore_test = true;
  const known = serverAddress(raw);
  const reported = hubBackupPlace(raw)?.addresses ?? [];
  const addresses = [...new Set([...(known ? [known] : []), ...reported])];
  return {
    server: {
      id: row.id,
      name: row.name,
      platform: row.platform,
      self: row.hostsThisWhombat === true,
      addresses,
    },
    guests: guestsOfDetail(detail),
    backupStorages: backupStoragesOf(raw),
    has: Object.fromEntries(Object.keys(has).map((k) => [k, true])),
    nasShare: row.platform === 'proxmox' ? await nasShareFor(services, burrowId, row.id) : null,
    // A plan is stored as offered: the release before app updates and restore tests can't read those steps.
    ...((await services.newerAutomations.careStepsReady()) ? {} : { olderRelease: true }),
  };
}

/**
 * The backup place a Proxmox server's backups can go to (backup-places.md BPL-12): an Unraid server with Manage on that
 * can share a folder over NFS, the one with most free space; never the server itself. Else a TrueNAS connected with
 * Manage whose apps pool can take it (`connection:<id>`, which `backup_place_nfs` takes as its server).
 */
async function nasShareFor(
  services: Services,
  burrowId: string,
  serverId: string,
): Promise<CareFacts['nasShare']> {
  const servers = await serverFacts(services).catch(() => []);
  const nfs = servers
    .filter((s) => s.id !== serverId && s.manage && s.hub?.supported && s.hub.nfs && !s.self)
    .sort((a, b) => (b.hub?.freeBytes ?? 0) - (a.hub?.freeBytes ?? 0));
  const best = nfs[0];
  if (best) return { serverId: best.id, name: best.name };
  return trueNasShareFor(services, burrowId);
}

/** A TrueNAS connected with Manage that can keep backups now (its driver's say, kept five minutes), most room first. */
async function trueNasShareFor(services: Services, burrowId: string): Promise<CareFacts['nasShare']> {
  const rows = await services.db
    .select({ id: catalogConnections.id, label: catalogConnections.label })
    .from(catalogConnections)
    .where(
      and(
        eq(catalogConnections.burrowId, burrowId),
        eq(catalogConnections.catalogId, 'truenas'),
        eq(catalogConnections.status, 'active'),
        eq(catalogConnections.access, 'manage'),
      ),
    );
  const looked = await Promise.all(
    rows.map(async (r) => {
      const id = `connection:${r.id}`;
      const status = await placeDriver({
        services,
        target: { id, ref: { type: 'connection', id: r.id }, kind: 'truenas', name: r.label },
        actor: WHOMBAT_ACTOR,
      })
        .status?.()
        .catch(() => null);
      return status?.supported ? { serverId: id, name: r.label, free: status.freeBytes ?? 0 } : null;
    }),
  );
  const best = looked.filter((x) => x !== null).sort((a, b) => b.free - a.free)[0];
  return best ? { serverId: best.serverId, name: best.name } : null;
}

/**
 * A Proxmox server's storages that take backups, in its order: their content list says `backup` (the hosts service's
 * `content_types`), or, from a service that sends only its words, the words say backups.
 */
export function backupStoragesOf(raw: unknown): { id: string; type: string }[] {
  return arr(obj(raw).storages).flatMap((x) => {
    const s = obj(x);
    const id = str(s.id);
    if (!id) return [];
    const types = arr(s.content_types).map((t) => String(t));
    const takes = types.length ? types.includes('backup') : /backup/i.test(str(s.content) ?? '');
    return takes ? [{ id, type: str(s.type) ?? '' }] : [];
  });
}

/**
 * The care steps as a research keeps them (`look_researches.care`): Whombat's words, in the person's `locale`, and its
 * automation's recipe.
 */
export function careStepRows(
  facts: CareFacts,
  window: ChangeWindow,
  locale?: string | null,
): LookPlanStepRow[] {
  return careSteps(facts, window, locale).map((s) => ({
    text: s.text,
    step: s.step,
    care: s.id,
    ...(s.automation
      ? {
          automation: {
            kind: s.automation,
            server: { id: facts.server.id, name: facts.server.name, self: facts.server.self },
            ...(s.guests?.length ? { guests: s.guests } : {}),
          },
        }
      : {}),
    ...(s.restoreTests ? { restoreTests: { server: { id: facts.server.id, name: facts.server.name } } } : {}),
  }));
}

/**
 * The care plan a research of a server may propose for its missing backups, snapshots or updates (care-plan.md; an
 * older server's *Ask {assistant} to handle these*): Whombat's defaults for it now, without what it has already. Null
 * when the server can't be read or needs nothing.
 */
export async function careOfferFor(
  services: Services,
  burrowId: string,
  serverId: string,
): Promise<LookCareRow | null> {
  const hosts = hostsFor(services);
  const row = (await hosts.fleet()).servers.find((s) => s.id === serverId);
  if (!row) return null;
  const [burrow] = await services.db
    .select({
      changeWindowStart: burrows.changeWindowStart,
      changeWindowEnd: burrows.changeWindowEnd,
    })
    .from(burrows)
    .where(eq(burrows.id, burrowId));
  const steps = careStepRows(
    await careFactsOf(services, burrowId, row),
    changeWindowOf(burrow),
    await burrowLocale(services, burrowId),
  );
  return steps.length ? { new: false, steps } : null;
}
