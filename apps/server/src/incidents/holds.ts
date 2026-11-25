import { and, eq, gt, gte, isNull, lte, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import { quietWindows, thingCauses } from '../db/schema/index';
import { CAUSE_FRESH_MS } from '../things/quiet/windows';

/**
 * Whether incident activity of a thing is ignored at `at`: it is kept quiet, or another thing is the reason. `since`: a
 * window that held at any moment from then until `at` counts too.
 */
export async function holdsIncident(
  db: Db,
  burrowId: string,
  thing: string,
  at: Date,
  since = at,
): Promise<boolean> {
  const [window] = await db
    .select({ id: quietWindows.id })
    .from(quietWindows)
    .where(
      and(
        eq(quietWindows.ownerId, burrowId),
        eq(quietWindows.thingId, thing),
        isNull(quietWindows.guestId),
        lte(quietWindows.startsAt, at),
        gt(quietWindows.endsAt, since),
        or(isNull(quietWindows.endedAt), gt(quietWindows.endedAt, since)),
      ),
    )
    .limit(1);
  if (window) return true;
  const [cause] = await db
    .select({ id: thingCauses.thingId })
    .from(thingCauses)
    .where(
      and(
        eq(thingCauses.ownerId, burrowId),
        eq(thingCauses.thingId, thing),
        gte(thingCauses.checkedAt, new Date(at.getTime() - CAUSE_FRESH_MS)),
      ),
    )
    .limit(1);
  return !!cause;
}
