/**
 * What the apps and the assistant read of a Find My timeline (docs/decisions/findmy-timeline.md): each day asked in the
 * viewer's time zone, built from the kept rows (`findMyTimelineDay`), the people of the Mac's last read in memory with
 * those kept, how often the connection reads, and whether the assistant may read it; and a day's map, drawn by the Mac
 * around one person's stops. Only for the box's person: the routes check that.
 */
import {
  FIND_MY_TIMELINE_TOOL,
  type FindMyTimeline,
  type FindMyTimelineMap,
  type FindMyTimelineMapQuery,
  type FindMyTimelinePerson,
  type FindMyTimelineQuery,
  type FindMyTimelineSegment,
  findMyDayBounds,
  findMyProblemText,
  findMyTimelineDates,
  findMyTimelinePins,
  findMyTimelineTolerance,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { outsideCommandScope } from '../commit/scope';
import { ensureTools } from '../connections/sync';
import type { CatalogConnectionRow } from '../connections/types';
import { connectionTools } from '../db/schema/index';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';
import type { HostsActor } from './client';
import { hostsCall } from './errors';
import { findMyFor, stepProblem } from './findmy';
import { type FindMyPace, findMyPace, listenedFindMyConnections, macOf } from './findmy-connection';
import {
  FIND_MY_TIMELINE_EVERY_MIN,
  type KeptPerson,
  keptTimelinePeople,
  stopsAround,
  timelineDay,
  timelinePeople,
} from './findmy-timeline';
import { screenStep } from './screen';
import { serverLabel } from './self';
import type { HostsService } from './service';

/**
 * How the connection reads in the background now, as the loop plans it: its own setting, an automation that listens,
 * or its timeline (`keeping`); null while it reads only when someone looks.
 */
export async function timelinePaceOf(
  services: Services,
  row: Pick<CatalogConnectionRow, 'id' | 'fields'>,
  keeping: boolean,
): Promise<FindMyPace | null> {
  const listened = (await services.newerAutomations.findMyReady())
    ? await listenedFindMyConnections(services.db)
    : new Map<string, string>();
  return findMyPace(row.fields.background, listened.get(row.id) ?? null, FIND_MY_TIMELINE_EVERY_MIN, keeping);
}

/** The tolerance a day is built with: from the connection's pace, every 15 minutes when it has none. */
const toleranceOf = (pace: FindMyPace | null) =>
  findMyTimelineTolerance((pace?.everyMinutes ?? FIND_MY_TIMELINE_EVERY_MIN) * 60_000);

/**
 * Whether the assistant may read the timeline: the `findmy_timeline` tool is Allowed. A connection from before the tool
 * gets its tools read once here, so the person's switch (`connections.setTool`) finds it.
 */
export async function assistantReadsTimeline(
  services: Services,
  row: CatalogConnectionRow,
): Promise<boolean> {
  const name = FIND_MY_TIMELINE_TOOL.name;
  const tierOf = async () => {
    const [tool] = await services.db
      .select({ tier: connectionTools.tier })
      .from(connectionTools)
      .where(and(eq(connectionTools.connectionId, row.id), eq(connectionTools.name, name)));
    return tool?.tier ?? null;
  };
  let tier = await tierOf();
  if (tier === null && row.status === 'active') {
    await outsideCommandScope(() => ensureTools(services, row)).catch(() => null);
    tier = await tierOf();
  }
  // Until its tools are read it is what it will be: Allowed from the start.
  return (tier ?? 'can') === 'can';
}

/** Everyone the timeline lists now: the Mac's last read in memory (never counted as a look) and those kept. */
export function timelinePeopleNow(
  services: Services,
  row: Pick<CatalogConnectionRow, 'fields'>,
  kept: readonly KeptPerson[],
): FindMyTimelinePerson[] {
  const mac = macOf(row);
  const shown = mac ? findMyFor(services).peek(mac) : null;
  return timelinePeople(shown?.people ?? [], kept);
}

/** `connections.findMyTimeline`: the days asked, oldest first, with everyone, the pace, the last read and the switch. */
export async function findMyTimelineOf(
  services: Services,
  row: CatalogConnectionRow,
  q: FindMyTimelineQuery,
): Promise<FindMyTimeline> {
  const now = services.clock();
  const mac = macOf(row);
  const shown = mac ? findMyFor(services).peek(mac) : null;
  const kept = await keptTimelinePeople(services.db, row.id);
  const pace = await timelinePaceOf(services, row, kept.length > 0);
  const toleranceMs = toleranceOf(pace);
  const days = findMyTimelineDates(q.date, q.days).map((date) => ({ date, ...findMyDayBounds(date, q.tz) }));
  const first = days[0];
  const last = days[days.length - 1];
  const rows =
    first && last
      ? await stopsAround(
          services.db,
          row.id,
          kept.map((k) => k.person),
          new Date(first.from),
          new Date(last.to),
        )
      : new Map();
  return {
    connectionId: row.id,
    days: days.map((d) => ({
      date: d.date,
      from: d.from,
      to: d.to,
      people: kept.map((k) => ({
        person: k.person,
        segments: timelineDay(rows.get(k.person) ?? [], {
          from: new Date(d.from),
          to: new Date(d.to),
          now,
          toleranceMs,
        }),
      })),
    })),
    people: timelinePeople(shown?.people ?? [], kept),
    paceMinutes: pace?.everyMinutes ?? null,
    readAt: shown?.readAt ?? null,
    assistantReads: await assistantReadsTimeline(services, row),
  };
}

/** One kept person's day (the tool, the map): its segments, or null when the person isn't kept. */
export async function personTimelineDay(
  services: Services,
  row: CatalogConnectionRow,
  person: string,
  date: string,
  tz: string,
  kept?: readonly KeptPerson[],
): Promise<FindMyTimelineSegment[] | null> {
  const keeping = kept ?? (await keptTimelinePeople(services.db, row.id));
  if (!keeping.some((k) => k.person === person)) return null;
  const { from, to } = findMyDayBounds(date, tz);
  const rows = await stopsAround(services.db, row.id, [person], new Date(from), new Date(to));
  return timelineDay(rows.get(person) ?? [], {
    from: new Date(from),
    to: new Date(to),
    now: services.clock(),
    toleranceMs: toleranceOf(await timelinePaceOf(services, row, true)),
  });
}

/**
 * `connections.findMyTimelineMap`: the Mac draws the map around one kept person's stops of a day (each distinct spot a
 * pin, in order, at most 20), in the app's theme at two pixels a point, as `hosts.findMyMap` does; the answer says
 * where each pin is and which stops it stands for. Nothing of it is kept. 409 `find_my_no_places` without a spot that
 * day.
 */
export async function findMyTimelineMapOf(
  services: Services,
  hosts: Pick<HostsService, 'call'>,
  row: CatalogConnectionRow,
  q: FindMyTimelineMapQuery,
  actor: HostsActor,
): Promise<FindMyTimelineMap> {
  const mac = macOf(row);
  if (!mac)
    throw new ApiError('conflict', 'This Find My connection names no Mac. Pick one in its settings.', {
      details: { code: 'find_my_no_mac' },
    });
  const label = serverLabel(mac);
  const kept = await keptTimelinePeople(services.db, row.id);
  const name = kept.find((k) => k.person === q.person)?.name;
  const segments = await personTimelineDay(services, row, q.person, q.date, q.tz, kept);
  if (!segments || !name)
    throw new ApiError('not_found', 'Whombat keeps no timeline for that person.', {
      details: { code: 'find_my_person' },
    });
  const pins = findMyTimelinePins(segments);
  if (!pins.length)
    throw new ApiError('conflict', `Whombat has no spot for ${name} that day.`, {
      details: { code: 'find_my_no_places' },
    });
  const dark = q.dark ?? false;
  const r = await hostsCall(
    () =>
      screenStep(
        hosts,
        mac,
        {
          op: 'map.snapshot',
          w: q.w,
          h: q.h,
          scale: 2,
          dark,
          format: 'jpeg',
          pins: pins.map((p) => ({ lat: p.spot.lat, lon: p.spot.lon })),
        },
        actor,
      ),
    { server: label, op: 'screen' },
  );
  if (!r.ok || !r.imageB64) {
    const p = r.ok ? { code: 'failed' as const } : stepProblem('map.snapshot', r);
    throw new ApiError('conflict', findMyProblemText(p.code, label, p.message), {
      details: { code: p.code },
    });
  }
  return {
    connectionId: row.id,
    person: q.person,
    date: q.date,
    imageB64: r.imageB64,
    format: r.format ?? 'jpeg',
    w: r.w ?? 0,
    h: r.h ?? 0,
    points: pins.flatMap((pin, i) => {
      const at = r.points?.[i];
      return at ? [{ stops: pin.stops, x: at.x, y: at.y }] : [];
    }),
    lat: r.lat ?? 0,
    lon: r.lon ?? 0,
    spanM: r.spanM ?? 0,
  };
}
