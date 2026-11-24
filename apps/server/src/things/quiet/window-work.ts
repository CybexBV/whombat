/**
 * Whombat's own planned work kept quiet (docs/decisions/monitoring.md MON-05), and the hosts service's maintenance
 * windows behind servers kept quiet (MON-04). When Whombat updates or restarts a server or one of its machines, that
 * server or machine is kept quiet for the work and 15 minutes after (“Whombat is updating it”): a restart for about as
 * long as one takes, an update until 15 minutes after its task ends (`workEnded`). The minute's sweep gives back the
 * maintenance windows of windows that are over and forgets windows ended long ago. Kept apart from the person's side
 * (`window-service.ts`) so the servers' tools can use it without the pages' modules.
 */
import { randomIdBody, thingId } from '@whombat/core';
import { and, eq, gt, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { quietWindows } from '../../db/schema/index';
import { homeAudience, publishHomeChanged } from '../../home/notify';
import { HOSTS_API, seg } from '../../hosts/client';
import { hostsCall } from '../../hosts/errors';
import { actorOf, hostsFor, WHOMBAT_ACTOR } from '../../hosts/service';
import { ApiError } from '../../lib/errors';
import type { Services } from '../../services';
import { AFTER_WORK_MS, WHOMBAT_WORK_NOTE } from './windows';

/** A new window's id. */
export const newWindowId = () => `qw_${randomIdBody(12)}`;

/** The hosts service's maintenance window for a server kept quiet until `until`; its id, or null when it refused. */
export async function makeMaintenance(
  services: Services,
  serverId: string,
  until: Date,
  note: string | null,
  actor: { id: string; name: string; shortName?: string | null } | null,
): Promise<string | null> {
  const hosts = hostsFor(services);
  try {
    const raw = await hostsCall(() =>
      hosts.call<{ id?: unknown }>({
        method: 'POST',
        path: `${HOSTS_API}/maintenance`,
        body: {
          scope: 'server',
          target: serverId,
          ends_at: until.toISOString(),
          note: (note ?? 'Kept quiet in Whombat').slice(0, 256),
        },
        actor: actor ? actorOf(actor, 'operator') : { ...WHOMBAT_ACTOR, role: 'operator' },
      }),
    );
    hosts.forget('fleet');
    return typeof raw?.id === 'string' ? raw.id : null;
  } catch (err) {
    // The window still holds in Whombat (its lines are quiet); the hub's alerts just aren't muted at the source.
    services.log.warn(
      { err: err instanceof Error ? err.name : 'error' },
      'quiet window: no maintenance window',
    );
    return null;
  }
}

/** Removes a maintenance window; one already gone counts as removed. */
export async function removeMaintenance(services: Services, maintenanceId: string): Promise<boolean> {
  const hosts = hostsFor(services);
  try {
    await hosts.call({
      method: 'DELETE',
      path: `${HOSTS_API}/maintenance/${seg(maintenanceId)}`,
      actor: { ...WHOMBAT_ACTOR, role: 'operator' },
    });
    hosts.forget('fleet');
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'not_found') return true;
    const status = (err as { status?: unknown }).status;
    if (status === 404) return true;
    services.log.warn(
      { err: err instanceof Error ? err.name : 'error' },
      'quiet window: maintenance not removed',
    );
    return false;
  }
}

/* Whombat's own planned work (MON-05) ----------------------------------------------------------------------------- */

/** How long Whombat's work may take before its window ends by itself, when nothing says it ended. */
export const WORK_MAX_MS = 2 * 3600_000;
/** How long a machine's restart takes, about (nothing tells Whombat when it is back). */
export const RESTART_MS = 5 * 60_000;
/** How long a server's restart takes, about. */
export const SERVER_RESTART_MS = 10 * 60_000;

/** The work of installing updates on a server: its package task. */
export const updateWork = (serverId: string, taskId: string) => `update:${serverId}/${taskId}`;

/**
 * Keeps a server, or one machine of it, quiet for Whombat's own work (an update, a restart): from now until the work
 * ends and 15 minutes after (`workEnded`), at most `expectedMs` and 15 minutes when nothing says. `work` names the work
 * (`care:…`, `update:<task>`, `power:<server>/<guest>`): the same work again moves its end. A server's window is a
 * maintenance window in the hosts service too. Never throws: Whombat's work goes on whatever happens here.
 */
