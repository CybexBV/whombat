/**
 * History on every page: a thing's week in one line, from its `up` points and its
 * incidents (a server's from its offline alerts in the hosts service and its incidents), and `things.history`: its
 * incidents over 30 or 90 days, its uptime over them and, for a server, the alerts the hosts service had.
 */
import {
  type HostAlert,
  HostAlertOverlapQuery,
  parseThingId,
  type ThingHistory,
  type ThingHistoryAlert,
  type ThingIncident,
  type ThingPage,
  type ThingTextPart,
  type ThingUptime,
  Timestamp,
} from '@whombat/core';
import type { ConnectionViewer } from '../connections/store';
import type { IncidentRow } from '../db/schema/index';
import { HOSTS_API, type HostsActor, seg } from '../hosts/client';
import { arr, obj, toHostAlert } from '../hosts/map';
import { HEARTBEAT_RULE } from '../hosts/quiet-lines';
import { WHOMBAT_ACTOR } from '../hosts/service';
import { notFound } from '../lib/errors';
import type { Services } from '../services';
import { thingVisible } from '../things/page';
import { POINTS_KEEP_MS, RTT_KEY, readPoints, UP_KEY } from '../things/points';
import { hostsServing } from '../things/runs-on';
import { incidentsSince } from './store';
import { type DownStretch, downTime, thingUptime, upPoints, upShare } from './uptime';

const DAY = 24 * 60 * 60_000;
/** A thing watched for less than this past the period's start says “since …” instead of the period. */
const LATE_START_MS = 6 * 60 * 60_000;

/** An incident's down stretch, when it was a `down` one. */
function downStretches(rows: readonly IncidentRow[]): DownStretch[] {
  return rows.filter((r) => r.nature === 'down').map((r) => ({ from: r.startedAt, to: r.endedAt }));
}

/** A server's offline stretches from its heartbeat alerts. */
function offlineStretches(alerts: readonly HostAlert[]): DownStretch[] {
  return alerts
    .filter((a) => a.rule === HEARTBEAT_RULE)
    .map((a) => ({ from: new Date(a.openedAt), to: a.resolvedAt ? new Date(a.resolvedAt) : null }));
}

/**
 * The hosts service's alerts that were open at any time since the period started, newest first.
 * Null when the hosts service doesn't serve this burrow or can't be read.
 */
export async function hostsAlertsOverlapping(
  services: Services,
  burrowId: string,
  actor: HostsActor,
  query: { server?: string; since: Date; rule?: string; limit?: number },
): Promise<HostAlert[] | null> {
  const hosts = await hostsServing(services, burrowId);
  if (!hosts) return null;
  try {
    const raw = await hosts.call<unknown>({
      path: `${HOSTS_API}/alerts`,
      query: HostAlertOverlapQuery.parse({
        state: 'all',
        server: query.server,
        rule: query.rule,
        overlaps_since: query.since.toISOString(),
        limit: query.limit ?? 500,
      }),
      actor,
    });
    return arr(raw).map(toHostAlert);
  } catch {
    return null;
  }
}

/** What `periodUptime` covers: `days` up to `now`, and what the caller already read. */
export interface PeriodInput {
  now: Date;
  days: number;
  timeZone: string;
  /** The thing's incidents in the period, when read already. */
  rows?: readonly IncidentRow[];
  /** A server's offline alerts in the period (null: the hosts service couldn't say); read when left out. */
  alerts?: readonly HostAlert[] | null;
  /** Who reads a server's alerts, when they aren't given. */
  actor?: HostsActor;
  /** The first report a server has on record, when its detail is already loaded. */
  firstReportAt?: Date | null;
}

export function serverFirstReportAt(raw: unknown): Date | null {
  const at = Timestamp.safeParse(obj(obj(raw).server).first_report_at);
  return at.success ? new Date(at.data) : null;
}

/**
 * A thing's uptime over the last `days`, as a line and as `ThingUptime`; null when Whombat knows nothing of it. A
 * connection's or device's from its `up` points (kept 30 days: a longer period says “since …”) and its `down`
 * incidents; a server's from its offline alerts in the hosts service and its incidents, counted once.
 */
