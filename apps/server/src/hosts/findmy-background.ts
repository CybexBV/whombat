/**
 * Reading Find My in the background (docs/decisions/findmy-connection.md, findmy-timeline.md): one loop for the box. A
 * Find My connection reads without anyone looking when its Read in the background isn't Off, or when a live automation
 * listens to it or it keeps a timeline (then at least every 15 minutes, `FIND_MY_LISTENED_MS`). Each read is the page's
 * own (`FindMyStore.refresh`): it leaves a Mac someone is using alone, and then tries again after 2 minutes; it puts a
 * locked Mac back. A read that fails waits twice as long each time, up to an hour. While a connection reads, what was
 * read stays in memory; once it stops, the hour after the last look applies. It stops when the connection is removed,
 * its Mac is gone, or it is Off with nothing listening and no timeline. Each pass also deletes the timeline rows past
 * their 30 days, and ends the one-time watches whose day is over or whose Find My went (findmy-watch.md); a connection
 * with a watch reads at least every 5 minutes.
 */
import { FIND_MY_LISTENED_MS, type HostFindMy, type HostFindMyCode } from '@whombat/core';
import { onConnectionLifecycle } from '../connections/lifecycle';
import type { Services } from '../services';
import { findMyFor } from './findmy';
import {
  type FindMyPace,
  findMyConnections,
  findMyPace,
  listenedFindMyConnections,
  macOf,
  macsOf,
} from './findmy-connection';
import { findMyPlacesFor } from './findmy-places';
import { findMyTimelineFor, timelineConnectionIds } from './findmy-timeline';
import { findMyWatcherFor, paceWithWatch, watchedConnections } from './findmy-watch';
import { hostsFor, WHOMBAT_ACTOR } from './service';

/** A Find My connection that reads in the background now. */
export interface FindMyPlan {
  connectionId: string;
  /** The Mac, by its id in the hosts fleet. */
  serverId: string;
  /** What screens call the Mac (“Studio”), for the read's words. */
  label: string;
  pace: FindMyPace;
}

/** How long it waits (ms); tests inject the clock and run passes themselves, nothing sleeps. */
export const FIND_MY_BACKGROUND_TIMING = {
  /** How often the loop looks which connections are due. */
  tickMs: 60_000,
  /** Someone used the Mac: the next try. */
  inUseMs: 2 * 60_000,
  /** The longest wait after reads that failed. */
  maxBackoffMs: 60 * 60_000,
} as const;

export interface FindMyBackgroundDeps {
  now: () => number;
  /** The connections that read in the background now, with their Macs and paces. */
  plans: () => Promise<FindMyPlan[]>;
  /** One read of the plan's Mac, resolved once it ended: why it didn't work, or null. */
  read: (plan: FindMyPlan) => Promise<HostFindMyCode | null>;
  /** The Macs whose reads stay in memory while they are read in the background. */
  hold?: (serverIds: string[]) => void;
  /** Told only a connection and a code, never a place. */
  warn?: (facts: { connectionId: string; code: string }, msg: string) => void;
  timing?: Partial<typeof FIND_MY_BACKGROUND_TIMING>;
}

interface Schedule {
  /** When it reads next (ms). */
  nextAt: number;
  /** When its last read started, or null before the first. */
  lastAt: number | null;
  /** Reads in a row that didn't work (someone using the Mac doesn't count). */
  failures: number;
  everyMs: number;
  reading: boolean;
}

export class FindMyBackground {
  readonly #schedules = new Map<string, Schedule>();
  readonly #running = new Set<Promise<void>>();
  #plans: FindMyPlan[] = [];
  readonly timing: typeof FIND_MY_BACKGROUND_TIMING;

  constructor(private readonly deps: FindMyBackgroundDeps) {
    this.timing = { ...FIND_MY_BACKGROUND_TIMING, ...deps.timing };
  }

