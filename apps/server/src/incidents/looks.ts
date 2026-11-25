/**
 * What Whombat sees of every thing right now, as the incident watcher reads it: Home's things and the servers' cards
 * for the burrow's person, and the looks the desk makes of them (`deskLooks`). The watcher reads it every minute; an
 * automation that waited reads it again at its deadline, to know whether the thing is still down or the check it
 * waits on still bad.
 *
 * Whether an outage is over is read from the thing itself instead (`observeThings`): a look goes when someone quiets
 * its line, and a line that a hold reset needs two passes to count again, while the thing is still down meanwhile.
 */
import { parseThingId, type ThingSummary } from '@whombat/core';
import { and, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import type { BurrowRow } from '../commit/types';
import { burrows, catalogConnections, deviceSkills, quietWindows, thingCauses } from '../db/schema/index';
import { type DeskFleet, deskFleet, deskLooks, lookLinesOf } from '../desk/glance';
import type { DeskLook } from '../desk/shapes';
import { DEVICE_FRESH_MS } from '../devices/home';
import { thePerson } from '../domain/the-person';
import { type HomeViewer, things } from '../home/overview';
import type { ConnectionGlance } from '../home/types';
import { serverLines } from '../hosts/quiet-lines';
import type { Services } from '../services';
import { thingLines } from '../things/quiet/connection';
import { CAUSE_FRESH_MS } from '../things/quiet/windows';

/** Every look counts here, not only the desk's first ones. */
const LOOKS_MAX = 200;
/** Windows that ended longer ago than this say nothing of a check made now. */
const DAY_MS = 24 * 60 * 60_000;

export interface LiveLooks {
  burrow: BurrowRow;
  thingList: ThingSummary[];
  /** Null when the servers couldn't be read, or the burrow has none. */
  fleet: DeskFleet | null;
  /** The servers' cards were read: a server without a look is fine; else unknown. */
  serversRead: boolean;
  looks: DeskLook[];
}

/** One read of what Whombat sees now; null when Home's things couldn't be read (nothing can be said then). */
export async function readLiveLooks(
  services: Services,
  burrowId: string,
  now: Date,
): Promise<LiveLooks | null> {
  const [burrow] = await services.db.select().from(burrows).where(eq(burrows.id, burrowId));
  const person = await thePerson(services.db, burrowId);
  if (!burrow || !person) return null;
  const viewer: HomeViewer = { burrow, principal: person };
  const thingList = await things(services, viewer, now).catch(() => null);
  if (!thingList) return null;
  let serversRead = true;
  const fleet = await deskFleet(services, burrowId).catch(() => {
    serversRead = false;
    return null;
  });
  return {
    burrow,
    thingList,
    fleet,
    serversRead,
    looks: deskLooks(fleet?.cards ?? [], thingList, LOOKS_MAX),
  };
}

/** A thing's look now, as a delayed start reads it at its deadline. */
export interface LookNow {
  /** `down`: it doesn't answer; `bad`; `look` (amber); null: no look (fine, or only what someone quieted). */
  state: DeskLook['state'] | null;
  /** The checks whose lines count on it now (watched, not quiet, confirmed). */
  checks: Set<string>;
  /** Of those, the ones whose line is bad or says it doesn't answer, with that line's words. */
  bad: Map<string, string>;
}

/** A thing's look now; null when Whombat couldn't read it (a server while the servers weren't read). */
export function lookNow(live: LiveLooks, thing: string): LookNow | null {
  if (thing.startsWith('server:') && !live.serversRead) return null;
  const look = live.looks.find((l) => l.key === thing);
  if (!look) return { state: null, checks: new Set(), bad: new Map() };
  const checks = new Set(
    [look.notice?.check, ...lookLinesOf(look).map((l) => l.check)].filter((c): c is string => !!c),
  );
  const bad = new Map<string, string>();
  for (const l of toneLines(live, look))
    if (l.check && checks.has(l.check) && (l.tone === 'bad' || l.offline) && !bad.has(l.check))
      bad.set(l.check, l.title);
  // The line behind a look that is bad or down is bad, also when its lines weren't kept.
  if (look.state !== 'look' && look.notice?.check && !bad.has(look.notice.check))
    bad.set(look.notice.check, look.reason ?? '');
  return { state: look.state, checks, bad };
}

/** A look's lines with their tone: the server's row or Home's thing behind it. */
function toneLines(
  live: LiveLooks,
  look: DeskLook,
): readonly { check?: string; tone: string; offline?: boolean; title: string }[] {
  if (look.kind === 'server') {
    const row = look.server ? live.fleet?.rows.get(look.server) : undefined;
    return row ? serverLines(row) : [];
  }
  const t = live.thingList.find((x) => x.id === look.key);
  return t ? thingLines(t) : [];
}

/** How a server's or a thing's status reads to someone waiting for it: answering, down, or not known. */
export function observedOf(status: string): 'up' | 'down' | 'unknown' {
  if (status === 'offline') return 'down';
  // A critical line on a thing that answers doesn't make it down: it answers.
  return status === 'ok' || status === 'warn' || status === 'bad' ? 'up' : 'unknown';
}

/**
 * What Whombat saw of a thing itself, whatever is quiet about it: `fine` (it answers and has no bad line), `answering`
 * (it answers, with an error or a bad line), `down` (it doesn't answer), `held` (kept quiet, or down because of
 * something else, now), `unread` (Whombat couldn't read it, or hasn't checked it since a hold ended) or `gone` (it was
 * removed).
 */
export type RawSeen = 'fine' | 'answering' | 'down' | 'held' | 'unread' | 'gone';

/** What `rawSeen` reads beside the live looks. */
export interface RawFacts {
  /** Connections' own rows by thing id: their last check's outcome and lines, as the health pass stored them. */
  connections: ReadonlyMap<string, { status: string; glance: unknown; glanceAt: Date | null }>;
  /** Switched-on devices' last reads by thing id. */
  devices: ReadonlyMap<string, { lastReadAt: Date | null; lastReadError: string | null }>;
  /** Held now: kept quiet, or down because of something else. */
  held: ReadonlySet<string>;
  /** When a hold over each thing last ended: a check made before then says nothing of now. */
  heldUntil: ReadonlyMap<string, Date>;
}

/** What Whombat saw of one thing itself now (`RawSeen`), pure. */
export function rawSeen(live: LiveLooks, thing: string, facts: RawFacts, now: Date): RawSeen {
  const target = parseThingId(thing);
  if (!target) return 'unread';
  if (target.kind === 'server') {
    // A fleet that wasn't read says nothing; one read without the server says it is gone.
    if (!live.serversRead || !live.fleet) return 'unread';
    const row = live.fleet.rows.get(target.id);
    if (!row) return 'gone';
    if (facts.held.has(thing)) return 'held';
    // Offline is offline also while its alert is quiet or held back by its offline parent.
    if (row.status === 'offline') return 'down';
    return row.status === 'pending' ? 'unread' : 'fine';
  }
  const until = facts.heldUntil.get(thing);
  if (target.kind === 'device') {
    const row = facts.devices.get(thing);
    if (!row) return 'gone';
    if (facts.held.has(thing)) return 'held';
    if (row.lastReadError !== null) return 'down';
    if (!row.lastReadAt || (until && row.lastReadAt <= until)) return 'unread';
    return now.getTime() - row.lastReadAt.getTime() > DEVICE_FRESH_MS ? 'unread' : 'fine';
  }
  const row = facts.connections.get(thing);
  if (!row) return 'gone';
  if (facts.held.has(thing)) return 'held';
  // The service refused the credential: it answers.
  if (row.status === 'needs_reauth') return 'answering';
  const glance = row.glance as ConnectionGlance | null;
  if (!glance || !row.glanceAt || (until && row.glanceAt <= until)) return 'unread';
  // `outcome` and the lines are what the check found; the glance's status is what they came to after the quiet rows.
  if (glance.outcome === 'offline') return 'down';
  if (glance.status === 'unknown') return 'unread';
  const lines = glance.lines;
  if (lines?.some((l) => l.offline && l.tone !== 'info')) return 'down';
  if (glance.outcome === 'error' || lines?.some((l) => l.tone === 'bad' && l.nature !== 'fyi'))
    return 'answering';
  // A glance kept before its lines were: its status stands.
  if (!lines) return glance.status === 'offline' ? 'down' : glance.status === 'bad' ? 'answering' : 'fine';
  return 'fine';
}

/** What `observeThings` found: each thing's `RawSeen`, when a hold last ended, and the memory for the next pass. */
export interface Observed {
  raw: Map<string, RawSeen>;
  heldUntil: Map<string, Date>;
  /** The last pass that saw each of these things held. */
  held: Map<string, Date>;
}

/**
 * Reads what Whombat sees of some things themselves now (`rawSeen`): their own rows, their holds (from Home's things,
 * the windows and the causes) and when a hold last ended, from the windows and from `heldBefore`, the last pass that saw
 * each held (a cause leaves no row once it lifts).
 */
export async function observeThings(
  services: Services,
  burrowId: string,
  live: LiveLooks,
  list: readonly string[],
  heldBefore: ReadonlyMap<string, Date>,
  now: Date,
): Promise<Observed> {
  const ids = [...new Set(list)].slice(0, 500);
  const inner = (kind: string) =>
    ids.flatMap((t) => {
      const p = parseThingId(t);
      return p?.kind === kind ? [p.id] : [];
    });
  const connectionIds = inner('connection');
  const deviceIds = inner('device');
  const [connections, devices, windows, causes] = ids.length
    ? await Promise.all([
        connectionIds.length
          ? services.db
              .select({
                id: catalogConnections.id,
                status: catalogConnections.status,
                glance: catalogConnections.glance,
                glanceAt: catalogConnections.glanceAt,
              })
              .from(catalogConnections)
              .where(
                and(eq(catalogConnections.burrowId, burrowId), inArray(catalogConnections.id, connectionIds)),
              )
          : [],
        deviceIds.length
          ? services.db
              .select({
                connectionId: deviceSkills.connectionId,
                lastReadAt: deviceSkills.lastReadAt,
                lastReadError: deviceSkills.lastReadError,
              })
              .from(deviceSkills)
              .where(
                and(
                  eq(deviceSkills.burrowId, burrowId),
                  eq(deviceSkills.status, 'on'),
                  inArray(deviceSkills.connectionId, deviceIds),
                ),
              )
          : [],
        services.db
          .select({
            thing: quietWindows.thingId,
            startsAt: quietWindows.startsAt,
            endsAt: quietWindows.endsAt,
            endedAt: quietWindows.endedAt,
          })
          .from(quietWindows)
          .where(
            and(
              eq(quietWindows.ownerId, burrowId),
              inArray(quietWindows.thingId, ids),
              isNull(quietWindows.guestId),
              lte(quietWindows.startsAt, now),
              gte(quietWindows.endsAt, new Date(now.getTime() - DAY_MS)),
            ),
          ),
        services.db
          .select({ thing: thingCauses.thingId })
          .from(thingCauses)
          .where(
            and(
              eq(thingCauses.ownerId, burrowId),
              inArray(thingCauses.thingId, ids),
              gte(thingCauses.checkedAt, new Date(now.getTime() - CAUSE_FRESH_MS)),
            ),
          ),
      ])
    : [[], [], [], []];
  const held = new Set(causes.map((c) => c.thing));
  const heldUntil = new Map<string, Date>();
  const later = (thing: string, at: Date) => {
    const was = heldUntil.get(thing);
    if (!was || at > was) heldUntil.set(thing, at);
  };
  for (const w of windows) {
    const end = w.endedAt && w.endedAt < w.endsAt ? w.endedAt : w.endsAt;
    if (end > now) held.add(w.thing);
    else later(w.thing, end);
  }
  for (const t of live.thingList)
    if (t.kind !== 'server' && ids.includes(t.id) && (t.causedBy || t.quietUntil)) held.add(t.id);
  const memory = new Map<string, Date>();
  for (const thing of ids) {
    const was = heldBefore.get(thing);
    if (was) later(thing, was);
    if (held.has(thing)) memory.set(thing, now);
    else if (was) memory.set(thing, was);
  }
  const facts: RawFacts = {
    connections: new Map(connections.map((c) => [`connection:${c.id}`, c] as const)),
    devices: new Map(
      devices.flatMap((d) => (d.connectionId ? [[`device:${d.connectionId}`, d] as const] : [])),
    ),
    held,
    heldUntil,
  };
  return {
    raw: new Map(ids.map((t) => [t, rawSeen(live, t, facts, now)] as const)),
    heldUntil,
    held: memory,
  };
}
