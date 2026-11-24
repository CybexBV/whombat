/**
 * Keep quiet for a while (docs/decisions/monitoring.md MON-04, MON-05): `things.keepQuiet` and `things.endQuiet` for a
 * server, connection or device, the assistant's `quiet_until`, Undo, and Whombat keeping a server or one of its
 * machines quiet for its own planned work.
 *
 * A server's window is also a maintenance window in the hosts service (scope server, from now until its end), so the
 * hub's own alerts of it are muted there too; it is made before the commit (and removed again when the commit fails)
 * and removed when the window ends early. Windows that ended by themselves give their maintenance window back on the
 * minute's sweep (`window-work.ts`, with Whombat's own planned work). A connection, device or account is found through
 * the pages' part, loaded when asked: the servers' tools reach this file's neighbours without the pages' modules.
 */
import {
  KEEP_QUIET_MIN_MINUTES,
  type KeepQuietBody,
  type KeepQuietResponse,
  type KeptQuiet,
  type McpToolOutput,
  parseThingId,
  thingId,
} from '@whombat/core';
import { eq, inArray } from 'drizzle-orm';
import { connectionByHandle } from '../../connections/context';
import type { ConnectionViewer } from '../../connections/store';
import { burrows, quietWindows } from '../../db/schema/index';
import type { QuietWindowRow } from '../../db/schema/quiet-windows';
import { turnPerson } from '../../domain/turn-person';
import type { DirectUndoCtx, DirectUndoResult, RecordedChange } from '../../home/registry';
import { arr, obj } from '../../hosts/map';
import { serverLabel } from '../../hosts/self';
import { hostsFor } from '../../hosts/service';
import { ApiError, badRequest, forbidden, notAllowed, notFound } from '../../lib/errors';
import type { ToolContext } from '../../mcp/tools';
import { loadPrincipalRow, type PrincipalRow } from '../../read/principals';
import { outsidersTurn } from '../../runtime/person';
import type { Services } from '../../services';
import type { QuietThing } from './commands';
import { thingQuiet } from './store';
import { endQuiet, type KeepQuietUndo, keepQuiet } from './window-commands';
import { makeMaintenance, newWindowId, removeMaintenance } from './window-work';
import { activeWindow, keptQuiet } from './windows';
import { quietNames } from './wire';

/** The longest a thing is kept quiet: a month. */
const KEEP_MAX_MS = 31 * 24 * 3600_000;

/** What the assistant hears when it keeps something quiet without the person having said so in this turn. */
export const QUIET_ASK_FIRST_TEXT =
  'Only the person keeps things quiet. Ask them first; once they say so in this conversation, call quiet_until again.';

/**
 * The thing a window is about, as the commands take it; a server's when the hosts service watches it here. `known`: a
 * server must be one the hosts service lists (keeping quiet); a fleet that can't be read now doesn't stop the person's
 * word, and End now still finds a window of a server that has gone.
 */
async function windowThing(
  services: Services,
  viewer: ConnectionViewer,
  value: string,
  timeZone: string,
  opts: { known?: boolean } = {},
): Promise<QuietThing> {
  const parsed = parseThingId(value);
  if (parsed?.kind === 'server') {
    const hosts = hostsFor(services);
    if (!(await hosts.serves(viewer.burrowId).catch(() => false))) throw notFound('Thing');
    if (opts.known) {
      const fleet = await hosts.fleetRaw().catch(() => null);
      if (fleet && !arr(fleet.servers).some((s) => obj(s).id === parsed.id)) throw notFound('Thing');
    }
    return {
      id: thingId('server', parsed.id),
      kind: 'server',
      ref: parsed.id,
      name: serverLabel(parsed.id),
      owner: viewer.burrowId,
    };
  }
  // Loaded when asked: the pages' part reaches every kind of connection.
  const { quietTarget } = await import('./service');
  return (await quietTarget(services, viewer, value, timeZone)).thing;
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
  const thing = await windowThing(services, viewer, value, timeZone, { known: true });
  const now = services.clock();
  const until = body.until ? new Date(body.until) : new Date(now.getTime() + (body.minutes ?? 60) * 60_000);
  // The same shortest time for a time picked as for a number of minutes.
  if (until.getTime() < now.getTime() + KEEP_QUIET_MIN_MINUTES * 60_000)
    throw badRequest(`Pick a time at least ${KEEP_QUIET_MIN_MINUTES} minutes ahead.`);
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

/**
 * `things.endQuiet`: End now, as the person: every window holding the thing ends (Whombat's for its own work too).
 * `windowId` (Undo of keeping it quiet) ends that one only. The answer is what still holds, if anything.
 */
export async function endThingQuiet(
  services: Services,
  viewer: ConnectionViewer,
  value: string,
  timeZone: string,
  opts: { agentId?: string; windowId?: string } = {},
): Promise<KeepQuietResponse> {
  if (viewer.principal.kind !== 'person') throw notAllowed('Only you can end this.');
  const thing = await windowThing(services, viewer, value, timeZone);
  if (!opts.windowId && !(await holdingWindow(services, thing.owner, thing.id))) throw notFound('Quiet');
  const result = await services.pipeline.commit(
    endQuiet,
    {
      thing,
      ...(opts.windowId ? { windowId: opts.windowId } : {}),
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
    },
    { burrowId: viewer.burrowId, actorId: viewer.principal.id },
  );
  if (result.status !== 'ok') throw notAllowed('This can’t be ended now.');
  // The hub's maintenance windows go back after the commit; a window whose maintenance stays is retried by the sweep.
  const given: string[] = [];
  for (const w of result.result.ended)
    if (w.maintenanceId && (await removeMaintenance(services, w.maintenanceId))) given.push(w.id);
  if (given.length)
    await services.pipeline.transact(viewer.burrowId, async (session) => {
      await session.tx
        .update(quietWindows)
        .set({ maintenanceId: null })
        .where(inArray(quietWindows.id, given));
    });
  const still = await holdingWindow(services, thing.owner, thing.id);
  return { keptQuiet: still ? await wireWindow(services, still, timeZone, true) : null };
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
