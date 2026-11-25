/**
 * The incident watcher: beside the look watcher, about every minute it reads the
 * looks as the desk does (`deskLooks` over Home's things and the servers' cards) for each burrow's person, opens and
 * ends incidents from them (`plan.ts`) and pushes once for what has been down a while. A look's line is one that counts
 * already (watched, not quiet, confirmed): what the person quieted makes no look. A look something else took down with it
 * (`causedBy`) records its cause and never pushes, nor does an incident while its thing is kept quiet or down because of
 * something else. Whether an outage is over is read from the thing itself (`observeThings`), not from its dot: a server
 * as the hosts service lists it (online, no critical alert open whoever ignored it), a connection's or device's own last
 * check made after any hold over it ended (one that didn't read the incident's check says nothing), the person's
 * accounts from their own records. Quieting a line, a hold, or a pass that couldn't read the thing never says it is
 * back; a thing that was removed ends its incident as removed.
 *
 * What it saw on the pass before is kept in memory: after a restart nothing opens or ends until the second pass. A
 * pass that can't read Home keeps only what it knew of the open incidents, as a pass that couldn't read their things;
 * right after a restart it starts that memory from the open incidents themselves.
 */
import { type IncidentNature, thingId } from '@whombat/core';
import { and, eq, isNotNull } from 'drizzle-orm';
import { burrows, catalogConnections } from '../db/schema/index';
import type { DeskLook } from '../desk/shapes';
import { startOfLocalDay } from '../home/time';
import { serversPrincipal } from '../hosts/principal';
import { LOOK_RANK, liveRows } from '../looks/research';
import type { Services } from '../services';
import { holdsIncident } from './holds';
import { lookNow, observeThings, type RawSeen, readLiveLooks } from './looks';
import {
  blindPass,
  type OpenIncident,
  type PassBefore,
  PUSH_MAX,
  type PushCandidate,
  planIncidents,
  planPush,
  type SeenLook,
  type ThingSeen,
} from './plan';
import {
  anyIncident,
  findingsPushedSince,
  incidentsPass,
  incidentsPush,
  openIncidentOf,
  openIncidents,
  pruneIncidents,
  pushesSince,
} from './store';
import { deliverThingWatches, settleRemoved, settleSeenBack, watchedThings } from './thing-watch';

/** How often the watcher looks: as the look watcher. */
export const INCIDENTS_WATCH_MS = 60_000;
/** How often incidents older than 90 days are removed. */
const PRUNE_EVERY_MS = 60 * 60_000;

/** The words an incident gets when its look says no more than its state. */
const PLAIN_WORDS: Record<IncidentNature, string> = { down: 'Not answering', problem: 'Has a problem' };

/**
 * A desk look as an incident weighs it: down when it doesn't answer, a problem when its dot is bad; none for one only to
 * look at (amber never opens an incident). `since`: when Whombat knows it went wrong earlier.
 */
export function seenLookOf(look: DeskLook, since: Date | null): SeenLook | null {
  if (look.state === 'look') return null;
  const nature: IncidentNature = look.state === 'down' ? 'down' : 'problem';
  return {
    thing: look.key,
    kind: look.kind,
    name: look.name,
    nature,
    words: look.reason ?? PLAIN_WORDS[nature],
    check: look.notice?.check ?? null,
    subject: look.notice?.subject ?? '',
    cause: look.causedBy ? { thing: look.causedBy.thing, name: look.causedBy.name } : null,
    since,
  };
}