export async function keepQuietForWork(
  services: Services,
  input: {
    burrowId: string;
    serverId: string;
    guestId?: string | null;
    work: string;
    expectedMs?: number;
  },
): Promise<void> {
  try {
    const now = services.clock();
    const endsAt = new Date(
      now.getTime() + Math.min(input.expectedMs ?? WORK_MAX_MS, WORK_MAX_MS) + AFTER_WORK_MS,
    );
    const guestId = input.guestId ?? null;
    const [open] = await services.db
      .select()
      .from(quietWindows)
      .where(and(eq(quietWindows.work, input.work), isNull(quietWindows.endedAt)));
    const maintenanceId =
      !guestId && !open?.maintenanceId
        ? await makeMaintenance(services, input.serverId, endsAt, WHOMBAT_WORK_NOTE, null)
        : (open?.maintenanceId ?? null);
    await services.pipeline.transact(input.burrowId, async (session) => {
      if (open)
        await session.tx
          .update(quietWindows)
          .set({ endsAt, maintenanceId })
          .where(eq(quietWindows.id, open.id));
      else
        await session.tx
          .insert(quietWindows)
          .values({
            id: newWindowId(),
            ownerId: input.burrowId,
            thingId: thingId('server', input.serverId),
            guestId,
            startsAt: now,
            endsAt,
            note: WHOMBAT_WORK_NOTE,
            byId: null,
            work: input.work,
            maintenanceId,
            endedAt: null,
            endedById: null,
            createdAt: now,
          })
          .onConflictDoNothing();
      publishHomeChanged(session, await homeAudience(session, input.burrowId), [
        'things',
        'watch',
        'needsYou',
      ]);
    });
  } catch (err) {
    services.log.warn(
      { err: err instanceof Error ? err.name : 'error' },
      'quiet window: work not kept quiet',
    );
  }
}

/**
 * Whombat's work ended at `at`: its window holds 15 minutes more, then ends by itself. Written as every write is, and
 * Home told, so an open page says the new end. Never throws.
 */
export async function workEnded(services: Services, work: string, at = services.clock()): Promise<void> {
  try {
    const endsAt = new Date(at.getTime() + AFTER_WORK_MS);
    const open = await services.db
      .select({ id: quietWindows.id, ownerId: quietWindows.ownerId })
      .from(quietWindows)
      .where(and(eq(quietWindows.work, work), isNull(quietWindows.endedAt)));
    for (const w of open)
      await services.pipeline.transact(w.ownerId, async (session) => {
        await session.tx
          .update(quietWindows)
          .set({ endsAt })
          .where(and(eq(quietWindows.id, w.id), isNull(quietWindows.endedAt)));
        publishHomeChanged(session, await homeAudience(session, w.ownerId), ['things', 'watch', 'needsYou']);
      });
  } catch (err) {
    services.log.warn({ err: err instanceof Error ? err.name : 'error' }, 'quiet window: work end not noted');
  }
}

/** How long a window that ended stays: what a page of history can still say. */
const WINDOWS_KEEP_MS = 90 * 24 * 3600_000;
/** After a restart, windows that ran out this long before the first sweep are still told of. */
const RAN_OUT_LOOKBACK_MS = 2 * 60_000;
/** When each Whombat's sweep last ran: windows that ran out since are told of once. */
const lastSweep = new WeakMap<Services, Date>();

/**
 * The minute's sweep: windows that are over give their maintenance window back to the hosts service, and windows ended
 * long ago go. Home hears of windows that ran out by themselves since the last sweep, so an open page stops saying
 * “Quiet until …”. Every write goes through the commit pipeline, per burrow. Returns how many maintenance windows were
 * removed.
 */
export async function sweepQuietWindows(services: Services, now = services.clock()): Promise<number> {
  const since = lastSweep.get(services) ?? new Date(now.getTime() - RAN_OUT_LOOKBACK_MS);
  lastSweep.set(services, now);
  const [over, ranOut, old] = await Promise.all([
    services.db
      .select()
      .from(quietWindows)
      .where(
        and(
          isNotNull(quietWindows.maintenanceId),
          or(isNotNull(quietWindows.endedAt), lte(quietWindows.endsAt, now)),
        ),
      ),
    services.db
      .select({ ownerId: quietWindows.ownerId })
      .from(quietWindows)
      .where(
        and(isNull(quietWindows.endedAt), gt(quietWindows.endsAt, since), lte(quietWindows.endsAt, now)),
      ),
    services.db
      .select({ id: quietWindows.id, ownerId: quietWindows.ownerId })
      .from(quietWindows)
      .where(
        and(
          lte(quietWindows.endsAt, new Date(now.getTime() - WINDOWS_KEEP_MS)),
          isNull(quietWindows.maintenanceId),
        ),
      ),
  ]);
  const given: { id: string; ownerId: string }[] = [];
  if (over.length && hostsFor(services).present)
    for (const w of over)
      if (w.maintenanceId && (await removeMaintenance(services, w.maintenanceId))) given.push(w);
  const owners = new Set([...given, ...ranOut, ...old].map((w) => w.ownerId));
  for (const owner of owners)
    await services.pipeline.transact(owner, async (session) => {
      const mineGiven = given.filter((w) => w.ownerId === owner).map((w) => w.id);
      const mineOld = old.filter((w) => w.ownerId === owner).map((w) => w.id);
      if (mineGiven.length)
        await session.tx
          .update(quietWindows)
          .set({ maintenanceId: null })
          .where(inArray(quietWindows.id, mineGiven));
      if (mineOld.length)
        await session.tx
          .delete(quietWindows)
          .where(and(inArray(quietWindows.id, mineOld), isNull(quietWindows.maintenanceId)));
      if (mineGiven.length || ranOut.some((w) => w.ownerId === owner))
        publishHomeChanged(session, await homeAudience(session, owner), ['things', 'watch', 'needsYou']);
    });
  return given.length;
}
