/**
 * Thing pages over REST and sessions (contracts CT-390…CT-393, CT-397, CT-1063; connection-pages.md CP-04, CP-08, CP-12;
 * dashboards.md DS-03; quiet-notices.md QN-10…QN-15): the page over its range, its actions, what a connection runs on,
 * Ignore, Remind me tomorrow, What Whombat watches and a thing's history. The managed dispatcher runs
 * these same handlers.
 */
import { api } from '@whombat/core';
import { viewerOf } from '../connections/routes';
import { thingHistory } from '../incidents/history';
import { forbidden } from '../lib/errors';
import { type RouteDef, route } from '../routes/define';
import { runThingAction } from './actions';
import { thingPage } from './page';
import { quietThingNotice, setThingWatch, thingWatch } from './quiet/service';
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
  // What went wrong over 30 or 90 days (monitoring.md MON-09).
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
  route(api.things.setWatch, async (ctx) =>
    setThingWatch(
      ctx.services,
      await viewerOf(ctx),
      thingParam(ctx.params.thing),
      ctx.body,
      ctx.access.burrow.timeZone,
    ),
  ),
  route(api.connections.setRunsOn, async (ctx) =>
    setRunsOn(ctx.services, await viewerOf(ctx), ctx.params.connectionId, ctx.body),
  ),
];
