/**
 * REST of one Whombat's assistant side (one-whombat-assistant.md; contracts CT-336, CT-337): task chats, Home, Watch,
 * snoozes and ignores, Done recently with Undo, and widgets. Every route is the caller's own view; writes are pipeline commands.
 */
import { type AnyEndpoint, api, type HomeRef, type NoticeRef, parseThingId, thingId } from '@whombat/core';
import { careOfferFor } from '../care/facts';
import { discussNeedsYou } from '../chats/commands';
import { chatRoutes, startedChatAnswer } from '../chats/routes';
import { viewerOf } from '../connections/routes';
import { hintNoticeById } from '../hosts/quiet';
import { ackHostsAlert, quietHostsAlert, unackHostsAlert } from '../hosts/routes';
import { ApiError, notFound } from '../lib/errors';
import { hasCareLines } from '../looks/lines';
import { fixLook, handleLook, liveResearches } from '../looks/research';
import { thingLook } from '../looks/watch';
import { commitAs } from '../routes/burrows';
import { type HandlerContext, type RouteDef, route } from '../routes/define';
import { quietThingNotice } from '../things/quiet/service';
import { thingParam } from '../things/routes';
import { arrangeOverview, overviewFigures, overviewViews } from './arrange';
import { listChanges, undoChange } from './changes';
import { discussOpener } from './discuss';
import { connectionNoticeRef, homeOverview, watchList } from './overview';
import { acknowledgeWatch, ignoreNeedsYou, snoozeNeedsYou } from './snoozes';
import { listWidgets, moveWidget, removeWidget, widgetPlace } from './widgets';

type HomeCtx = Pick<HandlerContext<AnyEndpoint>, 'services' | 'access' | 'auth'>;

/**
 * The line behind a Needs you or Watch item that Ignore quiets for the whole Whombat (quiet-notices.md QN-14, QN-21,
 * QN-23): a connection's worst line, a server hint's, a device that doesn't answer. Null where there is none now (the
 * hint went) or the item is no line (an approval, a failed run): those stay the person's own.
 */
async function sharedLine(ctx: HomeCtx, ref: HomeRef): Promise<{ thing: string; notice: NoticeRef } | null> {
  if (ref.kind === 'connection') {
    const notice = await connectionNoticeRef(
      ctx.services,
      ctx.access.principal,
      ref.id,
      ctx.services.clock(),
    );
    return notice ? { thing: thingId('connection', ref.id), notice } : null;
  }
  if (ref.kind === 'hint') return hintNoticeById(ctx.services, ctx.access.burrow.id, ref.id);
  if (ref.kind === 'device') return { thing: thingId('device', ref.id), notice: { check: 'device.answers' } };
  return null;
}

/** Ignore or Undo on that line; Undo of a line nobody quieted is nothing to take back. */
async function quietLine(
  ctx: HomeCtx,
  line: { thing: string; notice: NoticeRef },
  how: 'ignore' | 'undo',
): Promise<void> {
  const viewer = await viewerOf(ctx);
  await quietThingNotice(
    ctx.services,
    viewer,
    line.thing,
    { notice: line.notice, how },
    ctx.access.burrow.timeZone,
  ).catch((err) => {
    if (!(how === 'undo' && err instanceof ApiError && err.code === 'not_found')) throw err;
  });
}