/** Reads one burrow's looks and acts on its pass; returns what it saw, or null when it couldn't read them. */
export async function watchIncidents(
  services: Services,
  burrowId: string,
  before: PassBefore | null,
): Promise<PassBefore | null> {
  const now = services.clock();
  // A pass that can't read Home says nothing: nothing opens, nothing ends.
  const live = await readLiveLooks(services, burrowId, now);
  if (!live) return null;
  const { burrow, fleet, serversRead } = live;
  // The assistant's research of a look as bad or worse began when the trouble did, or later.
  const research = new Map((await liveRows(services.db, burrowId)).map((r) => [r.lookKey, r] as const));
  // A Website or address check pointed at another target: what was known before says nothing of the new one.
  const changed = new Map(
    (
      await services.db
        .select({ id: catalogConnections.id, at: catalogConnections.hubCheckChangedAt })
        .from(catalogConnections)
        .where(
          and(eq(catalogConnections.burrowId, burrowId), isNotNull(catalogConnections.hubCheckChangedAt)),
        )
    ).map((c) => [thingId('connection', c.id), c.at?.getTime() ?? 0] as const),
  );
  const sinceOf = (look: DeskLook): Date | null => {
    const seen = look.server && look.state === 'down' ? fleet?.rows.get(look.server)?.lastSeen : null;
    const r = research.get(look.key);
    const rank = look.state === 'down' ? LOOK_RANK.down : LOOK_RANK.bad;
    const from = changed.get(look.key) ?? Number.NEGATIVE_INFINITY;
    const times = [
      ...(seen ? [new Date(seen)] : []),
      ...(r && r.rank <= rank ? [r.since ?? r.startedAt] : []),
    ].filter((d) => !Number.isNaN(d.getTime()) && d.getTime() >= from);
    return times.length ? new Date(Math.min(...times.map((d) => d.getTime()))) : null;
  };
  const looks = live.looks
    .map((l) => seenLookOf(l, sinceOf(l)))
    .filter((l): l is SeenLook => l !== null)
    .map((l) => ({
      ...l,
      problems: [...(lookNow(live, l.thing)?.bad ?? [])].map(([check, words]) => ({
        check: check.slice(0, 80),
        words: words.slice(0, 200),
      })),
    }));
  const rows = await openIncidents(services.db, burrowId);
  const open = rows.map(openIncidentOf);
  // What Whombat sees of the things themselves: the open incidents' (are they over?), the looks' (did a hold over them
  // end?), the pass before's (could this pass read one whose look went?) and those running watches wait on.
  const watches = await watchedThings(services.db, burrowId, now);
  const observed = await observeThings(
    services,
    burrowId,
    live,
    [
      ...open.map((o) => o.thing),
      ...looks.map((l) => l.thing),
      ...(before?.things ?? []),
      ...watches.map((w) => w.thing),
    ],
    before?.held ?? new Map(),
    now,
    new Map(open.map((o) => [o.thing, o.checks ?? []] as const)),
  );
  const withLook = new Set(looks.map((l) => l.thing));
  // Whether each thing answers now, before anything quieted it: a down incident's down time ends when it does.
  const answersNow = new Map<string, boolean>();
  for (const [thing, r] of observed.raw)
    if (r === 'fine' || r === 'answering' || r === 'down') answersNow.set(thing, r !== 'down');
  const seen = new Map<string, ThingSeen>();
  for (const inc of open)
    if (!withLook.has(inc.thing))
      seen.set(
        inc.thing,
        seenOf(
          observed.raw.get(inc.thing) ?? 'unread',
          (inc.checks ?? []).some((c) => observed.unread.get(inc.thing)?.has(c)),
        ),
      );
  // A thing whose look went because this pass couldn't read it keeps its run of looks.
  for (const thing of before?.things ?? []) {
    const raw = observed.raw.get(thing);
    if (raw && !withLook.has(thing) && !seen.has(thing)) seen.set(thing, seenOf(raw, false));
  }
  const plan = planIncidents({
    looks,
    open,
    before,
    serversRead,
    seen,
    answering: answersNow,
    noneYet: !rows.length && !(await anyIncident(services.db, burrowId)),
    now,
  });
  const signer = () => serversPrincipal(services, burrowId);
  const stillOpen = new Map(plan.seen.open);
  if (
    plan.opened.length ||
    plan.changed.length ||
    plan.noted.length ||
    plan.stretched.length ||
    plan.ended.length
  ) {
    const done = await services.pipeline.commit(
      incidentsPass,
      {
        opened: plan.opened.slice(0, 200).map(({ since: _since, startedAt, downSince, ...o }) => ({
          ...o,
          problems: o.problems?.slice(0, 30),
          startedAt: startedAt.toISOString(),
          ...(downSince ? { downSince: downSince.toISOString() } : {}),
        })),
        changed: plan.changed.slice(0, 200),
        noted: plan.noted.slice(0, 200),
        stretched: plan.stretched.slice(0, 200).map((s) => ({ ...s, at: s.at.toISOString() })),
        ended: plan.ended.slice(0, 200).map((e) => ({
          id: e.id,
          endedAt: e.endedAt.toISOString(),
          ...(e.removed ? { removed: true } : {}),
        })),
      },
      { burrowId, actorId: await signer() },
    );
    // Opened on this pass, open after it: an edit that ends one before the next pass ends its run of looks too.
    if (done.status === 'ok') for (const o of done.result.opened) stillOpen.set(o.id, o.thing);
  }
  // The push's clock starts again after a hold over a thing, or after passes that couldn't read it.
  const pushClock = new Map(observed.heldUntil);
  for (const [thing, at] of plan.seen.unread ?? []) {
    const was = pushClock.get(thing);
    if (!was || at > was) pushClock.set(thing, at);
  }
  await pushDue(
    services,
    burrowId,
    burrow.timeZone,
    now,
    signer,
    new Map(looks.map((l) => [l.thing, l] as const)),
    pushClock,
  ).catch((err) =>
    services.log.warn({ err: String(err), burrowId }, 'incidents: the push could not be saved'),
  );
  // “Tell me when Plex is back” while Plex had no outage of its own (it was down because of its server): seeing it
  // answer again is what it waits for. A watch on something removed stops and says so.
  const raw = observed.raw;
  const answering = new Set([...raw].filter(([, r]) => r === 'fine' || r === 'answering').map(([t]) => t));
  const gone = new Set([...raw].filter(([, r]) => r === 'gone').map(([t]) => t));
  await settleSeenBack(services, burrowId, answering).catch((err) =>
    services.log.warn(
      { err: String(err), burrowId },
      'incidents: watches waiting for a return could not be read',
    ),
  );
  await settleRemoved(services, burrowId, gone).catch((err) =>
    services.log.warn(
      { err: String(err), burrowId },
      'incidents: watches of removed things could not be read',
    ),
  );
  return { ...plan.seen, open: stillOpen, held: observed.held };
}

