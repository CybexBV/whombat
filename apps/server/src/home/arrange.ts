/**
 * Arranging the Overview (docs/decisions/overview-arranged.md): one layout for the whole Whombat, kept on its burrow
 * row and sent with `home.overview`; what its tiles and figures show, read the way the desk's screens read their
 * widgets (`WidgetResolver`, the things' and accounts' figures and panels); and what a tile can show, the screens'
 * *Add a widget* for things and accounts.
 */
import {
  DESK_SCREEN_VIEWS_MAX,
  type DeskCatalog,
  type DeskWidgetRef,
  type DeskWidgetSpec,
  type DeskWidgetView,
  OverviewLayout,
  overviewLayoutProblem,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import type { ConnectionViewer } from '../connections/store';
import { burrows, principals } from '../db/schema/index';
import { isAccountRef } from '../desk/widgets/accounts';
import { screenViews, WidgetResolver } from '../desk/widgets/resolve';
import { createThingWidgets } from '../desk/widgets/things';
import type { ThingWidgets, WidgetCtx } from '../desk/widgets/types';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';
import { publishHomeChanged } from './notify';

/** How long `overview.views` waits for a tile never read before (the rest arrive on its next read). */
export const OVERVIEW_VIEWS_WAIT_MS = 2_500;

/** The layout as kept, or null when it was never arranged or can't be read any more (the page starts over). */
export function arrangedOf(row: { overviewLayout: unknown }): OverviewLayout | null {
  if (!row.overviewLayout) return null;
  const parsed = OverviewLayout.safeParse(row.overviewLayout);
  return parsed.success ? parsed.data : null;
}

/**
 * `overview.arrange`: the whole layout, written as sent. The person's (the assistant acts through its own settings
 * permission, `change`), never a screen's. The Overview reads again on every device (`home.changed {things}`).
 */
export const arrangeOverview = defineCommand({
  name: 'arrange_overview',
  schema: z.object({ layout: OverviewLayout }),
  async apply(tx, ctx, input) {
    const problem = overviewLayoutProblem(input.layout);
    if (problem) throw new ApiError('validation_failed', `This Overview can’t be kept: ${problem}.`);
    await tx.update(burrows).set({ overviewLayout: input.layout }).where(eq(burrows.id, ctx.burrow.id));
    // The person's devices read the Overview again, also when the assistant arranged it.
    const people = await tx
      .select({ id: principals.id })
      .from(principals)
      .where(and(eq(principals.burrowId, ctx.burrow.id), eq(principals.kind, 'person')));
    publishHomeChanged(
      ctx,
      people.map((p) => p.id),
      ['things'],
    );
    return { arranged: input.layout };
  },
});

/* What tiles show -------------------------------------------------------------------------------------------------- */

interface OverviewReads {
  things: ThingWidgets;
  resolver: WidgetResolver;
}

/** One reader per runtime: its kept views are what makes reading every tile each minute cheap. */
const READS = new WeakMap<Services, OverviewReads>();

function readsOf(services: Services): OverviewReads {
  let reads = READS.get(services);
  if (!reads) {
    const things = createThingWidgets(services);
    reads = { things, resolver: new WidgetResolver(services, () => things) };
    READS.set(services, reads);
  }
  return reads;
}

function ctxOf(services: Services, viewer: ConnectionViewer, timeZone: string): WidgetCtx {
  // Things' and accounts' views never name the assistant (only Whombat's own widgets do).
  return { services, viewer, now: services.clock(), timeZone, assistant: 'Your assistant' };
}

/** A tile's or a figure's widget: a thing's or an account's figures or panel. Anything else isn't the Overview's. */
function isTileSpec(spec: DeskWidgetSpec): boolean {
  if (spec.type !== 'figures' && spec.type !== 'panel') return false;
  const kind = spec.ref?.slice(0, spec.ref.indexOf(':'));
  return kind === 'connection' || kind === 'device' || kind === 'account';
}

/**
 * `overview.views`: the views of the tiles' and figures' widgets now, as the viewer may see them (unlocked: the Overview
 * is the person's own). Widgets never read are waited for a moment; one that can't be read says why in its view.
 */
export async function overviewViews(
  services: Services,
  viewer: ConnectionViewer,
  timeZone: string,
  widgets: readonly DeskWidgetSpec[],
): Promise<{ views: DeskWidgetView[] }> {
  const specs = widgets.filter(isTileSpec).slice(0, DESK_SCREEN_VIEWS_MAX);
  if (!specs.length) return { views: [] };
  const { resolver } = readsOf(services);
  const resolved = await resolver.resolve(
    ctxOf(services, viewer, timeZone),
    specs,
    null,
    OVERVIEW_VIEWS_WAIT_MS,
  );
  return {
    views: screenViews(specs, resolved, 'everything', (message, id) =>
      services.log.warn({ widget: id }, message),
    ),
  };
}

/**
 * `overview.figures`: what tiles can show — every connection's, device's and account's figures and panels; with
 * `thing`, only that one's, its page read now.
 */
export async function overviewFigures(
  services: Services,
  viewer: ConnectionViewer,
  timeZone: string,
  thing?: DeskWidgetRef,
): Promise<DeskCatalog> {
  const { things, resolver } = readsOf(services);
  const ctx = ctxOf(services, viewer, timeZone);
  if (thing) {
    const groups = isAccountRef(thing)
      ? await resolver.accounts.groups(ctx, thing)
      : await things.groups(ctx, thing);
    return { groups: groups.slice(0, 200) };
  }
  const [thingGroups, accountGroups] = await Promise.all([
    things.groups(ctx).catch((err) => {
      services.log.warn({ err: String(err) }, 'overview: the things’ figures weren’t listed');
      return [];
    }),
    resolver.accounts.groups(ctx).catch((err) => {
      services.log.warn({ err: String(err) }, 'overview: the accounts’ figures weren’t listed');
      return [];
    }),
  ]);
  return { groups: [...thingGroups, ...accountGroups].slice(0, 200) };
}
