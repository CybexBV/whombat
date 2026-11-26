/**
 * Where this Whombat is in Settings → This Whombat (docs/decisions/weather-news.md): `place.find` looks a place up on
 * OpenStreetMap, `place.set` keeps one (or goes back to the time zone's guess) and answers the burrow.
 */
import { api } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { burrows } from '../db/schema/index';
import { notFound } from '../lib/errors';
import { burrowView } from '../read/views';
import { commitAs } from '../routes/burrows';
import { type RouteDef, route } from '../routes/define';
import { setPlace } from './commands';
import { placeFinderFor } from './nominatim';

export const placeRoutes: RouteDef[] = [
  route(api.place.find, async ({ services, query }) => ({
    places: await placeFinderFor(services).find(query),
  })),
  route(api.place.set, async (ctx) => {
    await commitAs(ctx, setPlace, ctx.body);
    const [row] = await ctx.services.db.select().from(burrows).where(eq(burrows.id, ctx.access.burrow.id));
    if (!row) throw notFound('Whombat');
    return { burrow: await burrowView(ctx.services.db, row) };
  }),
];
