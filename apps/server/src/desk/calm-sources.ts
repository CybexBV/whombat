/**
 * Where the calm glance's facts come from besides Home (docs/decisions/desk-display.md DK-115…DK-118;
 * desk-display-server.md DK-S140…DK-S147): what's going on in a connection (Plex's viewers, the download queue, new
 * requests), what's coming up, each server's last hour, a filling disk's forecast, a down server's guests, and Whombat
 * updating itself. `glance.ts`/`calm.ts` read through `DeskCalmSources`, so tests give their own.
 *
 * The screen asks for a glance every few seconds, so nothing here may slow it: the hosts service's reads are kept (a
 * server's last hour a minute, its disk's forecast ten minutes, a down server's guests a minute) and read again in the
 * background; a glance waits for a read at most `waitMs` and goes on with what it had.
 */

import type { UpdateFacts } from '@whombat/control-contracts/local';
import { type DeskCalmActivity, type DeskCalmComing, type DeskUpdateState, thingId } from '@whombat/core';
import { and, asc, eq, gt, isNull, lte } from 'drizzle-orm';
import { liveDefinition } from '../automations/store';
import { automations, catalogConnections } from '../db/schema/index';
import { homeShowsConnection } from '../home/overview';
import type { ConnectionGlance } from '../home/types';
import { HOSTS_API, seg } from '../hosts/client';
import { toHostGuest, toHostSeries, toHostServerDetail } from '../hosts/map';
import { type HostsService, hostsFor, WHOMBAT_ACTOR } from '../hosts/service';
import type { Services } from '../services';
import { kindOf } from '../things/kinds/index';
import { forecastFull, type RawPoint, trendOf } from '../things/series';
import { DESK_HOSTS_WAIT_MS, within } from './glance';
import { downsample } from './server-page';

/** The person and their burrow, as the desk reads Home for them. */
export interface DeskCalmViewer {
  burrowId: string;
  personId: string;
  timeZone: string;
}

export interface DeskCalmSources {
  /**
   * The connections and devices the person sees with something to show now (`ConnectionGlance.activity`), keyed
   * `connection:<id>` / `device:<id>` as Home's things; `active` when something is going on.
   */
  activities(viewer: DeskCalmViewer, now: Date): Promise<DeskCalmActivity[]>;
  /** What a kind shows as its activity, for Settings' list (“Who’s watching”); null when it shows none. */
  activityLine(catalogId: string): string | null;
  /** The automations' next runs within `withinS`, soonest first. */
  coming(viewer: DeskCalmViewer, now: Date, withinS: number): Promise<DeskCalmComing[]>;
  /** Each server's processor over the last hour, whole percent, oldest first, at most 30 points. */
  sparks(burrowId: string, ids: readonly string[], now: Date): Promise<Map<string, number[]>>;
  /** Days until a server's disk is full at its rate over the last week; null when not filling or unknown. */
  diskDays(burrowId: string, id: string, now: Date): Promise<number | null>;
  /** A server's running guests' names (its VMs and containers). */
  runsOn(burrowId: string, id: string): Promise<string[]>;
  /** Whombat installing or restarting into a release now, else null. */
  update(): Promise<(typeof DeskUpdateState)['options'][number] | null>;
}

/** What the sources read besides `Services`. */
export interface DeskCalmSourceOptions {
  /**
   * The manager's update facts as it last pushed them (the managed runtime's `dispatcher.facts.update`); without it (a
   * box without a manager) Whombat never says it's updating.
   */
  updateFacts?: () => Pick<UpdateFacts, 'state'> | null | undefined;
  /** How long a glance waits for a read that isn't kept yet before going on without it. */
  waitMs?: number;
  /** The hosts service (tests give their own); the process's otherwise. */
  hosts?: Pick<HostsService, 'serves' | 'call' | 'guestsRaw'>;
}

/** A glance waits this long at most for a read that isn't kept (the read itself goes on for the next glance). */
export const DESK_SOURCE_WAIT_MS = 1_500;
/** How long each read is kept. */
export const SPARK_KEEP_MS = 60_000;
export const DISK_KEEP_MS = 10 * 60_000;
export const GUESTS_KEEP_MS = 60_000;
/** The last hour as the sparkline draws it. */
export const SPARK_POINTS = 30;
/** An activity the health pass wrote longer ago than this is too old to say “now”. */
export const ACTIVITY_FRESH_MS = 15 * 60_000;
/** The disk's forecast reads this far back. */
const DISK_WINDOW_MS = 7 * 24 * 3_600_000;
/** Less history than this and the hub's own forecast stands. */
const DISK_MIN_SPAN_MS = 2 * 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;
const COMING_MAX = 5;
const KEPT_MAX = 500;
/** A read that failed is tried again after this (or its keep time, when shorter). */
const RETRY_MS = 60_000;

