/**
 * A Find My connection's timeline over sessions (docs/decisions/findmy-timeline.md): the days, whose days it keeps,
 * deleting them, and a day's map. Only the box's person, as Find My on the connection's page: an assistant, a desk
 * display, a share link or an outsiders' turn never gets here.
 */
import { api } from '@whombat/core';
import { visibleConnection } from '../connections/store';
import type { CatalogConnectionRow } from '../connections/types';
import { ApiError, forbidden } from '../lib/errors';
import { commitAs } from '../routes/burrows';
import { type HandlerContext, type RouteDef, route } from '../routes/define';
import { findMyFor } from './findmy';
import { findMyBackgroundFor } from './findmy-background';
import { FIND_MY_CATALOG_ID, macOf } from './findmy-connection';
import { deleteFindMyTimeline, keptTimelinePeople, setFindMyTimeline } from './findmy-timeline';
import { findMyTimelineMapOf, findMyTimelineOf, timelinePeopleNow } from './findmy-timeline-view';
import { cancelFindMyWatch } from './findmy-watch';
import { serverLabel } from './self';
import { actorOf, HOSTS_TEXT, hostsFor } from './service';

type Ctx = HandlerContext<(typeof api.connections)[keyof typeof api.connections]>;

export const ONLY_YOU_SEE_THE_TIMELINE_TEXT = 'Only you can see the Find My timeline.';

/** The person, and the Find My connection the route names (404 for any other connection). */
async function timelineGuard(
  ctx: Pick<Ctx, 'services' | 'access'>,
  connectionId: string,
): Promise<CatalogConnectionRow> {
  if (ctx.access.principal.kind !== 'person') throw forbidden(ONLY_YOU_SEE_THE_TIMELINE_TEXT);
  const row = await visibleConnection(ctx.services.db, { burrowId: ctx.access.burrow.id }, connectionId);
  if (row.catalogId !== FIND_MY_CATALOG_ID)
    throw new ApiError('not_found', 'That connection isn’t Find My.', { details: { code: 'not_find_my' } });
  return row;
}

export const findMyTimelineRoutes: RouteDef[] = [
  route(api.connections.findMyTimeline, async (ctx) => {
    const row = await timelineGuard(ctx, ctx.params.connectionId);
    return findMyTimelineOf(ctx.services, row, ctx.query);
  }),

  // Whose days it keeps: the names come from the Mac's last read in memory, else from those kept already.
  route(api.connections.findMyTimelineSet, async (ctx) => {
    const row = await timelineGuard(ctx, ctx.params.connectionId);
    const { services } = ctx;
    const mac = macOf(row);
    const read = (mac ? findMyFor(services).peek(mac)?.people : null) ?? [];
    const names = new Map<string, string>([
      ...(await keptTimelinePeople(services.db, row.id)).map((k): [string, string] => [k.person, k.name]),
      ...read.map((p): [string, string] => [p.id, p.name]),
    ]);
    const unknown = ctx.body.people.filter((id) => !names.has(id));
    if (unknown.length)
      throw new ApiError(
        'not_found',
        `Whombat didn’t read that person from Find My${mac ? ` on ${serverLabel(mac)}` : ''}. Read it again and try once more.`,
        { details: { code: 'find_my_person' } },
      );
    const { eventId } = await commitAs(ctx, setFindMyTimeline, {
      connectionId: row.id,
      people: ctx.body.people.map((person) => ({ person, name: names.get(person) as string })),
    });
    // A connection that starts or stops keeping one reads at its new pace from the next pass, which starts now.
    if (eventId) findMyBackgroundFor(services).nudge();
    const kept = await keptTimelinePeople(services.db, row.id);
    return { ok: true as const, eventId, people: timelinePeopleNow(services, row, kept) };
  }),

  route(api.connections.findMyTimelineDelete, async (ctx) => {
    const row = await timelineGuard(ctx, ctx.params.connectionId);
    const { eventId } = await commitAs(ctx, deleteFindMyTimeline, { connectionId: row.id });
    const kept = await keptTimelinePeople(ctx.services.db, row.id);
    return { ok: true as const, eventId, people: timelinePeopleNow(ctx.services, row, kept) };
  }),

  // A one-time watch's Cancel (findmy-watch.md): the person's; one that already ended answers as it is.
  route(api.connections.findMyWatchCancel, async (ctx) => {
    if (ctx.access.principal.kind !== 'person') throw forbidden('Only you can stop a watch.');
    const { watch } = await commitAs(ctx, cancelFindMyWatch, { watchId: ctx.params.watchId });
    return watch;
  }),

  // The Mac draws it, as Find My's own map: through the hosts service, as the person.
  route(api.connections.findMyTimelineMap, async (ctx) => {
    const row = await timelineGuard(ctx, ctx.params.connectionId);
    const hosts = hostsFor(ctx.services);
    if (!hosts.present || !(await hosts.serves(ctx.access.burrow.id)))
      throw new ApiError('unavailable', hosts.present ? HOSTS_TEXT.otherBurrow : HOSTS_TEXT.absent, {
        details: { code: 'hosts_unavailable' },
      });
    return findMyTimelineMapOf(
      ctx.services,
      hosts,
      row,
      ctx.query,
      actorOf(ctx.access.principal, 'admin', null),
    );
  }),
];
