/**
 * Setting where this Whombat is (docs/decisions/weather-news.md): the person (`burrow.manage`), or the assistant for them
 * through its settings tools, keeps a place from `place.find`, or goes back to the time zone's guess. Its latitude and
 * longitude are kept to two decimals. One `burrow.updated` (System), and the burrow published; nothing when it already is.
 */
import { PlaceSetBody, placeLabel, roundPlace } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { burrowWhere, publishBurrow } from '../commands/burrows';
import { defineCommand } from '../commit/types';
import { burrows } from '../db/schema/index';

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export const setPlace = defineCommand({
  name: 'set_place',
  schema: PlaceSetBody,
  requiredKey: () => ({ keyId: 'burrow.manage' as const, attempt: 'set where this Whombat is', where: null }),
  async apply(tx, ctx, input) {
    const place = input.place ? roundPlace(input.place) : null;
    if (same(place, ctx.burrow.place)) return { eventId: null as string | null };
    const [row] = await tx.update(burrows).set({ place }).where(eq(burrows.id, ctx.burrow.id)).returning();
    const event = await ctx.emit({
      type: 'burrow.updated',
      kind: 'System',
      // The place's name and region only: never its latitude and longitude in the log.
      text: place
        ? `Set where this Whombat is to ${placeLabel(place)}`
        : 'Set where this Whombat is back to its time zone’s guess',
      where: burrowWhere(ctx.services, ctx.burrow.slug),
      payload: { place: place ? { name: place.name, country: place.country } : null },
    });
    if (row) {
      ctx.burrow = row;
      await publishBurrow(ctx, row, event.id);
    }
    return { eventId: event.id as string | null };
  },
});