/**
 * Reads kept for a while: a fresh one is answered at once; a stale or missing one is read (once, however many ask) and
 * waited for at most `waitMs`, after which the asker gets what was kept (or `fallback`) and the read finishes for the
 * next one. A failed read keeps what was there and is tried again within a minute.
 */
export class KeptReads {
  #entries = new Map<string, { at: number; value: unknown; has: boolean; pending?: Promise<void> }>();

  constructor(
    private readonly clock: () => Date,
    private readonly waitMs: number,
  ) {}

  async get<T>(key: string, keepMs: number, load: () => Promise<T>, fallback: T): Promise<T> {
    const now = this.clock().getTime();
    let e = this.#entries.get(key);
    if (e?.has && now - e.at < keepMs) return e.value as T;
    if (!e) {
      if (this.#entries.size >= KEPT_MAX) this.#entries.clear();
      e = { at: 0, value: undefined, has: false };
      this.#entries.set(key, e);
    }
    const entry = e;
    entry.pending ??= load().then(
      (value) => {
        entry.value = value;
        entry.has = true;
        entry.at = this.clock().getTime();
        entry.pending = undefined;
      },
      () => {
        // What was kept stays; the next read comes sooner than a good one's.
        if (!entry.has) entry.value = fallback;
        entry.has = true;
        entry.at = this.clock().getTime() - keepMs + Math.min(keepMs, RETRY_MS);
        entry.pending = undefined;
      },
    );
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.waitMs);
      timer.unref?.();
    });
    await Promise.race([entry.pending, late]).finally(() => clearTimeout(timer));
    return entry.has ? (entry.value as T) : fallback;
  }
}

/** The update the manager is doing now (DK-118): fetching, installing or restarting into a release; else null. */
export function updateStateOf(facts: Pick<UpdateFacts, 'state'> | null | undefined): UpdateNow | null {
  switch (facts?.state) {
    case 'Assigned':
    case 'Downloading':
      return 'downloading';
    case 'Activating':
      return 'installing';
    case 'Verifying':
      return 'restarting';
    default:
      // Verified, staged or waiting for a safe moment: nothing happens yet; done or failed: nothing happens any more.
      return null;
  }
}
type UpdateNow = (typeof DeskUpdateState)['options'][number];

/** A server's last hour as the strip's sparkline: whole percents, oldest first, gaps left out, `SPARK_POINTS` at most. */
export function sparkOf(cpu: readonly (number | null)[]): number[] {
  return downsample(cpu, SPARK_POINTS)
    .points.filter((p): p is number => p !== null && Number.isFinite(p))
    .map((p) => Math.max(0, Math.min(100, Math.round(p))));
}

/** A series' points with their times: the service's timestamps, else counted back from `asOf` by its step. */
export function pointsOf(
  values: readonly (number | null)[],
  timestamps: readonly string[],
  asOf: string,
  stepS: number,
): RawPoint[] {
  const end = Date.parse(asOf);
  const stamps = timestamps.length === values.length ? timestamps.map((t) => Date.parse(t)) : null;
  return values.map((value, i) => ({
    at: new Date(stamps?.[i] ?? end - (values.length - 1 - i) * stepS * 1000),
    value: value !== null && Number.isFinite(value) ? value : null,
  }));
}

/**
 * Days until a volume is full at its rate over the points (a week): null when it isn't filling (or not within a year).
 * With less than two days of history the hub's own forecast (`fullInDays`) stands.
 */
export function diskDaysOf(
  points: readonly RawPoint[],
  hub: number | null | undefined,
  now: Date,
): number | null {
  const trend = trendOf(points, now, DISK_WINDOW_MS);
  if (!trend || trend.spanMs < DISK_MIN_SPAN_MS)
    return hub !== null && hub !== undefined && Number.isFinite(hub) && hub >= 0 && hub <= 365 ? hub : null;
  const full = forecastFull(points, 100, now);
  return full ? Math.max(0, (full.getTime() - now.getTime()) / DAY_MS) : null;
}