export async function periodUptime(
  services: Services,
  burrowId: string,
  thing: string,
  input: PeriodInput,
): Promise<{ uptime: ThingUptime; parts: ThingTextPart[] } | null> {
  const { now, days, timeZone } = input;
  const from = new Date(now.getTime() - days * DAY);
  const rows = input.rows ?? (await incidentsSince(services.db, burrowId, from, thing));
  const parsed = parseThingId(thing);
  if (parsed?.kind === 'server') {
    const actor = input.actor ?? WHOMBAT_ACTOR;
    const [alerts, firstReportAt] = await Promise.all([
      input.alerts !== undefined
        ? input.alerts
        : hostsAlertsOverlapping(services, burrowId, actor, {
            server: parsed.id,
            rule: HEARTBEAT_RULE,
            since: from,
          }),
      input.firstReportAt !== undefined
        ? input.firstReportAt
        : hostsServing(services, burrowId)
            .then(async (hosts) => {
              if (!hosts) return null;
              const raw = await hosts.call<unknown>({
                path: `${HOSTS_API}/servers/${seg(parsed.id)}`,
                actor,
              });
              return serverFirstReportAt(raw);
            })
            .catch(() => null),
    ]);
    const hasStart = firstReportAt !== null && firstReportAt < now;
    const start = hasStart && firstReportAt > from ? firstReportAt : from;
    const downs = downTime([...downStretches(rows), ...offlineStretches(alerts ?? [])], start, now);
    return thingUptime({
      share:
        alerts !== null && hasStart ? Math.max(0, 1 - downs.ms / (now.getTime() - start.getTime())) : null,
      downs: downs.count,
      downMinutes: downs.minutes,
      from: start,
      now,
      timeZone,
      days,
    });
  }
  const connectionId = parsed?.kind === 'connection' || parsed?.kind === 'device' ? parsed.id : null;
  const points = connectionId
    ? await readPoints(
        services.db,
        connectionId,
        [UP_KEY, RTT_KEY],
        now,
        Math.min(days * DAY, POINTS_KEEP_MS),
      )
    : null;
  const share = upShare(upPoints(points?.get(UP_KEY) ?? [], points?.get(RTT_KEY) ?? []), from, now);
  const downs = downTime(downStretches(rows), from, now);
  return thingUptime({
    share: share.share,
    downs: downs.count,
    downMinutes: downs.minutes,
    // Watched for less than the period (or its points are kept less long): “since …”.
    from: share.first && share.first.getTime() - from.getTime() > LATE_START_MS ? share.first : from,
    now,
    timeZone,
    days,
  });
}

/** The page's line and `uptime` for a connection, device or account over the last week. */
export function connectionUptime(
  services: Services,
  burrowId: string,
  thing: string,
  now: Date,
  timeZone: string,
): Promise<{ uptime: ThingUptime; parts: ThingTextPart[] } | null> {
  return periodUptime(services, burrowId, thing, { now, days: 7, timeZone });
}

/** A server's week, from its offline alerts this week (null: the hosts service couldn't say) and its incidents. */
export function serverUptime(
  services: Services,
  burrowId: string,
  serverId: string,
  alerts: readonly HostAlert[] | null,
  firstReportAt: Date | null,
  now: Date,
  timeZone: string,
): Promise<{ uptime: ThingUptime; parts: ThingTextPart[] } | null> {
  return periodUptime(services, burrowId, `server:${serverId}`, {
    now,
    days: 7,
    timeZone,
    alerts,
    firstReportAt,
  });
}

/**
 * A page with its week in one line: as `uptime`, and as one of its facts, so an app that doesn't know `uptime` shows it
 * too (after the first fact, which is the thing's own). The page as it was when there is nothing to tell.
 */
export async function withUptime(
  services: Services,
  burrowId: string,
  page: ThingPage,
  timeZone: string,
): Promise<ThingPage> {
  const said = await connectionUptime(services, burrowId, page.id, services.clock(), timeZone).catch(
    () => null,
  );
  if (!said) return page;
  const facts = [...page.facts];
  facts.splice(Math.min(1, facts.length), 0, said.parts);
  return { ...page, facts: facts.slice(0, 6), uptime: said.uptime };
}

/** An incident as the apps list it. */
export function thingIncident(row: IncidentRow, now: Date): ThingIncident {
  const end = row.endedAt ?? now;
  return {
    id: row.id,
    nature: row.nature === 'down' ? 'down' : 'problem',
    words: row.words.slice(0, 200) || 'Not answering',
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    minutes: Math.max(0, Math.round((end.getTime() - row.startedAt.getTime()) / 60_000)),
    ...(row.causeThing && row.causeName
      ? { cause: { thing: row.causeThing, name: row.causeName.slice(0, 120) } }
      : {}),
  };
}

/** A hosts alert as a server's history lists it. */
function historyAlert(a: HostAlert): ThingHistoryAlert {
  return {
    title: a.title.slice(0, 300),
    severity: a.severity,
    rule: a.rule.slice(0, 120),
    openedAt: a.openedAt,
    resolvedAt: a.resolvedAt ?? null,
  };
}

/** `things.history`: a thing the viewer may see, over the last `days` days (30 or 90). */
export async function thingHistory(
  services: Services,
  viewer: ConnectionViewer,
  thing: string,
  days: number,
  timeZone: string,
): Promise<ThingHistory> {
  const parsed = parseThingId(thing);
  if (!parsed || !(await thingVisible(services, viewer, thing))) throw notFound('Thing');
  const now = services.clock();
  const from = new Date(now.getTime() - days * DAY);
  const rows = await incidentsSince(services.db, viewer.burrowId, from, thing);
  // A server's alerts of every rule, its offline ones among them.
  const alerts =
    parsed.kind === 'server'
      ? await hostsAlertsOverlapping(
          services,
          viewer.burrowId,
          { id: viewer.principal.id, name: viewer.principal.name || 'Someone', role: 'viewer' },
          { server: parsed.id, since: from },
        )
      : undefined;
  const said = await periodUptime(services, viewer.burrowId, thing, {
    now,
    days,
    timeZone,
    rows,
    ...(alerts !== undefined ? { alerts } : {}),
  });
  return {
    thing,
    days,
    from: from.toISOString(),
    uptime: said?.uptime ?? null,
    incidents: rows.map((r) => thingIncident(r, now)),
    ...(alerts ? { alerts: alerts.slice(0, 500).map(historyAlert) } : {}),
  };
}