  /**
   * One pass: the plans read again, every connection that is due starts its read (each Mac's reads go one after
   * another in the store), and a connection that no longer reads in the background is forgotten. A pass whose plans
   * can't be read keeps the last ones.
   */
  async tick(): Promise<void> {
    this.#plans = await this.deps.plans();
    this.deps.hold?.(this.#plans.map((p) => p.serverId));
    const live = new Set(this.#plans.map((p) => p.connectionId));
    for (const id of [...this.#schedules.keys()]) if (!live.has(id)) this.#schedules.delete(id);
    const now = this.deps.now();
    for (const plan of this.#plans) {
      const everyMs = plan.pace.everyMinutes * 60_000;
      let s = this.#schedules.get(plan.connectionId);
      if (!s) {
        s = { nextAt: now, lastAt: null, failures: 0, everyMs, reading: false };
        this.#schedules.set(plan.connectionId, s);
      } else if (s.everyMs !== everyMs) {
        // Another pace takes effect from the last read, unless reads are failing.
        s.everyMs = everyMs;
        if (s.failures === 0) s.nextAt = (s.lastAt ?? now) + everyMs;
      }
      if (s.reading || now < s.nextAt) continue;
      s.reading = true;
      s.lastAt = now;
      const running: Promise<void> = this.#read(plan, s).finally(() => this.#running.delete(running));
      this.#running.add(running);
    }
  }

  async #read(plan: FindMyPlan, s: Schedule): Promise<void> {
    let code: HostFindMyCode | null;
    try {
      code = await this.deps.read(plan);
    } catch {
      code = 'failed';
    }
    const now = this.deps.now();
    if (code === null) {
      s.failures = 0;
      s.nextAt = (s.lastAt ?? now) + s.everyMs;
    } else if (code === 'in_use') {
      s.nextAt = now + this.timing.inUseMs;
    } else {
      s.failures++;
      s.nextAt = now + Math.min(s.everyMs * 2 ** s.failures, this.timing.maxBackoffMs);
      this.deps.warn?.({ connectionId: plan.connectionId, code }, 'Find My: a background read didn’t work');
    }
    s.reading = false;
  }

  /** Waits until the reads under way ended (tests and shutdown). */
  async settled(): Promise<void> {
    while (this.#running.size) await Promise.allSettled([...this.#running]);
  }

  /** When a connection reads next (ms), or null when it doesn't read in the background (tests, the page's words). */
  nextRead(connectionId: string): number | null {
    return this.#schedules.get(connectionId)?.nextAt ?? null;
  }

  /** How a Mac is read without anyone looking, for `hosts.findMy`; null: only while someone looks. */
  about(serverId: string): NonNullable<HostFindMy['background']> | null {
    const want = serverId.toLowerCase();
    const paces = this.#plans.filter((p) => p.serverId.toLowerCase() === want).map((p) => p.pace);
    const fastest = paces.sort((a, b) => a.everyMinutes - b.everyMinutes)[0];
    return fastest
      ? {
          everyMinutes: fastest.everyMinutes,
          automation: fastest.automation,
          ...(fastest.timeline ? { timeline: true } : {}),
          ...(fastest.watching ? { watching: fastest.watching } : {}),
        }
      : null;
  }
}

/** The hosts service's actor for a read nobody asked for: Whombat itself, at the role a screen step needs. */
const BACKGROUND_ACTOR = { ...WHOMBAT_ACTOR, role: 'admin' as const };

/**
 * The plans from the database and the fleet: every Find My connection whose Mac is one of the servers and runs macOS,
 * and that reads in the background by its own setting, because a live automation listens to it or because it keeps a
 * timeline. Places kept for connections nothing listens to any more go here too, and timeline days past their 30.
 * Throws when the fleet can't be read (the pass keeps its plans).
 */
async function plansOf(services: Services): Promise<FindMyPlan[]> {
  // The timeline's 30 days hold with or without the hosts service, and a failure there doesn't stop the reads.
  await findMyTimelineFor(services)
    .expire(services.clock())
    .catch((err: unknown) =>
      services.log.warn(
        { err: err instanceof Error ? err.name : 'error' },
        'Find My: old timeline days weren’t deleted',
      ),
    );
  const hosts = hostsFor(services);
  if (!hosts.present) {
    await sweepWatches(services);
    return [];
  }
  const rows = await findMyConnections(services.db);
  // Automations the release a box would go back to can't run wait: nothing listens meanwhile, and what they keep stays.
  const ready = await services.newerAutomations.findMyReady();
  const listened = ready ? await listenedFindMyConnections(services.db) : new Map<string, string>();
  if (ready) await findMyPlacesFor(services).clearUnlistened(listened);
  if (!rows.length) {
    await sweepWatches(services);
    return [];
  }
  const timelines = await timelineConnectionIds(services.db);
  const watched = await watchedConnections(services.db);
  let fleet: unknown;
  try {
    fleet = await hosts.fleetRaw();
  } catch (err) {
    // A fleet that can't be read says nothing about Macs: only the watches past their day end.
    await sweepWatches(services);
    throw err;
  }
  const macs = macsOf(fleet);
  const macless = new Set<string>();
  const plans: FindMyPlan[] = [];
  for (const row of rows) {
    const id = macOf(row)?.toLowerCase();
    const mac = id ? macs.find((m) => m.id.toLowerCase() === id) : undefined;
    if (!mac) {
      macless.add(row.id);
      continue;
    }
    const pace = paceWithWatch(
      findMyPace(
        row.fields.background,
        listened.get(row.id) ?? null,
        FIND_MY_LISTENED_MS / 60_000,
        timelines.has(row.id),
      ),
      watched.get(row.id),
    );
    if (pace) plans.push({ connectionId: row.id, serverId: mac.id, label: mac.name, pace });
  }
  await sweepWatches(services, (connectionId) => macless.has(connectionId));
  return plans;
}

/** Ends the one-time watches whose day is over or whose Find My went; a failure there doesn't stop the reads. */
async function sweepWatches(services: Services, macGone?: (connectionId: string) => boolean): Promise<void> {
  await findMyWatcherFor(services)
    .sweep(services.clock(), macGone)
    .catch((err: unknown) =>
      services.log.warn(
        { err: err instanceof Error ? err.name : 'error' },
        'Find My: the watches weren’t checked',
      ),
    );
}

/**
 * One background read of a Mac through the process's Find My store, without counting as a look. One that didn't work
 * (no new read, and why) is noted on the connection's timeline when it keeps one.
 */
async function readOf(services: Services, plan: FindMyPlan): Promise<HostFindMyCode | null> {
  const store = findMyFor(services);
  const before = store.peek(plan.serverId)?.readAt ?? null;
  store.refresh(hostsFor(services), plan.serverId, BACKGROUND_ACTOR, plan.label, { look: false });
  await store.idle(plan.serverId);
  const after = store.peek(plan.serverId);
  const code = after?.problem?.code ?? null;
  if (code !== null && (after?.readAt ?? null) === before)
    await findMyTimelineFor(services).failed(plan.serverId, plan.connectionId, code, services.clock());
  return code;
}

/** The box's background reading: the loop with its start and its nudge. */
export class FindMyBackgroundService extends FindMyBackground {
  #started = false;

  constructor(private readonly services: Services) {
    super({
      now: () => services.clock().getTime(),
      plans: () => plansOf(services),
      read: (plan) => readOf(services, plan),
      hold: (ids) => findMyFor(services).hold(ids),
      warn: (facts, msg) => services.log.warn(facts, msg),
    });
  }

  #pass = () =>
    this.tick().catch((err: unknown) =>
      this.services.log.warn(
        { err: err instanceof Error ? err.name : 'error' },
        'Find My: the background pass failed',
      ),
    );

  /** Starts the loop: a pass every minute and at once, and every read compared for arrivals and leavings. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    const services = this.services;
    findMyFor(services).onRead((serverId, people, at) => {
      void findMyPlacesFor(services).noted(serverId, people, at);
      void findMyTimelineFor(services).noted(serverId, people, at);
      void findMyWatcherFor(services).noted(serverId, people);
    });
    // A Find My connection added, changed or removed is read (or not) from the next pass, which starts now.
    onConnectionLifecycle(services, (event) => {
      if (event.type !== 'tiers') services.background.run('find my connection changed', this.#pass);
    });
    services.housekeeping.add('find my background', this.timing.tickMs, this.#pass, { first: 'tick' });
  }

  /** A pass now (an automation that listens to Find My was published, switched or removed, or a watch started). */
  nudge(): void {
    if (this.#started) this.services.background.run('find my nudge', this.#pass);
  }
}

const instances = new WeakMap<Services, FindMyBackgroundService>();

/** The process's background reading of Find My (one per `Services`). */
export function findMyBackgroundFor(services: Services): FindMyBackgroundService {
  let found = instances.get(services);
  if (!found) {
    found = new FindMyBackgroundService(services);
    instances.set(services, found);
  }
  return found;
}