export const oneWhombatRoutes: RouteDef[] = [
  ...chatRoutes,
  route(api.home.overview, async ({ services, access }) => homeOverview(services, access)),
  // The step the assistant offers on a look (look-research.md LR-08): the press is the go-ahead for that one step.
  route(api.looks.fix, async (ctx) => commitAs(ctx, fixLook, { key: ctx.body.key })),
  // Everything that needs a look on a thing, handed to the assistant at once (handle-it.md): read now, then one commit.
  route(api.looks.handle, async (ctx) => {
    const { key } = ctx.body;
    const found = await thingLook(ctx.services, ctx.access, key).catch(() => null);
    // A server's missing backups, snapshots or updates are answered by its care plan (care-plan.md).
    const server = found?.kind === 'server' && hasCareLines(found) ? parseThingId(found.key)?.id : null;
    const care = server
      ? await careOfferFor(ctx.services, ctx.access.burrow.id, server).catch(() => null)
      : null;
    const look = found ? { ...found, care } : null;
    return commitAs(ctx, handleLook, { key, look });
  }),
  route(api.looks.get, async ({ services, access, query }) => ({
    research: (await liveResearches(services.db, access.burrow.id)).get(query.key) ?? null,
  })),
  route(api.watch.list, async ({ services, access, query }) => ({
    items: await watchList(services, access, { state: query.state ?? 'open' }),
  })),
  // A server alert's “Remind me tomorrow” is the hosts service's snooze (QN-12, QN-23); an alert that went meanwhile
  // keeps a snooze of its own.
  route(api.needsYou.snooze, async (ctx) => {
    const { ref, until } = ctx.body;
    if (ref.kind === 'alert')
      try {
        await quietHostsAlert(ctx, ref.id, 'snooze', until);
        return { ref, snoozedUntil: until };
      } catch (err) {
        const own = ['not_allowed', 'not_found', 'unavailable'];
        if (!(err instanceof ApiError && own.includes(err.code))) throw err;
      }
    return commitAs(ctx, snoozeNeedsYou, ctx.body);
  }),
  // On a connection, a server hint or a device it is the shared Ignore of its line (quiet-notices.md QN-21, QN-S18);
  // asks stay the person's own.
  route(api.needsYou.ignore, async (ctx) => {
    const { ref, ignored } = ctx.body;
    // A server alert's is the hosts service's acknowledgement until it resolves (QN-21, QN-23; QN-S54); an alert that
    // went meanwhile, or one where no servers are watched, keeps an Ignore of its own.
    if (ref.kind === 'alert') {
      try {
        await quietHostsAlert(ctx, ref.id, ignored ? 'ignore' : 'undo');
      } catch (err) {
        const own = ['not_allowed', 'not_found', 'unavailable'];
        if (!(err instanceof ApiError && own.includes(err.code))) throw err;
        if (ignored) return commitAs(ctx, ignoreNeedsYou, ctx.body);
      }
      if (!ignored) await commitAs(ctx, ignoreNeedsYou, { ref, ignored: false });
      return { ref, ignored };
    }
    const line = await sharedLine(ctx, ref);
    if (!line) {
      // A server hint that went meanwhile has nothing left to ignore; an Ignore of one's own would hide its next time.
      if (ignored && ref.kind === 'hint') return { ref, ignored };
      return commitAs(ctx, ignoreNeedsYou, ctx.body);
    }
    if (ignored) await quietLine(ctx, line, 'ignore');
    else {
      await quietLine(ctx, line, 'undo');
      // An Ignore of their own from before stays theirs to take back.
      await commitAs(ctx, ignoreNeedsYou, { ref, ignored: false });
    }
    return { ref, ignored };
  }),
  // Talk to {assistant} about it (inbox.md IBX-07): the item as the caller's Inbox has it now, so its words are
  // Whombat's own; a new thread the assistant opens with them.
  route(api.needsYou.discuss, async (ctx) => {
    const { ref } = ctx.body;
    const overview = await homeOverview(ctx.services, ctx.access);
    const item = (overview.needsYouList ?? overview.needsYou).find(
      (i) => i.ref.kind === ref.kind && i.ref.id === ref.id,
    );
    if (!item) throw notFound('Inbox item');
    const started = await commitAs(ctx, discussNeedsYou, {
      text: discussOpener(item),
      ...(item.subject ? { subject: item.subject } : {}),
    });
    return startedChatAnswer(ctx, started);
  }),
  // A server alert's acknowledgement is the hosts service's (shared, until it resolves); anything else the person's own.
  route(api.watch.acknowledge, async (ctx) => {
    const { ref, acknowledged } = ctx.body;
    if (ref.kind === 'alert') {
      if (acknowledged) await ackHostsAlert(ctx, ref.id, { minutes: 0 });
      else await unackHostsAlert(ctx, ref.id);
      // A person's own mark (a snooze from “Remind me tomorrow”) gives way to the shared one.
      await commitAs(ctx, acknowledgeWatch, { ref, acknowledged: false });
      return { ref, state: acknowledged ? ('acknowledged' as const) : ('open' as const) };
    }
    // Watch's Bring it back also takes back the shared Ignore or snooze of the line behind it.
    if (!acknowledged) {
      const line = await sharedLine(ctx, ref);
      if (line) await quietLine(ctx, line, 'undo');
    }
    return commitAs(ctx, acknowledgeWatch, { ref, acknowledged });
  }),
  route(api.changes.list, async ({ services, access, query }) =>
    listChanges(services.db, access.principal, {
      before: query.before,
      limit: query.limit,
      thing: query.thing,
      now: services.clock(),
    }),
  ),
  route(api.changes.undo, async ({ services, access, params }) =>
    undoChange(services, access.principal, params.changeId),
  ),
  // Home's widgets, or with `thing` those kept on that thing's page (connection-pages.md CP-14).
  route(api.widgets.list, async ({ services, access, query }) => ({
    widgets: await listWidgets(services.db, access.principal, services.clock(), thingParam(query.thing)),
  })),
  // Remove and move answer the widgets of the place the widget was in.
  route(api.widgets.remove, async (ctx) => {
    const place = await widgetPlace(ctx.services.db, ctx.access.principal, ctx.params.widgetId);
    await commitAs(ctx, removeWidget, { widgetId: ctx.params.widgetId });
    return { widgets: await listWidgets(ctx.services.db, ctx.access.principal, ctx.services.clock(), place) };
  }),
  route(api.widgets.move, async (ctx) => {
    const place = await widgetPlace(ctx.services.db, ctx.access.principal, ctx.params.widgetId);
    await commitAs(ctx, moveWidget, { widgetId: ctx.params.widgetId, position: ctx.body.position });
    return { widgets: await listWidgets(ctx.services.db, ctx.access.principal, ctx.services.clock(), place) };
  }),
  // Arranging the Overview (overview-arranged.md): the person's or, through its settings, the assistant's.
  route(api.overview.arrange, async (ctx) => {
    if (ctx.access.principal.kind !== 'person' && ctx.access.principal.kind !== 'agent')
      throw new ApiError('forbidden', 'Only the person arranges the Overview.');
    return commitAs(ctx, arrangeOverview, ctx.body);
  }),
  route(api.overview.views, async (ctx) =>
    overviewViews(ctx.services, await viewerOf(ctx), ctx.access.burrow.timeZone, ctx.body.widgets),
  ),
  route(api.overview.figures, async (ctx) =>
    overviewFigures(ctx.services, await viewerOf(ctx), ctx.access.burrow.timeZone, ctx.query.thing),
  ),
];
