/**
 * Home Assistant and UniFi Protect as triggers (docs/decisions/direct-automations.md). Only what live automations name is
 * followed: for each Home Assistant connection one lasting socket subscribed to exactly the entities their `home_state`
 * triggers name (never every entity), and of Protect's event stream (which the box follows anyway) only the connections
 * a `protect` trigger listens to. Each change that matters is signed through the commit pipeline as the burrow's smart
 * home signer (`home.state_changed`, `protect.detected`, no text: they show in no feed), and the trigger scan starts
 * runs on them. Everything stays on the box and needs no internet: Home Assistant and Protect are on the person's
 * network.
 */
import {
  ConnectionId,
  HOME_STATE_CHANGED,
  HomeStateChanged,
  PROTECT_DETECTED,
  ProtectDetected,
  type ProtectEvent,
  protectEventsOf,
} from '@whombat/core';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { onConnectionLifecycle } from '../connections/lifecycle';
import type { CatalogConnectionRow } from '../connections/types';
import type { Db, Tx } from '../db/client';
import { automations, automationVersions, catalogConnections } from '../db/schema/index';
import { burrowSystemPrincipal } from '../domain/system-principals';
import { forbidden } from '../lib/errors';
import { loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { type HaLive, openHomeAssistant } from '../things/kinds/ha-socket';
import type { Detection } from '../things/kinds/home/protect-events';

/** `principals.system` of the smart home signer. */
export const SYSTEM_SMART_HOME = 'smart_home';

/** The burrow's smart home signer: signs what Home Assistant and Protect saw, for the automations that listen. */
export const smartHomePrincipal = burrowSystemPrincipal({
  system: SYSTEM_SMART_HOME,
  name: 'Smart home',
  handle: 'smart-home',
  doing: 'Notices what Home Assistant and UniFi Protect see, for the automations that listen to them.',
  job: 'Notices when something your automations name changes in Home Assistant, or when UniFi Protect rings or sees something, so those automations can start.',
  line: { type: 'home.system_principal', where: 'Smart home' },
});

/* What live automations listen to ----------------------------------------------------------------------------------- */

/** What the live automations listen to. */
export interface Listened {
  /** Home Assistant connections: for each entity a trigger names, the states (lower case) a trigger changes it to. */
  home: Map<string, Map<string, Set<string>>>;
  /** UniFi Protect connections: the events a trigger names. */
  protect: Map<string, Set<ProtectEvent>>;
}

const lower = (s: string) => s.trim().toLowerCase();

/** What a set of live definitions listens to (pure). */
export function listenedOf(definitions: readonly unknown[]): Listened {
  const out: Listened = { home: new Map(), protect: new Map() };
  for (const definition of definitions) {
    const triggers = (definition as { triggers?: unknown } | null)?.triggers;
    if (!Array.isArray(triggers)) continue;
    for (const raw of triggers) {
      const t = raw as Record<string, unknown> | null;
      if (!t || typeof t.connectionId !== 'string') continue;
      if (t.kind === 'home_state' && typeof t.entity === 'string' && typeof t.to === 'string') {
        const entities = out.home.get(t.connectionId) ?? new Map<string, Set<string>>();
        const states = entities.get(t.entity) ?? new Set<string>();
        states.add(lower(t.to));
        entities.set(t.entity, states);
        out.home.set(t.connectionId, entities);
      } else if (t.kind === 'protect' && typeof t.event === 'string') {
        const events = out.protect.get(t.connectionId) ?? new Set<ProtectEvent>();
        events.add(t.event as ProtectEvent);
        out.protect.set(t.connectionId, events);
      }
    }
  }
  return out;
}

/** What the published, switched-on automations listen to now. */
export async function listenedHome(db: Db | Tx): Promise<Listened> {
  const rows = await db
    .select({ definition: automationVersions.definition })
    .from(automations)
    .innerJoin(
      automationVersions,
      and(
        eq(automationVersions.automationId, automations.id),
        eq(automationVersions.n, automations.currentVersion),
      ),
    )
    .where(
      and(
        eq(automations.status, 'published'),
        isNull(automations.deletedAt),
        sql`exists (select 1 from jsonb_array_elements(${automationVersions.definition} -> 'triggers') as t
          where t ->> 'kind' in ('home_state', 'protect'))`,
      ),
    );
  return listenedOf(rows.map((r) => r.definition));
}

/* Home Assistant's entity messages ------------------------------------------------------------------------------------ */

/** One change of state to sign. */
export type HomeChange = Omit<HomeStateChanged, 'connectionId'>;

/** What Whombat last heard of an entity: its state, its friendly name and when Home Assistant says it last changed. */
export interface KnownEntity {
  state: string;
  name: string | null;
  /** Home Assistant's `last_changed` (seconds since 1970); null when it didn't say. */
  changedAt?: number | null;
}

const STATE_MAX = 64;

/** A change Whombat only hears of when it follows again (after Home Assistant was away) starts nothing after this. */
export const HOME_CHANGE_FRESH_MS = 2 * 60_000;

const timeOf = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

/**
 * What one `subscribe_entities` event changes (pure): `known` (each entity's last state, name and time of change) is
 * brought up to date and the changes that matter come back. Home Assistant sends every followed entity once (`a`) when
 * the subscription starts and then only what changed (`c`, the new state under `+.s`, its time under `+.lc`). An entity
 * seen for the first time invents no change; one seen again after a reconnect with another state did change meanwhile,
 * but only a change younger than two minutes by its own `lc` is signed: a door opened while Home Assistant was away for
 * an hour is no news at reconnect. `now` is Home Assistant's own time now (its clock, not the box's, as `lc` is), null
 * when it didn't say: then no change heard only at a reconnect is signed. A change matters when it goes to a state a
 * trigger names, or leaves one (a wait for `forMinutes` ends then). Attributes alone change nothing.
 */
export function homeChangesOf(
  known: Map<string, KnownEntity>,
  watched: ReadonlyMap<string, ReadonlySet<string>>,
  event: unknown,
  now: number | null = Date.now(),
): HomeChange[] {
  const e = (event ?? {}) as Record<string, unknown>;
  const changes: HomeChange[] = [];
  const seen = (entity: string, state: unknown, attributes: unknown, lc: unknown, again: boolean) => {
    const states = watched.get(entity);
    if (!states || typeof state !== 'string' || !state.trim()) return;
    const before = known.get(entity);
    const friendly = (attributes as { friendly_name?: unknown } | null)?.friendly_name;
    const name =
      typeof friendly === 'string' && friendly.trim()
        ? friendly.trim().slice(0, 120)
        : (before?.name ?? null);
    const to = state.trim().slice(0, STATE_MAX);
    const changedAt = timeOf(lc) ?? before?.changedAt ?? null;
    known.set(entity, { state: to, name, changedAt });
    if (!before || lower(before.state) === lower(to)) return;
    if (!states.has(lower(to)) && !states.has(lower(before.state))) return;
    // Heard again after a reconnect: only when Home Assistant says, by its own clock, that it changed just now.
    if (
      again &&
      (now === null || timeOf(lc) === null || now - (timeOf(lc) as number) * 1000 > HOME_CHANGE_FRESH_MS)
    )
      return;
    changes.push({ entity, name, from: before.state, to, ...(changedAt !== null ? { changedAt } : {}) });
  };
  const added = e.a && typeof e.a === 'object' ? (e.a as Record<string, Record<string, unknown> | null>) : {};
  for (const [entity, v] of Object.entries(added)) seen(entity, v?.s, v?.a, v?.lc, true);
  const changed =
    e.c && typeof e.c === 'object' ? (e.c as Record<string, Record<string, unknown> | null>) : {};
  for (const [entity, v] of Object.entries(changed)) {
    const plus = (v?.['+'] ?? null) as Record<string, unknown> | null;
    if (plus && 's' in plus) seen(entity, plus.s, plus.a, plus.lc, false);
    else if (plus?.a) {
      const before = known.get(entity);
      if (before) seen(entity, before.state, plus.a, plus.lc, false);
    }
  }
  return changes;
}

/**
 * The followed entities one `subscribe_entities` event says are gone (pure): those Home Assistant removed (`r`), and,
 * for `full` (the first event after subscribing, which lists every followed entity there is), those it doesn't list.
 * They are forgotten in `known`: one that comes back is a first sight, not a change from before it went.
 */
export function homeGoneOf(
  known: Map<string, KnownEntity>,
  watched: ReadonlyMap<string, unknown>,
  event: unknown,
  full: boolean,
): string[] {
  const e = (event ?? {}) as Record<string, unknown>;
  const gone = new Set<string>();
  if (Array.isArray(e.r)) for (const id of e.r) if (typeof id === 'string' && watched.has(id)) gone.add(id);
  const listed = e.a && typeof e.a === 'object' ? (e.a as Record<string, unknown>) : null;
  if (full && listed) for (const id of watched.keys()) if (!(id in listed)) gone.add(id);
  for (const id of gone) known.delete(id);
  return [...gone];
}

/**
 * Forgets what was heard of entities no longer followed: followed again later, an entity's first state is a first
 * sight, not a change from a state long gone.
 */
export function forgetUnwatched(
  heard: { keys(): Iterable<string>; delete(entity: string): boolean },
  watched: ReadonlyMap<string, unknown>,
): void {
  for (const entity of [...heard.keys()]) if (!watched.has(entity)) heard.delete(entity);
}

/* Signing ------------------------------------------------------------------------------------------------------------ */

async function requireSigner(tx: Tx, actorId: string): Promise<void> {
  const row = await loadPrincipalRow(tx, actorId);
  if (!smartHomePrincipal.is(row)) throw forbidden('Only Whombat’s smart home signer notes these.');
}

/**
 * Signs what a Home Assistant or Protect connection saw: one `home.state_changed` per change, one `protect.detected`
 * per sighting. Nothing for a connection that is gone, or isn't Home Assistant or Protect.
 */
export const noteSmartHome = defineCommand({
  name: 'home.noted',
  schema: z.object({
    connectionId: ConnectionId,
    changes: z
      .array(HomeStateChanged.omit({ connectionId: true }))
      .max(50)
      .default([]),
    detections: z
      .array(ProtectDetected.omit({ connectionId: true }))
      .max(20)
      .default([]),
  }),
  async apply(tx, ctx, input) {
    await requireSigner(tx, ctx.actor.id);
    const [row] = await tx
      .select({ catalogId: catalogConnections.catalogId })
      .from(catalogConnections)
      .where(
        and(eq(catalogConnections.id, input.connectionId), eq(catalogConnections.burrowId, ctx.burrow.id)),
      );
    if (!row) return { signed: 0 };
    let signed = 0;
    if (row.catalogId === 'homeassistant')
      for (const c of input.changes) {
        await ctx.emit({
          type: HOME_STATE_CHANGED,
          kind: 'System',
          text: null,
          where: null,
          payload: HomeStateChanged.parse({ connectionId: input.connectionId, ...c }),
        });
        signed++;
      }
    if (row.catalogId === 'unifi_protect')
      for (const d of input.detections) {
        await ctx.emit({
          type: PROTECT_DETECTED,
          kind: 'System',
          text: null,
          where: null,
          payload: ProtectDetected.parse({ connectionId: input.connectionId, ...d }),
        });
        signed++;
      }
    const services = ctx.services;
    if (signed) ctx.after(async () => services.automations.nudge());
    return { signed };
  },
});

export const SMART_HOME_COMMANDS = [noteSmartHome];

/** An entity's state now, as Home Assistant's socket last said it, and its `last_changed` (null when it didn't say). */
export interface HomeEntityNow {
  state: string;
  changedAt: number | null;
}

/* Following Home Assistant -------------------------------------------------------------------------------------------- */

const OPEN_MS = 15_000;
const PING_EVERY_MS = 60_000;
const BACKOFF_FIRST_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const STEADY_MS = 60_000;
/** A sensor that flaps signs at most this many changes per entity in `FLAP_WINDOW_MS`; the rest only update its state. */
const FLAP_MAX = 20;
const FLAP_WINDOW_MS = 10 * 60_000;

const versionOf = (row: Pick<CatalogConnectionRow, 'credentialVersion' | 'updatedAt'>) =>
  `${row.credentialVersion}:${row.updatedAt.getTime()}`;

/** One Home Assistant connection's lasting socket, subscribed to the entities its automations name. */
class HomeFollower {
  #ha: HaLive | null = null;
  #timer: NodeJS.Timeout | null = null;
  #pinger: NodeJS.Timeout | null = null;
  #backoff: number | null = null;
  #openedAt = 0;
  #closed = false;
  /** Subscribed and given every entity's state once: its states are current. */
  #live = false;
  /** How far Home Assistant's clock is ahead of the box's, as this socket's answer said; null when it didn't. */
  #clockAhead: number | null = null;
  readonly #known = new Map<string, KnownEntity>();
  /** Followed entities Home Assistant removed, or didn't list when the subscription started. */
  readonly #gone = new Set<string>();
  readonly #signedAt = new Map<string, number[]>();
  #watched: Map<string, Set<string>>;
  #key: string;

  constructor(
    private readonly watch: SmartHomeTriggers,
    private readonly services: Services,
    readonly row: CatalogConnectionRow,
    readonly version: string,
    watched: Map<string, Set<string>>,
  ) {
    this.#watched = watched;
    this.#key = [...watched.keys()].sort().join(',');
  }

  start(): void {
    void this.#open();
  }

  /** Follows these entities now: the same ones keep the socket, others subscribe afresh on a new one. */
  follow(watched: Map<string, Set<string>>): void {
    this.#watched = watched;
    forgetUnwatched(this.#known, watched);
    forgetUnwatched(this.#signedAt, watched);
    forgetUnwatched(this.#gone, watched);
    const key = [...watched.keys()].sort().join(',');
    if (key === this.#key) return;
    this.#key = key;
    // Another list of entities subscribes afresh on a new socket, after the shortest wait.
    this.#backoff = null;
    this.#openedAt = 0;
    this.#ha?.close();
  }

  /**
   * The entity's state now and when it changed; `gone` when Home Assistant removed it or doesn't have it; null when
   * Whombat doesn't know it (not connected, or not said).
   */
  current(entity: string): HomeEntityNow | 'gone' | null {
    if (!this.#live) return null;
    if (this.#gone.has(entity)) return 'gone';
    const known = this.#known.get(entity);
    return known ? { state: known.state, changedAt: known.changedAt ?? null } : null;
  }

  close(): void {
    this.#closed = true;
    this.#live = false;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#pinger) clearInterval(this.#pinger);
    this.#timer = null;
    this.#pinger = null;
    this.#ha?.close();
    this.#ha = null;
  }

  async #open(): Promise<void> {
    if (this.#closed) return;
    let ha: HaLive;
    try {
      ha = await openHomeAssistant(this.services, this.row, OPEN_MS);
    } catch {
      this.#again();
      return;
    }
    if (this.#closed) {
      ha.close();
      return;
    }
    this.#ha = ha;
    this.#clockAhead = ha.clockAheadMs ?? null;
    this.#openedAt = Date.now();
    void ha.closed.then(() => {
      if (this.#ha === ha) this.#again();
    });
    const entities = [...this.#watched.keys()];
    const answer = await ha.subscribe(
      'subscribe_entities',
      { entity_ids: entities },
      (event) => this.#event(event),
      OPEN_MS,
    );
    if (!answer.success) {
      ha.close();
      return;
    }
    this.#pinger = setInterval(() => {
      void ha.ping(10_000).then((ok) => {
        if (!ok) ha.close();
      });
    }, PING_EVERY_MS);
    this.#pinger.unref?.();
  }

  #event(event: unknown): void {
    if (this.#closed) return;
    // The first event after subscribing lists every followed entity Home Assistant has.
    const full = !this.#live;
    if (full) this.#gone.clear();
    for (const id of homeGoneOf(this.#known, this.#watched, event, full)) this.#gone.add(id);
    const added = (event as { a?: unknown } | null)?.a;
    if (added && typeof added === 'object') for (const id of Object.keys(added)) this.#gone.delete(id);
    // Home Assistant's own time now, so its `last_changed` is never judged by another clock.
    const haNow = this.#clockAhead === null ? null : this.services.clock().getTime() + this.#clockAhead;
    const changes = homeChangesOf(this.#known, this.#watched, event, haNow);
    this.#live = true;
    const now = Date.now();
    const kept = changes.filter((c) => {
      const recent = (this.#signedAt.get(c.entity) ?? []).filter((t) => now - t < FLAP_WINDOW_MS);
      if (recent.length >= FLAP_MAX) return false;
      recent.push(now);
      this.#signedAt.set(c.entity, recent);
      return true;
    });
    if (kept.length) this.watch.sign(this.row, { changes: kept });
  }

  #again(): void {
    this.#ha = null;
    this.#live = false;
    if (this.#pinger) clearInterval(this.#pinger);
    this.#pinger = null;
    if (this.#closed || this.#timer) return;
    const steady = this.#openedAt && Date.now() - this.#openedAt >= STEADY_MS;
    // A failure waits longer each time, at most five minutes.
    this.#backoff = steady
      ? BACKOFF_FIRST_MS
      : this.#backoff === null
        ? BACKOFF_FIRST_MS
        : Math.min(BACKOFF_MAX_MS, this.#backoff * 2);
    this.#openedAt = 0;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#open();
    }, this.#backoff);
    this.#timer.unref?.();
  }
}

/* The watch --------------------------------------------------------------------------------------------------------- */

/** A Protect sighting older than this when it arrives (a replay after a reconnect) starts nothing. */
const SIGHTING_FRESH_MS = 2 * 60_000;
const SIGHTINGS_REMEMBERED = 500;
const TICK_MS = 30_000;

/**
 * The server's smart home triggers: Home Assistant followers for the entities live automations name (each tick, and
 * when an automation changes), and Protect's sightings signed for the connections they listen to.
 */
export class SmartHomeTriggers {
  readonly #followers = new Map<string, HomeFollower>();
  #listened: Listened = { home: new Map(), protect: new Map() };
  readonly #sighted = new Set<string>();
  readonly #chains = new Map<string, Promise<void>>();
  #stops: (() => void)[] = [];
  #closed = false;
  #ticking: Promise<void> | null = null;

  constructor(private readonly services: Services) {}

  start(): void {
    if (this.#stops.length || this.#closed) return;
    this.#stops.push(
      this.services.housekeeping.add('smart home triggers', TICK_MS, () => this.tick(), { first: 'tick' }),
      onConnectionLifecycle(this.services, (event) => {
        if (event.type === 'tiers') return;
        this.#followers.get(event.connectionId)?.close();
        this.#followers.delete(event.connectionId);
        void this.tick();
      }),
    );
  }

  /** Follows what live automations name now (opens, changes and closes followers). */
  tick(): Promise<void> {
    this.#ticking ??= this.#tick()
      .catch((err: unknown) =>
        this.services.log.warn(
          { err: err instanceof Error ? err.name : 'error' },
          'smart home triggers: a pass failed',
        ),
      )
      .finally(() => {
        this.#ticking = null;
      });
    return this.#ticking;
  }

  async #tick(): Promise<void> {
    const services = this.services;
    if (this.#closed || services.schemaAccess === 'read-only') return;
    // While the release the box would go back to can't run these automations, nothing is followed or signed.
    const ready = await services.newerAutomations.directReady();
    this.#listened = ready ? await listenedHome(services.db) : { home: new Map(), protect: new Map() };
    const ids = [...this.#listened.home.keys()];
    const rows = ids.length
      ? await services.db
          .select()
          .from(catalogConnections)
          .where(
            and(
              inArray(catalogConnections.id, ids),
              eq(catalogConnections.catalogId, 'homeassistant'),
              eq(catalogConnections.status, 'active'),
            ),
          )
      : [];
    const wanted = new Map(rows.map((r) => [r.id, r]));
    for (const [id, f] of this.#followers) {
      const row = wanted.get(id);
      if (!row || f.version !== versionOf(row)) {
        f.close();
        this.#followers.delete(id);
      }
    }
    if (this.#closed) return;
    for (const row of rows) {
      const watched = this.#listened.home.get(row.id) ?? new Map();
      const f = this.#followers.get(row.id);
      if (f) f.follow(watched);
      else {
        const follower = new HomeFollower(this, services, row, versionOf(row), watched);
        this.#followers.set(row.id, follower);
        follower.start();
      }
    }
  }

  /**
   * An entity's state now, for a delayed start at its time: the state and Home Assistant's time of its last change,
   * `gone` when Home Assistant removed it or doesn't have it, or null when Whombat doesn't know it now (Home Assistant
   * can't be reached, or isn't followed).
   */
  current(connectionId: string, entity: string): HomeEntityNow | 'gone' | null {
    return this.#followers.get(connectionId)?.current(entity) ?? null;
  }

  /**
   * A detection from Protect's event stream (`protect-events.ts`): signed once per sighting and event, when it is fresh
   * and a live automation listens to that event on that connection.
   */
  sighted(row: Pick<CatalogConnectionRow, 'id' | 'burrowId'>, d: Detection, cameraName: string | null): void {
    const events = this.#listened.protect.get(row.id);
    if (!events || this.#closed) return;
    if (Math.abs(this.services.clock().getTime() - d.at.getTime()) > SIGHTING_FRESH_MS) return;
    const detections = protectEventsOf(d.kind, d.detected)
      .filter((event) => events.has(event))
      .filter((event) => {
        const key = `${row.id}:${d.eventId}:${event}`;
        if (this.#sighted.has(key)) return false;
        this.#sighted.add(key);
        if (this.#sighted.size > SIGHTINGS_REMEMBERED) {
          const oldest = this.#sighted.values().next().value;
          if (oldest !== undefined) this.#sighted.delete(oldest);
        }
        return true;
      })
      .map((event) => ({ event, camera: d.device, cameraName, detection: d.eventId }));
    if (detections.length) this.sign(row, { detections });
  }

  /** Signs, one at a time per connection so the changes keep their order. Never throws; a failure is logged. */
  sign(
    row: Pick<CatalogConnectionRow, 'id' | 'burrowId'>,
    what: { changes?: HomeChange[]; detections?: Omit<ProtectDetected, 'connectionId'>[] },
  ): Promise<void> {
    const services = this.services;
    const next = (this.#chains.get(row.id) ?? Promise.resolve())
      .then(async () => {
        if (this.#closed || services.maintenance.paused || services.schemaAccess === 'read-only') return;
        const actorId = await smartHomePrincipal.ensure(services, row.burrowId);
        await services.pipeline.commit(
          noteSmartHome,
          {
            connectionId: row.id,
            changes: what.changes ?? [],
            detections: what.detections ?? [],
          },
          { burrowId: row.burrowId, actorId },
        );
      })
      .catch((err: unknown) =>
        services.log.warn(
          { connectionId: row.id, err: err instanceof Error ? err.name : 'error' },
          'smart home triggers: not signed',
        ),
      );
    this.#chains.set(row.id, next);
    void next.finally(() => {
      if (this.#chains.get(row.id) === next) this.#chains.delete(row.id);
    });
    return next;
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const stop of this.#stops) stop();
    this.#stops = [];
    await this.#ticking?.catch(() => undefined);
    for (const f of this.#followers.values()) f.close();
    this.#followers.clear();
    await Promise.all([...this.#chains.values()]);
  }
}

const watches = new WeakMap<Services, SmartHomeTriggers>();

/** The server's smart home triggers (one per services). */
export function smartHomeTriggersFor(services: Services): SmartHomeTriggers {
  let w = watches.get(services);
  if (!w) {
    w = new SmartHomeTriggers(services);
    watches.set(services, w);
  }
  return w;
}