/**
 * What a thing's own state says of its open incident: only seeing it fine counts towards its end. `unreadCheck`: its
 * last check didn't read a check the incident is about (it answered, its details couldn't be read), so fine says
 * nothing of that.
 */
export function seenOf(raw: RawSeen, unreadCheck: boolean): ThingSeen {
  if (raw === 'fine') return unreadCheck ? 'unread' : 'fine';
  if (raw === 'unread' || raw === 'gone') return raw;
  return 'bad';
}

/**
 * Pushes the incidents that are due now, as one push: only of things still bad on this pass (`bad`, their looks), not
 * one seen fine while its incident waits to end, nor one kept quiet or down because of something else. Its words say
 * what each look says now.
 */
async function pushDue(
  services: Services,
  burrowId: string,
  timeZone: string,
  now: Date,
  signer: () => Promise<string>,
  bad: ReadonlyMap<string, SeenLook>,
  heldUntil: ReadonlyMap<string, Date>,
): Promise<void> {
  const open = (await openIncidents(services.db, burrowId)).map(openIncidentOf);
  const waiting: OpenIncident[] = [];
  for (const i of open)
    if (
      !i.pushedAt &&
      !i.cause &&
      bad.has(i.thing) &&
      !(await holdsIncident(services.db, burrowId, i.thing, now))
    )
      waiting.push(i);
  if (!waiting.length) return;
  const oldest = new Date(Math.min(...waiting.map((i) => i.startedAt.getTime())));
  const [findings, pushes] = await Promise.all([
    findingsPushedSince(services.db, burrowId, oldest),
    pushesSince(services.db, burrowId, startOfLocalDay(now, timeZone)),
  ]);
  const candidates: PushCandidate[] = waiting.map((i) => ({
    ...i,
    findingPushed: (findings.get(i.thing) ?? 0) >= i.startedAt.getTime(),
    // A hold over it, or a stretch Whombat couldn't read it, that ended after it started: the push waits and stays
    // fresh from then.
    heldUntil: heldUntil.get(i.thing) ?? null,
  }));
  const group = planPush({ open: candidates, pushedToday: pushes.total, pushedTodayOf: pushes.of, now });
  if (!group.length) return;
  // The words are made in the push's own commit, from what is still open and not held then.
  const ids = group.slice(0, PUSH_MAX);
  await services.pipeline.commit(
    incidentsPush,
    {
      ids: ids.map((i) => i.id),
      now: ids.flatMap((i) => {
        const look = bad.get(i.thing);
        return look ? [{ id: i.id, nature: look.nature, words: look.words.slice(0, 200) }] : [];
      }),
    },
    { burrowId, actorId: await signer() },
  );
}

/**
 * What the watcher remembers of a pass: what it saw, or after one that read nothing, only what it knew of the open
 * incidents, with the pass as one that couldn't read them (`blindPass`), so the push's clock starts again once Whombat
 * can. Right after a restart that is the open incidents as read now: Home's reads failing for an hour must not leave
 * the outage stale once they work again. Null forgets.
 */
export async function passMemory(
  services: Services,
  burrowId: string,
  before: PassBefore | null,
  seen: PassBefore | null,
): Promise<PassBefore | null> {
  if (seen) return seen;
  const rows = await openIncidents(services.db, burrowId).catch(() => null);
  // Not even the open incidents could be read: the last known ones are still open, and as unread as the rest.
  const open = rows ? new Map(rows.map((r) => [r.id, r.thingId] as const)) : (before?.open ?? new Map());
  return blindPass(before, open, services.clock());
}

/** The watcher's memory: what each burrow's pass before saw. */
export class IncidentWatcher {
  readonly #before = new Map<string, PassBefore>();
  #prunedAt = 0;

  constructor(private readonly services: Services) {}

  /** One pass over every burrow with a person. */
  async pass(): Promise<void> {
    const rows = await this.services.db.select({ id: burrows.id }).from(burrows);
    for (const { id } of rows) {
      await deliverThingWatches(this.services, id).catch((err) =>
        this.services.log.warn({ err, burrowId: id }, 'Thing watches could not be read'),
      );
      const before = this.#before.get(id) ?? null;
      const seen = await watchIncidents(this.services, id, before).catch((err) => {
        this.services.log.warn({ err: String(err), burrowId: id }, 'incidents: the pass failed');
        return null;
      });
      const kept = await passMemory(this.services, id, before, seen);
      if (kept) this.#before.set(id, kept);
      else this.#before.delete(id);
    }
    const now = this.services.clock();
    if (now.getTime() - this.#prunedAt >= PRUNE_EVERY_MS) {
      this.#prunedAt = now.getTime();
      await this.services.pipeline
        .transactAccount((tx) => pruneIncidents(tx, now))
        .catch((err) => this.services.log.warn({ err: String(err) }, 'incidents: pruning failed'));
    }
  }
}