/** The running guests' names (an unhealthy container runs), by name. */
export function runningNames(guests: readonly { name: string; id: string; state: string }[]): string[] {
  const names = guests
    .filter((g) => g.state === 'running' || g.state === 'unhealthy')
    .map((g) => (g.name || g.id).trim())
    .filter(Boolean);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/** The connection's activity as the calm glance takes it, when it is fresh. */
export function activityOf(
  row: {
    id: string;
    catalogId: string;
    label: string;
    glance: ConnectionGlance | null;
    glanceAt: Date | null;
  },
  now: Date,
): DeskCalmActivity | null {
  const a = row.glance?.activity;
  if (!a || !row.glanceAt || now.getTime() - row.glanceAt.getTime() > ACTIVITY_FRESH_MS) return null;
  return {
    key: thingId('connection', row.id),
    name: row.label,
    mark: row.catalogId,
    value: a.value,
    ...(a.detail ? { detail: a.detail } : {}),
    ...(a.progress !== undefined ? { progress: a.progress } : {}),
    active: a.active,
  };
}

/** The sources over the runtime's services. */
export function createDeskCalmSources(
  services: Services,
  options: DeskCalmSourceOptions = {},
): DeskCalmSources {
  const kept = new KeptReads(() => services.clock(), options.waitMs ?? DESK_SOURCE_WAIT_MS);
  const hosts = () => options.hosts ?? hostsFor(services);
  const serves = (burrowId: string) =>
    hosts()
      .serves(burrowId)
      .catch(() => false);
  const read = <T>(path: string, query: Record<string, string>) =>
    within(
      hosts().call<T>({ path, query, actor: WHOMBAT_ACTOR, timeoutMs: DESK_HOSTS_WAIT_MS }),
      DESK_HOSTS_WAIT_MS,
    );

  const spark = (id: string) =>
    kept.get(
      `spark:${id}`,
      SPARK_KEEP_MS,
      async () => {
        const raw = await read<unknown>(`${HOSTS_API}/servers/${seg(id)}/metrics`, {
          range: '1h',
          series: 'cpu_pct',
        });
        return sparkOf(toHostSeries(raw, id, null, services.clock()).series.cpu_pct ?? []);
      },
      [] as number[],
    );

  const disk = (id: string, now: Date) =>
    kept.get(
      `disk:${id}`,
      DISK_KEEP_MS,
      async () => {
        const path = `${HOSTS_API}/servers/${seg(id)}`;
        const detail = toHostServerDetail(await read<unknown>(path, {}), [], null, now);
        // The fullest of its own volumes is the one the card's disk figure speaks of.
        const volume = (detail.health?.volumes ?? [])
          .filter((v) => !v.remote && v.totalGb > 0)
          .sort((a, b) => b.usedPct - a.usedPct)[0];
        if (!volume) return null;
        const key = `vol_pct:${volume.entity}`;
        const raw = await read<unknown>(`${path}/metrics`, { range: '7d', series: key }).catch(() => null);
        const series = raw === null ? null : toHostSeries(raw, id, null, now);
        const points = series
          ? pointsOf(series.series[key] ?? [], series.timestamps, series.asOf, series.stepSeconds)
          : [];
        return diskDaysOf(points, volume.fullInDays, now);
      },
      null as number | null,
    );

  const guests = (id: string) =>
    kept.get(
      `guests:${id}`,
      GUESTS_KEEP_MS,
      async () => runningNames((await hosts().guestsRaw(id)).map((g) => toHostGuest(g, id))),
      [] as string[],
    );

  return {
    async activities(viewer, now) {
      const rows = await services.db
        .select({
          id: catalogConnections.id,
          catalogId: catalogConnections.catalogId,
          label: catalogConnections.label,
          glance: catalogConnections.glance,
          glanceAt: catalogConnections.glanceAt,
        })
        .from(catalogConnections)
        .where(
          and(eq(catalogConnections.burrowId, viewer.burrowId), eq(catalogConnections.status, 'active')),
        );
      return rows
        .filter((r) => homeShowsConnection(r.catalogId))
        .map((r) => activityOf({ ...r, glance: r.glance ?? null }, now))
        .filter((a): a is DeskCalmActivity => a !== null)
        .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
    },

    activityLine: (catalogId) => kindOf(catalogId)?.activityLine ?? null,

    async coming(viewer, now, withinS) {
      const rows = await services.db
        .select()
        .from(automations)
        .where(
          and(
            eq(automations.burrowId, viewer.burrowId),
            isNull(automations.deletedAt),
            eq(automations.status, 'published'),
            gt(automations.nextFireAt, now),
            lte(automations.nextFireAt, new Date(now.getTime() + withinS * 1000)),
          ),
        )
        .orderBy(asc(automations.nextFireAt))
        .limit(COMING_MAX);
      const out: DeskCalmComing[] = [];
      for (const row of rows) {
        // A schedule removed from the live version leaves no next run (as the automation's own page says).
        const definition = await liveDefinition(services.db, row).catch(() => null);
        if (!row.nextFireAt || !definition?.triggers.some((t) => t.kind === 'schedule')) continue;
        out.push({ name: row.name, at: row.nextFireAt.toISOString() });
      }
      return out;
    },

    async sparks(burrowId, ids, _now) {
      const out = new Map<string, number[]>();
      if (ids.length === 0 || !(await serves(burrowId))) return out;
      const lines = await Promise.all(ids.map((id) => spark(id)));
      ids.forEach((id, i) => {
        const line = lines[i];
        if (line?.length) out.set(id, line);
      });
      return out;
    },

    async diskDays(burrowId, id, now) {
      if (!(await serves(burrowId))) return null;
      return disk(id, now);
    },

    async runsOn(burrowId, id) {
      if (!(await serves(burrowId))) return [];
      return guests(id);
    },

    async update() {
      return updateStateOf(options.updateFacts?.());
    },
  };
}
