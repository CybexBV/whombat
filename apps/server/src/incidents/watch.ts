/**
 * The incident watcher: beside the look watcher, about every minute it reads the
 * looks as the desk does (`deskLooks` over Home's things and the servers' cards) for each burrow's person, opens and
 * ends incidents from them (`plan.ts`) and pushes once for what has been down a while. A look's line is one that counts
 * already (watched, not quiet, confirmed): what the person quieted makes no look. A look something else took down with it
 * (`causedBy`) records its cause and never pushes, nor does an incident while its thing is kept quiet or down because of
 * something else. A thing held or not seen keeps its incident open: only seeing it fine again ends it.
 *
 * What it saw on the pass before is kept in memory: after a restart nothing opens or ends until the second pass.
 */
import type { IncidentNature } from '@whombat/core';
import { burrows } from '../db/schema/index';
import type { DeskLook } from '../desk/shapes';
import { startOfLocalDay } from '../home/time';
import { serversPrincipal } from '../hosts/principal';
import { LOOK_RANK, liveRows } from '../looks/research';
import type { Services } from '../services';
import { holdsIncident } from './holds';
import { type LiveLooks, readLiveLooks, seenFine } from './looks';
import {
  type OpenIncident,
  type PassBefore,
  type PushCandidate,
  planIncidents,
  planPush,
  type SeenLook,
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
import { deliverThingWatches, settleSeenBack } from './thing-watch';

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
  const sinceOf = (look: DeskLook): Date | null => {
    const seen = look.server && look.state === 'down' ? fleet?.rows.get(look.server)?.lastSeen : null;
    const r = research.get(look.key);
    const rank = look.state === 'down' ? LOOK_RANK.down : LOOK_RANK.bad;
    const times = [
      ...(seen ? [new Date(seen)] : []),
      ...(r && r.rank <= rank ? [r.since ?? r.startedAt] : []),
    ].filter((d) => !Number.isNaN(d.getTime()));
    return times.length ? new Date(Math.min(...times.map((d) => d.getTime()))) : null;
  };
  const looks = live.looks.map((l) => seenLookOf(l, sinceOf(l))).filter((l): l is SeenLook => l !== null);
  const rows = await openIncidents(services.db, burrowId);
  const open = rows.map(openIncidentOf);
  const plan = planIncidents({
    looks,
    open,
    before,
    serversRead,
    blind: await blindThings(services, burrowId, live, open, looks, now),
    noneYet: !rows.length && !(await anyIncident(services.db, burrowId)),
    now,
  });
  const signer = () => serversPrincipal(services, burrowId);
  if (plan.opened.length || plan.changed.length || plan.ended.length)
    await services.pipeline.commit(
      incidentsPass,
      {
        opened: plan.opened.slice(0, 200).map(({ since: _since, startedAt, ...o }) => ({
          ...o,
          startedAt: startedAt.toISOString(),
        })),
        changed: plan.changed.slice(0, 200),
        ended: plan.ended.slice(0, 200).map((e) => ({ id: e.id, endedAt: e.endedAt.toISOString() })),
      },
      { burrowId, actorId: await signer() },
    );
  await pushDue(services, burrowId, burrow.timeZone, now, signer, new Set(looks.map((l) => l.thing)));
  // “Tell me when Plex is back” while Plex had no outage of its own (it was down because of its server): seeing it
  // answer again is what it waits for.
  await settleSeenBack(services, burrowId, seenFine(live)).catch((err) =>
    services.log.warn(
      { err: String(err), burrowId },
      'incidents: watches waiting for a return could not be read',
    ),
  );
  return plan.seen;
}

/**
 * The open incidents' things that have no look now but that Whombat didn't see fine either: held (kept quiet, or down
 * because of something else) or not seen (a check that couldn't run, a thing not checked yet).
 */
async function blindThings(
  services: Services,
  burrowId: string,
  live: LiveLooks,
  open: readonly OpenIncident[],
  looks: readonly SeenLook[],
  now: Date,
): Promise<Set<string>> {
  const withLook = new Set(looks.map((l) => l.thing));
  // A server is seen through its card (a server not read is the plan's own case), the rest through Home's things.
  const listed = new Map(live.thingList.filter((t) => t.kind !== 'server').map((t) => [t.id, t] as const));
  const blind = new Set<string>();
  for (const inc of open) {
    if (withLook.has(inc.thing)) continue;
    const t = listed.get(inc.thing);
    if (
      (t && (t.status === 'unknown' || t.causedBy || t.quietUntil)) ||
      (await holdsIncident(services.db, burrowId, inc.thing, now))
    )
      blind.add(inc.thing);
  }
  return blind;
}

/**
 * Pushes the incidents that are due now, as one push: only of things still bad on this pass (`bad`), not one seen fine
 * while its incident waits to end, nor one kept quiet or down because of something else.
 */
async function pushDue(
  services: Services,
  burrowId: string,
  timeZone: string,
  now: Date,
  signer: () => Promise<string>,
  bad: ReadonlySet<string>,
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
  }));
  const group = planPush({ open: candidates, pushedToday: pushes.total, pushedTodayOf: pushes.of, now });
  if (!group.length) return;
  // The words are made in the push's own commit, from what is still open and not held then.
  await services.pipeline.commit(
    incidentsPush,
    { ids: group.map((i) => i.id) },
    { burrowId, actorId: await signer() },
  );
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
      const seen = await watchIncidents(this.services, id, this.#before.get(id) ?? null).catch((err) => {
        this.services.log.warn({ err: String(err), burrowId: id }, 'incidents: the pass failed');
        return null;
      });
      // A pass that read nothing forgets: a look must be seen on two passes that read it.
      if (seen) this.#before.set(id, seen);
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
