/**
 * Arriving and leaving on Find My (docs/decisions/findmy-connection.md): after every read of a Mac (its page's, the
 * background's, the assistant's) each person's place is compared with the last one kept. Only while a live automation
 * listens to a Find My connection does that connection keep each person's last place (Find My's words and since when,
 * never a street, coordinates or a history) and sign one `findmy.place_changed` per change, through the commit pipeline
 * as the burrow's Find My signer. Without an automation nothing is kept and nothing is signed: the event log never
 * becomes a history of where people were.
 */
import {
  ConnectionId,
  FIND_MY_PLACE_CHANGED,
  FIND_MY_PLACE_MAX,
  FindMyPersonId,
  FindMyPlaceChanged,
  findMyPlaceKey,
  HOST_FIND_MY_PEOPLE_MAX,
} from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { findMyPlaces } from '../db/schema/index';
import { burrowSystemPrincipal } from '../domain/system-principals';
import { forbidden } from '../lib/errors';
import { loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { findMyConnectionRow, findMyConnections, listenedFindMyConnections } from './findmy-connection';

/** `principals.system` of the Find My signer. */
export const SYSTEM_FINDMY = 'findmy';

/**
 * The burrow's Find My signer: keeps the places, signs each change of place an automation listens for, and writes the
 * timeline's rows without an event (`findmy-timeline.ts`).
 */
export const findMyPrincipal = burrowSystemPrincipal({
  system: SYSTEM_FINDMY,
  name: 'Find My',
  handle: 'findmy',
  doing:
    'Notices when people arrive or leave, for the automations that listen to Find My, and keeps the timeline you turned on.',
  job: 'Notices when someone arrives somewhere or leaves, as Find My on your Mac shows it, for your automations, and keeps the Find My timeline you turned on.',
  line: { type: 'findmy.system_principal', where: 'Find My' },
});

/** A person's last known place on a connection. */
export interface KeptPlace {
  person: string;
  name: string;
  place: string;
  since: Date;
}

/** A person as a read gives them (`HostFindMyPerson`), without what isn't compared. */
export interface ReadPerson {
  id: string;
  name: string;
  place: string | null;
}

/** One person's change of place: Find My's words before and now. */
export interface PlaceChange {
  person: string;
  name: string;
  from: string | null;
  to: string;
}

const words = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * How a read changes what is kept (pure): someone without a place keeps their last known one (no change); someone with
 * nothing kept yet gets their place kept without a change (a first read invents no arrival); a place that differs
 * (without case or spaces) is a change and is kept. `keep` holds only the rows to write.
 */
export function placeChanges(
  kept: readonly KeptPlace[],
  people: readonly ReadPerson[],
  at: Date,
): { changes: PlaceChange[]; keep: KeptPlace[] } {
  const byPerson = new Map(kept.map((k) => [k.person, k]));
  const changes: PlaceChange[] = [];
  const keep: KeptPlace[] = [];
  const seen = new Set<string>();
  for (const p of people) {
    if (seen.has(p.id) || !FindMyPersonId.safeParse(p.id).success) continue;
    seen.add(p.id);
    const place = p.place ? words(p.place, FIND_MY_PLACE_MAX) : '';
    if (!place) continue;
    const name = words(p.name, 200) || p.id;
    const before = byPerson.get(p.id);
    if (before && findMyPlaceKey(before.place) === findMyPlaceKey(place)) continue;
    keep.push({ person: p.id, name, place, since: at });
    if (before) changes.push({ person: p.id, name, from: before.place, to: place });
  }
  return { changes, keep };
}

/** Find My's own names for places where the person is “at” (Home, Work), else “in” a town. */
const AT_PLACES: ReadonlySet<string> = new Set(['home', 'work', 'school', 'gym']);
const where = (place: string) => (AT_PLACES.has(findMyPlaceKey(place)) ? `at ${place}` : `in ${place}`);

/** “Mara Visser is now at Home”: a run's trigger in its run history. */
export function placeChangeSummary(change: Pick<PlaceChange, 'name' | 'to'>): string {
  return `${change.name} is now ${where(change.to)}`;
}

/** “Mara Visser is now at Home (was in Lelystad).”: a run's `trigger.text`. */
export function placeChangeText(change: Pick<PlaceChange, 'name' | 'from' | 'to'>): string {
  const now = placeChangeSummary(change);
  return change.from ? `${now} (was ${where(change.from)}).` : `${now}.`;
}

/** A run's scope for a change of place: `trigger.text`, `trigger.person` (the name), `trigger.place`, `trigger.from`. */
export function placeChangeScope(change: FindMyPlaceChanged & { to: string }) {
  return {
    kind: 'findmy',
    connectionId: change.connectionId,
    personId: change.person,
    person: change.name,
    place: change.to,
    from: change.from,
    text: placeChangeText(change),
  };
}

/** The places a connection keeps. */
export async function keptPlaces(db: Db | Tx, connectionId: string): Promise<KeptPlace[]> {
  return db
    .select({
      person: findMyPlaces.person,
      name: findMyPlaces.name,
      place: findMyPlaces.place,
      since: findMyPlaces.since,
    })
    .from(findMyPlaces)
    .where(eq(findMyPlaces.connectionId, connectionId));
}

async function requireSigner(tx: Tx, actorId: string): Promise<void> {
  const row = await loadPrincipalRow(tx, actorId);
  if (!findMyPrincipal.is(row)) throw forbidden('Only Whombat’s Find My keeps where people are.');
}

const KeptPlaceInput = z.object({
  person: FindMyPersonId,
  name: z.string().min(1).max(200),
  place: z.string().min(1).max(FIND_MY_PLACE_MAX),
  since: z.string().datetime(),
});

const ChangeInput = z.object({
  person: FindMyPersonId,
  name: z.string().min(1).max(200),
  from: z.string().min(1).max(FIND_MY_PLACE_MAX).nullable(),
  to: z.string().min(1).max(FIND_MY_PLACE_MAX),
});

/**
 * Keeps the places a read changed on a listened Find My connection and signs one `findmy.place_changed` per change
 * (no text: it shows in no feed; the payload has the names and place words only). Nothing is written for a connection
 * that is gone.
 */
export const noteFindMyPlaces = defineCommand({
  name: 'findmy.places_noted',
  schema: z.object({
    connectionId: ConnectionId,
    keep: z.array(KeptPlaceInput).max(HOST_FIND_MY_PEOPLE_MAX),
    changes: z.array(ChangeInput).max(HOST_FIND_MY_PEOPLE_MAX),
  }),
  async apply(tx, ctx, input) {
    await requireSigner(tx, ctx.actor.id);
    if (!(await findMyConnectionRow(tx, ctx.burrow.id, input.connectionId))) return { changed: 0 };
    for (const k of input.keep) {
      const row = { name: k.name, place: k.place, since: new Date(k.since), updatedAt: ctx.now };
      await tx
        .insert(findMyPlaces)
        .values({ connectionId: input.connectionId, person: k.person, burrowId: ctx.burrow.id, ...row })
        .onConflictDoUpdate({ target: [findMyPlaces.connectionId, findMyPlaces.person], set: row });
    }
    for (const c of input.changes)
      await ctx.emit({
        type: FIND_MY_PLACE_CHANGED,
        kind: 'System',
        text: null,
        where: null,
        payload: FindMyPlaceChanged.parse({ connectionId: input.connectionId, ...c }),
      });
    const services = ctx.services;
    if (input.changes.length) ctx.after(async () => services.automations.nudge());
    return { changed: input.changes.length };
  },
});

/** Forgets the places of connections no automation listens to any more. */
export const clearFindMyPlaces = defineCommand({
  name: 'findmy.places_cleared',
  schema: z.object({ connectionIds: z.array(ConnectionId).min(1).max(500) }),
  async apply(tx, ctx, input) {
    await requireSigner(tx, ctx.actor.id);
    const gone = await tx
      .delete(findMyPlaces)
      .where(
        and(
          eq(findMyPlaces.burrowId, ctx.burrow.id),
          inArray(findMyPlaces.connectionId, input.connectionIds),
        ),
      )
      .returning({ person: findMyPlaces.person });
    return { cleared: gone.length };
  },
});

export const FIND_MY_COMMANDS = [noteFindMyPlaces, clearFindMyPlaces];

/**
 * Notes a read of a Mac for every Find My connection on it that an automation listens to (one at a time per Mac, so
 * two reads close together are compared in order). Never throws: a read that can't be compared is said in the log,
 * with the connection only.
 */
export class FindMyPlacesWatch {
  readonly #chains = new Map<string, Promise<void>>();

  constructor(private readonly services: Services) {}

  noted(serverId: string, people: readonly ReadPerson[], at: Date): Promise<void> {
    const key = serverId.toLowerCase();
    const next = (this.#chains.get(key) ?? Promise.resolve())
      .then(() => this.#note(serverId, people, at))
      .catch((err: unknown) =>
        this.services.log.warn(
          { server: serverId, err: err instanceof Error ? err.name : 'error' },
          'Find My: a read wasn’t compared',
        ),
      );
    this.#chains.set(key, next);
    void next.finally(() => {
      if (this.#chains.get(key) === next) this.#chains.delete(key);
    });
    return next;
  }

  async #note(serverId: string, people: readonly ReadPerson[], at: Date): Promise<void> {
    const services = this.services;
    if (services.schemaAccess === 'read-only') return;
    const connections = await findMyConnections(services.db, { mac: serverId });
    if (!connections.length) return;
    // Automations the release a box would go back to can't run wait, and keep nothing meanwhile.
    if (!(await services.newerAutomations.findMyReady())) return;
    const listened = await listenedFindMyConnections(services.db);
    for (const c of connections) {
      if (!listened.has(c.id)) continue;
      const { changes, keep } = placeChanges(await keptPlaces(services.db, c.id), people, at);
      if (!keep.length) continue;
      const actorId = await findMyPrincipal.ensure(services, c.burrowId);
      await services.pipeline.commit(
        noteFindMyPlaces,
        {
          connectionId: c.id,
          keep: keep.map((k) => ({ ...k, since: k.since.toISOString() })),
          changes,
        },
        { burrowId: c.burrowId, actorId },
      );
    }
  }

  /** Forgets the kept places of connections that no live automation listens to (each pass of the background). */
  async clearUnlistened(listened: ReadonlyMap<string, unknown>): Promise<number> {
    const services = this.services;
    if (services.schemaAccess === 'read-only') return 0;
    const rows = await services.db
      .selectDistinct({ connectionId: findMyPlaces.connectionId, burrowId: findMyPlaces.burrowId })
      .from(findMyPlaces);
    const byBurrow = new Map<string, string[]>();
    for (const r of rows)
      if (!listened.has(r.connectionId))
        byBurrow.set(r.burrowId, [...(byBurrow.get(r.burrowId) ?? []), r.connectionId]);
    let cleared = 0;
    for (const [burrowId, connectionIds] of byBurrow) {
      const actorId = await findMyPrincipal.ensure(services, burrowId);
      const res = await services.pipeline.commit(clearFindMyPlaces, { connectionIds }, { burrowId, actorId });
      if (res.status === 'ok') cleared += res.result.cleared;
    }
    return cleared;
  }
}

const watches = new WeakMap<Services, FindMyPlacesWatch>();

/** The process's watch of Find My places (one per `Services`). */
export function findMyPlacesFor(services: Services): FindMyPlacesWatch {
  let w = watches.get(services);
  if (!w) {
    w = new FindMyPlacesWatch(services);
    watches.set(services, w);
  }
  return w;
}
