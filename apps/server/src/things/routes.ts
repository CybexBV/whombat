/**
 * Thing pages over REST and sessions (contracts CT-390…CT-393, CT-397, CT-1063; connection-pages.md CP-04, CP-08, CP-12;
 * dashboards.md DS-03; quiet-notices.md QN-10…QN-15): the page over its range, its actions, what a connection runs on,
 * Ignore, Remind me tomorrow, What Whombat watches and a thing's history. The managed dispatcher runs
 * these same handlers.
 */
import { api, parseThingId } from '@whombat/core';
import { viewerOf } from '../connections/routes';
import { exposureView } from '../exposure/view';
import { setServerWatchLimit } from '../hosts/quiet';
import { thingHistory } from '../incidents/history';
import { cancelThingWatch } from '../incidents/thing-watch';
import { badRequest, forbidden } from '../lib/errors';
import { commitAs } from '../routes/burrows';
import { type RouteDef, route } from '../routes/define';
import { runThingAction } from './actions';
import { thingPage } from './page';
import { quietThingNotice, setThingWatch, thingWatch } from './quiet/service';
import { endThingQuiet, keepThingQuiet } from './quiet/window-service';
import { pageRange } from './series';
import { setRunsOn } from './set-runs-on';

/** A thingId from the path: the router decodes it; a session may pass it still encoded. */
export function thingParam(value: string): string;
export function thingParam(value: string | undefined): string | undefined;
export function thingParam(value: string | undefined): string | undefined {
  if (!value) return value;
  return /%3a/i.test(value) ? decodeURIComponent(value) : value;
}

export const thingRoutes: RouteDef[] = [
  route(api.things.cancelWatch, async (ctx) => {
    if (ctx.access.principal.kind !== 'person') throw forbidden('Only you can stop a watch.');
    const { watch } = await commitAs(ctx, cancelThingWatch, { watchId: ctx.params.watchId });
    return watch;
  }),
  route(api.things.page, async (ctx) => {
    if (ctx.access.principal.kind !== 'person') throw forbidden('Only you can see pages here.');
    return thingPage(
      ctx.services,
      await viewerOf(ctx),
      thingParam(ctx.params.thing),
      ctx.access.burrow.timeZone,
      pageRange(ctx.query.range),
    );
  }),
  route(api.things.action, async (ctx) => {
    if (ctx.access.principal.kind !== 'person') throw forbidden('Only you can use a page’s actions.');
    return runThingAction(
      ctx.services,
      await viewerOf(ctx),
      thingParam(ctx.params.thing),
      ctx.body,
      ctx.access.burrow.timeZone,
    );
  }),
  // Ignore, Remind me tomorrow and Stop watching (quiet-notices.md QN-10…QN-15; contracts 0.122 CT-1063).
  route(api.things.quiet, async (ctx) =>
    quietThingNotice(
      ctx.services,
      await viewerOf(ctx),
      thingParam(ctx.params.thing),
      ctx.body,
      ctx.access.burrow.timeZone,
    ),
  ),
  route(api.things.watch, async (ctx) => {
    if (ctx.access.principal.kind !== 'person') throw forbidden('Only you can see pages here.');
    return thingWatch(
      ctx.services,
      await viewerOf(ctx),
      thingParam(ctx.params.thing),
      ctx.access.burrow.timeZone,
    );
  }),
  // What went wrong over 30 or 90 days.
  route(api.things.history, async (ctx) => {
    if (ctx.access.principal.kind !== 'person') throw forbidden('Only you can see pages here.');
    return thingHistory(
      ctx.services,
      await viewerOf(ctx),
      thingParam(ctx.params.thing),
      ctx.query.days ?? 30,
      ctx.access.burrow.timeZone,
    );
  }),
  // Open to the internet: every opening Whombat reads in the settings of what it is connected to.
  route(api.things.exposure, async (ctx) => {
    if (ctx.access.principal.kind !== 'person') throw forbidden('Only you can see pages here.');
    return exposureView(ctx.services, await viewerOf(ctx), ctx.access.burrow.timeZone);
  }),
  route(api.things.setWatch, async (ctx) =>
    setThingWatch(
      ctx.services,
      await viewerOf(ctx),
      thingParam(ctx.params.thing),
      ctx.body,
      ctx.access.burrow.timeZone,
    ),
  ),
  route(api.things.setWatchLimit, async (ctx) => {
    if (ctx.access.principal.kind !== 'person')
      throw forbidden('Only you can change a server’s alert limit.');
    const thing = parseThingId(thingParam(ctx.params.thing));
    if (thing?.kind !== 'server') throw badRequest('Choose a server to change its alert limit.');
    return setServerWatchLimit(
      ctx.services,
      {
        burrowId: ctx.access.burrow.id,
        actorId: ctx.access.principal.id,
        serverId: thing.id,
      },
      ctx.body,
    );
  }),
  // Keep quiet for a while, and End now.
  route(api.things.keepQuiet, async (ctx) =>
    keepThingQuiet(
      ctx.services,
      await viewerOf(ctx),
      thingParam(ctx.params.thing),
      ctx.body,
      ctx.access.burrow.timeZone,
    ),
  ),
  route(api.things.endQuiet, async (ctx) =>
    endThingQuiet(
      ctx.services,
      await viewerOf(ctx),
      thingParam(ctx.params.thing),
      ctx.access.burrow.timeZone,
    ),
  ),
  route(api.connections.setRunsOn, async (ctx) =>
    setRunsOn(ctx.services, await viewerOf(ctx), ctx.params.connectionId, ctx.body),
  ),
];
