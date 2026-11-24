/**
 * Keep quiet for a while (docs/decisions/monitoring.md MON-04, MON-05): `things.keepQuiet` and `things.endQuiet` for a
 * server, connection or device, the assistant's `quiet_until`, Undo, and Whombat keeping a server or one of its
 * machines quiet for its own planned work.
 *
 * A server's window is also a maintenance window in the hosts service (scope server, from now until its end), so the
 * hub's own alerts of it are muted there too; it is made before the commit (and removed again when the commit fails)
 * and removed when the window ends early. Windows that ended by themselves give their maintenance window back on the
 * minute's sweep (`sweepQuietWindows`), which also ends Whombat's own windows 15 minutes after the work.
 */
import {
  type KeepQuietBody,
  type KeepQuietResponse,
  type KeptQuiet,
  type McpToolOutput,
  parseThingId,
  randomIdBody,
  thingId,
} from '@whombat/core';
import { and, eq, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { connectionByHandle } from '../../connections/context';
import type { ConnectionViewer } from '../../connections/store';
import { burrows, quietWindows } from '../../db/schema/index';
import type { QuietWindowRow } from '../../db/schema/quiet-windows';
import { turnPerson } from '../../domain/turn-person';
import { homeAudience, publishHomeChanged } from '../../home/notify';
import type { DirectUndoCtx, DirectUndoResult, RecordedChange } from '../../home/registry';
import { HOSTS_API, seg } from '../../hosts/client';
import { hostsCall } from '../../hosts/errors';
import { serverLabel } from '../../hosts/self';
import { actorOf, hostsFor, WHOMBAT_ACTOR } from '../../hosts/service';
import { ApiError, badRequest, forbidden, notAllowed, notFound } from '../../lib/errors';
import type { ToolContext } from '../../mcp/tools';
import { loadPrincipalRow, type PrincipalRow } from '../../read/principals';
import { outsidersTurn } from '../../runtime/person';
import type { Services } from '../../services';
import type { QuietThing } from './commands';
import { quietTarget } from './service';
import { thingQuiet } from './store';
import { endQuiet, type KeepQuietUndo, keepQuiet } from './window-commands';
import { AFTER_WORK_MS, activeWindow, keptQuiet, WHOMBAT_WORK_NOTE } from './windows';
import { quietNames } from './wire';

/** The longest a thing is kept quiet: a month. */
const KEEP_MAX_MS = 31 * 24 * 3600_000;

/** What the assistant hears when it keeps something quiet without the person having said so in this turn. */
export const QUIET_ASK_FIRST_TEXT =
  'Only the person keeps things quiet. Ask them first; once they say so in this conversation, call quiet_until again.';

const newWindowId = () => `qw_${randomIdBody(12)}`;

/** The thing a window is about, as the commands take it; a server's when the hosts service watches it here. */
async function windowThing(
  services: Services,
  viewer: ConnectionViewer,
  value: string,
  timeZone: string,
): Promise<QuietThing> {
  const parsed = parseThingId(value);
  if (parsed?.kind === 'server') {
    const hosts = hostsFor(services);
    if (!(await hosts.serves(viewer.burrowId).catch(() => false))) throw notFound('Thing');
    return {
      id: thingId('server', parsed.id),
      kind: 'server',
      ref: parsed.id,
      name: serverLabel(parsed.id),
      owner: viewer.burrowId,
    };
  }
  return (await quietTarget(services, viewer, value, timeZone)).thing;
}

/** The hosts service's maintenance window for a server kept quiet until `until`; its id, or null when it refused. */
async function makeMaintenance(
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
async function removeMaintenance(services: Services, maintenanceId: string): Promise<boolean> {
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

/** A window as the page and the answer carry it. */
async function wireWindow(
  services: Services,
  w: QuietWindowRow,
  timeZone: string,
  canEnd: boolean,
): Promise<KeptQuiet> {
  const names = await quietNames(services.db, [w]);
  return keptQuiet(w, { now: services.clock(), timeZone, names, canEnd });
}

/** The window that holds a thing now, if any. */
async function holdingWindow(
  services: Services,
  owner: string,
  thing: string,
): Promise<QuietWindowRow | null> {
  const quiet = await thingQuiet(services.db, owner, thing);
  return activeWindow(quiet.windows, services.clock());
}

/** `things.keepQuiet`: keep a thing quiet until a time or for some minutes, as the person. */
export async function keepThingQuiet(
  services: Services,
  viewer: ConnectionViewer,
  value: string,
  body: KeepQuietBody,
  timeZone: string,
  opts: { agentId?: string } = {},
): Promise<KeepQuietResponse> {
  if (viewer.principal.kind !== 'person') throw notAllowed('Only you can keep things quiet.');
  const thing = await windowThing(services, viewer, value, timeZone);
  const now = services.clock();
  const until = body.until ? new Date(body.until) : new Date(now.getTime() + (body.minutes ?? 60) * 60_000);
  if (until.getTime() <= now.getTime() + 60_000) throw badRequest('Pick a time that is still to come.');
  if (until.getTime() - now.getTime() > KEEP_MAX_MS) throw badRequest('Pick a time within the next month.');
  const note = body.note?.trim() || null;
  const maintenanceId =
    thing.kind === 'server'
      ? await makeMaintenance(services, thing.ref, until, note, viewer.principal)
      : null;
  let replaced: string | null = null;
  try {
    const result = await services.pipeline.commit(
      keepQuiet,
      {
        thing,
        windowId: newWindowId(),
        until: until.toISOString(),
        ...(note ? { note } : {}),
        ...(maintenanceId ? { maintenanceId } : {}),
        ...(opts.agentId ? { agentId: opts.agentId } : {}),
        timeZone,
      },
      { burrowId: viewer.burrowId, actorId: viewer.principal.id },
    );
    if (result.status !== 'ok') throw notAllowed('This can’t be kept quiet now.');
    replaced = result.result.replaced;
  } catch (err) {
    if (maintenanceId) await removeMaintenance(services, maintenanceId);
    throw err;
  }
  if (replaced) await removeMaintenance(services, replaced);
  const w = await holdingWindow(services, thing.owner, thing.id);
  return { keptQuiet: w ? await wireWindow(services, w, timeZone, true) : null };
}

/** `things.endQuiet`: End now, as the person. */
export async function endThingQuiet(
  services: Services,
  viewer: ConnectionViewer,
  value: string,
  timeZone: string,
  opts: { agentId?: string; windowId?: string } = {},
): Promise<KeepQuietResponse> {
  if (viewer.principal.kind !== 'person') throw notAllowed('Only you can end this.');
  const thing = await windowThing(services, viewer, value, timeZone);
  const w = opts.windowId ? { id: opts.windowId } : await holdingWindow(services, thing.owner, thing.id);
  if (!w) throw notFound('Quiet');
  const result = await services.pipeline.commit(
    endQuiet,
    { thing, windowId: w.id, ...(opts.agentId ? { agentId: opts.agentId } : {}) },
    { burrowId: viewer.burrowId, actorId: viewer.principal.id },
  );
  if (result.status !== 'ok') throw notAllowed('This can’t be ended now.');
  if (result.result.maintenanceId && (await removeMaintenance(services, result.result.maintenanceId)))
    await services.db.update(quietWindows).set({ maintenanceId: null }).where(eq(quietWindows.id, w.id));
  return { keptQuiet: null };
}

/** The window a thing is kept quiet by now, as its page carries it; null when none holds. */
export async function keptQuietOf(
  services: Services,
  owner: string,
  thing: string,
  timeZone: string,
  canEnd: boolean,
): Promise<KeptQuiet | null> {
  const w = await holdingWindow(services, owner, thing);
  return w ? wireWindow(services, w, timeZone, canEnd) : null;
}

/* Undo ------------------------------------------------------------------------------------------------------------ */

function isKeepQuietUndo(value: unknown): value is KeepQuietUndo {
  const v = value as KeepQuietUndo | null;
  return !!v && typeof v.thing === 'string' && typeof v.windowId === 'string';
}

function viewerOf(person: PrincipalRow): ConnectionViewer {
  return { accountId: person.accountId ?? '', burrowId: person.burrowId, principal: person };
}

async function timeZoneOf(services: Services, burrowId: string): Promise<string> {
  const [row] = await services.db
    .select({ timeZone: burrows.timeZone })
    .from(burrows)
    .where(eq(burrows.id, burrowId));
  return row?.timeZone ?? 'UTC';
}

/** Undo of keeping a thing quiet: it ends now, as the person who pressed Undo. */
export async function undoKeepQuiet(ctx: DirectUndoCtx, change: RecordedChange): Promise<DirectUndoResult> {
  const undo = change.undo.payload;
  if (!isKeepQuietUndo(undo)) return { ok: false, reason: 'This can’t be undone any more.' };
  const person = await loadPrincipalRow(ctx.services.db, ctx.person.id);
  if (person?.kind !== 'person') return { ok: false, reason: 'Only you can end this.' };
  try {
    await endThingQuiet(
      ctx.services,
      viewerOf(person),
      undo.thing,
      await timeZoneOf(ctx.services, ctx.burrowId),
      { windowId: undo.windowId },
    );
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'not_allowed'))
      return { ok: false, reason: 'It isn’t kept quiet any more.' };
    throw err;
  }
  return { ok: true, state: 'undone' };
}

/* The assistant --------------------------------------------------------------------------------------------------- */

/** A thing's page id from what the assistant gave: a page id as it is, a connection's handle as its page id. */
async function toolThing(ctx: ToolContext, value: string): Promise<string> {
  const given = value.trim();
  if (parseThingId(given)) return given;
  const found = await connectionByHandle(ctx.services.db, ctx.agentId, ctx.dispatch, given);
  if (!found) throw notFound('Thing');
  return thingId('connection', found.row.id);
}

/** `quiet_until`: keep a thing quiet, or end that, on the person's word; without either, how it is kept quiet now. */
export async function quietUntilTool(
  ctx: ToolContext,
  input: { thing: string; until?: string; minutes?: number; note?: string; end?: boolean },
): Promise<McpToolOutput<'quiet_until'>> {
  const { services, burrowId, agentId } = ctx;
  if (outsidersTurn(ctx.dispatch))
    throw forbidden('This work came from outside, so it can’t keep things quiet.');
  const person = await turnPerson(services.db, { burrowId, agentId });
  if (!person) throw notFound('Person');
  const viewer = viewerOf(person);
  const timeZone = await timeZoneOf(services, burrowId);
  const thing = await toolThing(ctx, input.thing);
  const acts = input.end === true || input.until !== undefined || input.minutes !== undefined;
  // Their own message started this turn: their words, or the go-ahead their press of the step posted.
  if (acts && ctx.onBehalfOf.principalId !== person.id) throw forbidden(QUIET_ASK_FIRST_TEXT);
  const answer = (kept: KeptQuiet | null): McpToolOutput<'quiet_until'> => ({
    status: 'ok',
    quiet: kept ? { words: kept.words, until: kept.until } : null,
  });
  if (input.end === true) {
    await endThingQuiet(services, viewer, thing, timeZone, { agentId });
    return answer(null);
  }
  if (input.until !== undefined || input.minutes !== undefined) {
    const kept = await keepThingQuiet(
      services,
      viewer,
      thing,
      {
        ...(input.until !== undefined ? { until: input.until } : { minutes: input.minutes as number }),
        ...(input.note ? { note: input.note } : {}),
      },
      timeZone,
      { agentId },
    );
    return answer(kept.keptQuiet);
  }
  const target = await windowThing(services, viewer, thing, timeZone);
  return answer(await keptQuietOf(services, target.owner, target.id, timeZone, false));
}

/* Whombat's own planned work (MON-05) ----------------------------------------------------------------------------- */

/** How long Whombat's work may take before its window ends by itself, when nothing says it ended. */
export const WORK_MAX_MS = 2 * 3600_000;

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

/** Whombat's work ended at `at`: its window holds 15 minutes more, then ends by itself. Never throws. */
export async function workEnded(services: Services, work: string, at = services.clock()): Promise<void> {
  try {
    const endsAt = new Date(at.getTime() + AFTER_WORK_MS);
    await services.db
      .update(quietWindows)
      .set({ endsAt })
      .where(and(eq(quietWindows.work, work), isNull(quietWindows.endedAt)));
  } catch (err) {
    services.log.warn({ err: err instanceof Error ? err.name : 'error' }, 'quiet window: work end not noted');
  }
}

/** How long a window that ended stays: what a page of history can still say. */
const WINDOWS_KEEP_MS = 90 * 24 * 3600_000;

/**
 * The minute's sweep: windows that are over give their maintenance window back to the hosts service, and windows ended
 * long ago go. Returns how many maintenance windows were removed.
 */
export async function sweepQuietWindows(services: Services, now = services.clock()): Promise<number> {
  const over = await services.db
    .select()
    .from(quietWindows)
    .where(
      and(
        isNotNull(quietWindows.maintenanceId),
        or(isNotNull(quietWindows.endedAt), lte(quietWindows.endsAt, now)),
      ),
    );
  let removed = 0;
  if (over.length && hostsFor(services).present)
    for (const w of over) {
      if (!w.maintenanceId || !(await removeMaintenance(services, w.maintenanceId))) continue;
      await services.db.update(quietWindows).set({ maintenanceId: null }).where(eq(quietWindows.id, w.id));
      removed++;
    }
  await services.db
    .delete(quietWindows)
    .where(
      and(
        lte(quietWindows.endsAt, new Date(now.getTime() - WINDOWS_KEEP_MS)),
        isNull(quietWindows.maintenanceId),
      ),
    );
  return removed;
}
