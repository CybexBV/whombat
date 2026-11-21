/**
 * Services link to each other (service-dashboards.md SD-10, SD-S08): Seerr's request in progress links to SABnzbd's page,
 * Sonarr's and Radarr's queue rows to SABnzbd, NZBHydra2's grabs to the app that asked. `siblingThing` finds the first
 * connection of those kinds in the burrow — an active one before one that isn't, then by name — and gives its page's
 * href; nothing when there is none.
 */
import { thingHref } from '@whombat/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { catalogConnections } from '../db/schema/index';
import type { Services } from '../services';
import { displayName } from './part-of';

/** Another connection's page: where to link and what to call it (“SABnzbd”). */
export interface SiblingThing {
  href: string;
  name: string;
}

/** The first connection of `catalogIds` in the burrow (SD-S08), or null. */
export async function siblingThing(
  ctx: { services: Pick<Services, 'db'>; burrowId: string },
  catalogIds: readonly string[],
): Promise<SiblingThing | null> {
  if (!catalogIds.length) return null;
  const [row] = await ctx.services.db
    .select({
      id: catalogConnections.id,
      label: catalogConnections.label,
      catalogId: catalogConnections.catalogId,
      fields: catalogConnections.fields,
    })
    .from(catalogConnections)
    .where(
      and(
        inArray(catalogConnections.catalogId, [...catalogIds]),
        eq(catalogConnections.burrowId, ctx.burrowId),
      ),
    )
    .orderBy(
      sql`case when ${catalogConnections.status} = 'active' then 0 else 1 end`,
      asc(sql`lower(${catalogConnections.label})`),
      asc(catalogConnections.createdAt),
    )
    .limit(1);
  return row ? { href: thingHref('connection', row.id), name: displayName(row).slice(0, 120) } : null;
}
