/**
 * A Custom connection's logo and page (docs/decisions/connection-looks.md): the assistant's `connection_look`, which
 * tries a logo and a page recipe and keeps them on `save`; the signed change that keeps them; and the logo Whombat looks
 * for itself right after a Custom connection is made.
 */
import {
  type ConnectionLookInput,
  type ConnectionLookOutput,
  ConnectionPage,
  pageRecipeProblems,
  ThingLogo,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import type { StoredLogo } from '../db/schema/connections-catalog';
import { burrows, catalogConnections } from '../db/schema/index';
import { homeAudience, publishHomeChanged } from '../home/notify';
import { notFound } from '../lib/errors';
import type { ToolContext } from '../mcp/tools';
import type { Services } from '../services';
import { findOwnLogo, logoFromAddress } from '../things/logo/find';
import { displayName } from '../things/part-of';
import { RECIPE_CATALOG_IDS, readAll, recipeBuilt } from '../things/recipe/kind';
import { TRACKER_CATALOG_ID } from '../trackers/connection';
import { ownTurn } from '../vault/self-serve';
import type { CatalogConnectionRow } from './types';

type Output = z.infer<typeof ConnectionLookOutput>;
type Refused = Extract<Output, { status: 'refused' }>;
const refuse = (reason: Refused['reason'], message: string): Refused => ({
  status: 'refused',
  reason,
  message,
});

/**
 * The logo a connection shows, when it has one this version can draw: a talked-in connection's, or a report tracker's
 * (its driver's, stored on the connection).
 */
export function logoOf(row: Pick<CatalogConnectionRow, 'catalogId' | 'logo'>): ThingLogo | undefined {
  if ((!RECIPE_CATALOG_IDS.has(row.catalogId) && row.catalogId !== TRACKER_CATALOG_ID) || !row.logo)
    return undefined;
  const parsed = ThingLogo.safeParse(row.logo.logo);
  return parsed.success ? parsed.data : undefined;
}

/* The change ---------------------------------------------------------------------------------------------------------- */

export const setConnectionLook = defineCommand({
  name: 'catalog_connection.set_look',
  schema: z.object({
    connectionId: z.string(),
    /** Absent: unchanged; null: the entry's mark again. */
    logo: z
      .object({ logo: ThingLogo, from: z.string().max(500), at: z.string() })
      .nullable()
      .optional(),
    /** Absent: unchanged; null: the generic page again. */
    page: ConnectionPage.nullable().optional(),
  }),
  // Whombat's own page of the connection, not the service: anyone in the burrow's turns may set it, signed.
  requiredKey: () => null,
  async apply(tx: Tx, ctx: ApplyContext, input) {
    const [before] = await tx
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, input.connectionId))
      .for('update');
    if (!before || before.burrowId !== ctx.burrow.id || !RECIPE_CATALOG_IDS.has(before.catalogId))
      throw notFound('Connection');
    const set: Partial<typeof catalogConnections.$inferInsert> = {};
    const what: string[] = [];
    if (input.logo !== undefined) {
      set.logo = input.logo as StoredLogo | null;
      what.push('logo');
    }
    if (input.page !== undefined) {
      set.page = input.page;
      what.push('page');
    }
    if (!what.length) return { row: before };
    const [row] = await tx
      .update(catalogConnections)
      .set({ ...set, updatedAt: ctx.now })
      .where(eq(catalogConnections.id, before.id))
      .returning();
    if (!row) throw notFound('Connection');
    const name = displayName(row);
    const text = lookText(name, input.logo, input.page, !!before.page);
    await ctx.emit({
      type: 'connection.changed',
      kind: 'System',
      text,
      where: 'Settings · Connections',
      payload: { connectionId: row.id, catalogId: row.catalogId, handle: row.handle, what },
    });
    publishHomeChanged(ctx, await homeAudience(ctx, ctx.burrow.id), ['things']);
    return { row };
  },
});

function lookText(name: string, logo: unknown, page: unknown, hadPage: boolean): string {
  const parts: string[] = [];
  if (logo !== undefined) parts.push(logo ? `gave ${name} its logo` : `took ${name}’s logo away`);
  if (page !== undefined)
    parts.push(
      page ? (hadPage ? `changed ${name}’s page` : `made ${name}’s page`) : `took ${name}’s page away`,
    );
  const s = parts.join(' and ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* The logo Whombat finds itself --------------------------------------------------------------------------------------- */

/**
 * Right after a Custom connection is made: its service's own logo, in the background, kept as a change by whoever made
 * the connection. Nothing is kept when none is found or the connection got one meanwhile.
 */
export function findLogoLater(services: Services, row: CatalogConnectionRow, actorId: string): void {
  if (!RECIPE_CATALOG_IDS.has(row.catalogId) || row.logo) return;
  services.background.run('connection: its own logo', async () => {
    const found = await findOwnLogo(services, row).catch(() => null);
    if (!found?.ok) return;
    const [now] = await services.db
      .select({ logo: catalogConnections.logo })
      .from(catalogConnections)
      .where(eq(catalogConnections.id, row.id));
    if (!now || now.logo) return;
    await services.pipeline.commit(
      setConnectionLook,
      {
        connectionId: row.id,
        logo: { logo: found.logo, from: found.from, at: services.clock().toISOString() },
      },
      { burrowId: row.burrowId, actorId },
    );
  });
}

/* The tool -------------------------------------------------------------------------------------------------------------- */

/** The burrow's connection by id or by name. */
async function connectionNamed(
  ctx: ToolContext,
  named: string,
): Promise<CatalogConnectionRow | 'many' | null> {
  const rows = await ctx.services.db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.burrowId, ctx.burrowId));
  const byId = rows.find((r) => r.id === named);
  if (byId) return byId;
  const want = named.trim().toLowerCase();
  const matches = rows.filter((r) => r.label.toLowerCase() === want || displayName(r).toLowerCase() === want);
  if (matches.length > 1) {
    const custom = matches.filter((r) => RECIPE_CATALOG_IDS.has(r.catalogId));
    return custom.length === 1 ? (custom[0] as CatalogConnectionRow) : 'many';
  }
  return matches[0] ?? null;
}

async function timeZoneOf(ctx: ToolContext): Promise<string> {
  const [b] = await ctx.services.db
    .select({ timeZone: burrows.timeZone })
    .from(burrows)
    .where(eq(burrows.id, ctx.burrowId));
  return b?.timeZone ?? 'UTC';
}

/** A Zod refusal in a few lines the assistant can act on. */
function issuesText(err: z.ZodError): string {
  return err.issues
    .slice(0, 6)
    .map((i) => `${i.path.length ? i.path.join('.') : 'page'}: ${i.message}`)
    .join('; ');
}

export async function connectionLookTool(ctx: ToolContext, input: ConnectionLookInput): Promise<Output> {
  const { services } = ctx;
  const turn = await ownTurn(services.db, ctx);
  if (!turn) return refuse('not_here', 'Only in a turn for the person, in their own chat.');
  const row = await connectionNamed(ctx, input.connection);
  if (row === 'many')
    return refuse('not_found', `More than one connection is called “${input.connection}”: give its id.`);
  if (!row) return refuse('not_found', `There is no connection called “${input.connection}”.`);
  if (!RECIPE_CATALOG_IDS.has(row.catalogId))
    return refuse(
      'not_custom',
      `${displayName(row)} is a service Whombat knows: it has its own logo and page.`,
    );

  // The logo.
  let logo: { logo: ThingLogo; from: string } | null | undefined;
  if (input.logo !== undefined) {
    if (input.logo.toLowerCase() === 'none') logo = null;
    else {
      const found = await logoFromAddress(services, input.logo);
      if (!found.ok) return refuse('logo', found.message);
      logo = { logo: found.logo, from: found.from };
    }
  }

  // The page.
  let page: ConnectionPage | null | undefined;
  let shows: { shows: string[]; problems: string[] } | null = null;
  if (input.page !== undefined) {
    if (input.page === null) page = null;
    else {
      const parsed = ConnectionPage.safeParse(input.page);
      if (!parsed.success)
        return refuse('invalid', `The page recipe doesn’t fit: ${issuesText(parsed.error)}`);
      const wrong = pageRecipeProblems(parsed.data);
      if (wrong.length) return refuse('page', wrong.join(' '));
      page = parsed.data;
    }
  }
  const tried =
    page ?? (input.page === undefined && row.page ? ConnectionPage.safeParse(row.page).data : null);
  if (tried) {
    const { answers } = await readAll(services, row, tried, { fresh: true });
    const built = await recipeBuilt(services, row, tried, answers, services.clock(), await timeZoneOf(ctx));
    const problems = [...built.problems];
    if (!built.shows.length) problems.push('The page would show nothing.');
    shows = { shows: built.shows, problems };
  }

  const keep = input.save === true && (logo !== undefined || page !== undefined);
  // A page that would show something wrong isn't kept; the assistant fixes it first.
  const pageOk = page === undefined || page === null || (shows !== null && shows.problems.length === 0);
  let saved = false;
  if (keep && pageOk) {
    const res = await services.pipeline.commit(
      setConnectionLook,
      {
        connectionId: row.id,
        ...(logo !== undefined
          ? { logo: logo ? { ...logo, at: services.clock().toISOString() } : null }
          : {}),
        ...(page !== undefined ? { page } : {}),
      },
      { burrowId: ctx.burrowId, actorId: ctx.agentId, onBehalfOf: ctx.onBehalfOf },
    );
    saved = res.status === 'ok';
  }
  const current = logo !== undefined ? logo : row.logo ? { logo: row.logo.logo, from: row.logo.from } : null;
  return {
    status: 'ok',
    connectionId: row.id as Extract<Output, { status: 'ok' }>['connectionId'],
    saved,
    logo: current ? { from: current.from, shapes: current.logo.shapes.length } : null,
    ...(shows ? { page: shows } : {}),
  };
}

/** Whether the burrow has a Custom connection (`connection_look` is served only then). */
export async function hasCustomConnection(db: Db, burrowId: string): Promise<boolean> {
  const rows = await db
    .select({ catalogId: catalogConnections.catalogId })
    .from(catalogConnections)
    .where(eq(catalogConnections.burrowId, burrowId));
  return rows.some((r) => RECIPE_CATALOG_IDS.has(r.catalogId));
}
