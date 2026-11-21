/**
 * Kept sites (docs/decisions/kept-sites.md): a website the agent asked to stay signed in to between its turns. The
 * runner reads the site's cookies from the agent's browser; the server keeps them sealed with the box's custody key
 * (`kept-site:<id>:cookies`) and gives them back only to the runner, for the next fresh browser. The cookies are sealed
 * before the commit, so they never pass the pipeline's input, an event, a log or a person's screen.
 *
 * - `kept_site.keep` (the agent, in its turn): a site with any of the same origins is replaced. Signs
 *   `browser.site_kept` and is something the agent did in Done recently, whose Undo stops keeping it.
 * - `kept_site.forget` (the agent): every site with one of the origins goes; `browser.site_forgotten` each.
 * - `kept_site.stop` (the person, in Settings): `browser.site_stopped`.
 * - `kept_site.renew` (the runner, after a page on it was used): its cookies now, kept for its hours again. Quiet.
 * - `kept_site.expire`: expired sites are deleted the next time someone reads them. Quiet.
 *
 * Every change tells the person's apps (`vault.updated` without an entry, on `me`), so Settings reads the list again.
 */
import { type KeptCookie, type KeptSite, newId, topics } from '@whombat/core';
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { type KeptSiteRow, keptSites } from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import { homeAudience, publishHomeChanged } from '../home/notify';
import { type RecordedChange, recordChange, registerUndoer, type UndoResult } from '../home/registry';
import { forbidden, notFound } from '../lib/errors';
import type { ActorInfo } from '../read/principals';
import { ok } from '../routes/define';
import type { DispatchRow } from '../runtime/context';
import { outsidersTurn } from '../runtime/person';
import type { Services } from '../services';
import {
  cookiesForOrigins,
  forgotWords,
  keptHours,
  keptSiteExpired,
  keptUntil,
  keptWords,
  siteName,
  stoppedWords,
  uniqueOrigins,
} from './kept-site-rules';

/** The sealed cookies' AAD: bound to the row, so they open for no other. */
export const keptSiteCookiesAad = (id: string) => `kept-site:${id}:cookies`;

/** The kind of the agent's keep in Done recently, and of its Undo. */
export const KEPT_SITE_CHANGE_KIND = 'browser.kept_site';

const SiteId = z.string().min(1).max(64);
const Origins = z.array(z.string().min(1).max(300)).min(1).max(20);

/** A row as the person and the agent see it: never its cookies. */
export function keptSiteView(row: KeptSiteRow): KeptSite {
  return {
    id: row.id as KeptSite['id'],
    site: row.site,
    origins: row.origins,
    agentId: row.agentId as KeptSite['agentId'],
    hours: row.hours,
    keptAt: row.keptAt.toISOString(),
    lastUsedAt: row.lastUsedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** Seals the cookies for the row `id`. */
export function sealKeptCookies(services: Pick<Services, 'custody'>, id: string, cookies: KeptCookie[]) {
  return services.custody.seal(keptSiteCookiesAad(id), JSON.stringify(cookies));
}

/** The row's cookies; null when they don't open (another key, a damaged row). */
export function openKeptCookies(services: Pick<Services, 'custody'>, row: KeptSiteRow): KeptCookie[] | null {
  try {
    const value: unknown = JSON.parse(services.custody.open(keptSiteCookiesAad(row.id), row.cookiesSealed));
    return Array.isArray(value) ? (value as KeptCookie[]) : null;
  } catch {
    return null;
  }
}

/** Rows with any of these origins (jsonb `?|`). */
const anyOrigin = (origins: readonly string[]) =>
  sql`${keptSites.origins} ?| array[${sql.join(
    origins.map((o) => sql`${o}`),
    sql`, `,
  )}]::text[]`;

/** The person's apps read the kept sites again (no data in the frame). */
async function tellPerson(ctx: ApplyContext, doneRecently = false): Promise<string | null> {
  const person = await thePerson(ctx.tx, ctx.burrow.id);
  if (person) ctx.publish(topics.me(person.id), { type: 'vault.updated', entryId: null });
  if (doneRecently) publishHomeChanged(ctx, await homeAudience(ctx, ctx.burrow.id), ['doneRecently']);
  return person?.id ?? null;
}

/** The event's payload: ids, origins and hours, never a cookie. */
const eventPayload = (row: Pick<KeptSiteRow, 'id' | 'site' | 'origins' | 'hours'>, dispatchId?: string) => ({
  siteId: row.id,
  site: row.site,
  origins: row.origins,
  hours: row.hours,
  ...(dispatchId ? { dispatchId } : {}),
});

export const keepSite = defineCommand({
  name: 'kept_site.keep',
  schema: z.object({
    /** Made by the caller, which sealed the cookies under it. */
    id: SiteId,
    dispatchId: z.string().min(1).max(64),
    conversationId: z.string().min(1).max(64).nullable(),
    origins: Origins,
    hours: z.number().int().min(1).max(24),
    cookiesSealed: z.string().min(1),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant keeps a website signed in.');
    const origins = uniqueOrigins(input.origins);
    // The new one replaces any kept site that shares an origin with it.
    const replaced = await tx
      .delete(keptSites)
      .where(and(eq(keptSites.burrowId, ctx.burrow.id), anyOrigin(origins)))
      .returning({ id: keptSites.id });
    const expiresAt = keptUntil(ctx.now, input.hours);
    const [row] = await tx
      .insert(keptSites)
      .values({
        id: input.id,
        burrowId: ctx.burrow.id,
        agentId: ctx.actor.id,
        origins,
        site: siteName(origins),
        hours: input.hours,
        cookiesSealed: input.cookiesSealed,
        keptAt: ctx.now,
        lastUsedAt: ctx.now,
        expiresAt,
      })
      .returning();
    if (!row) throw new Error('kept site not stored');
    const words = keptWords(row.site, row.hours);
    await ctx.emit({
      type: 'browser.site_kept',
      kind: 'System',
      text: words,
      where: null,
      payload: {
        ...eventPayload(row, input.dispatchId),
        ...(replaced.length ? { replaced: replaced.map((r) => r.id) } : {}),
      },
    });
    const personId = await tellPerson(ctx, true);
    await recordChange(ctx, {
      burrowId: ctx.burrow.id,
      actorId: ctx.actor.id,
      agentId: ctx.actor.id,
      personId,
      kind: KEPT_SITE_CHANGE_KIND,
      title: words,
      subject: { kind: 'kept_site', id: row.id, name: row.site },
      undo: { kind: KEPT_SITE_CHANGE_KIND, payload: { siteId: row.id }, until: expiresAt },
      conversationId: input.conversationId,
      at: ctx.now,
    });
    return keptSiteView(row);
  },
});

export const forgetSites = defineCommand({
  name: 'kept_site.forget',
  schema: z.object({ dispatchId: z.string().min(1).max(64), origins: Origins }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant forgets a website this way.');
    const gone = await tx
      .delete(keptSites)
      .where(and(eq(keptSites.burrowId, ctx.burrow.id), anyOrigin(uniqueOrigins(input.origins))))
      .returning();
    for (const row of gone)
      await ctx.emit({
        type: 'browser.site_forgotten',
        kind: 'System',
        text: forgotWords(row.site),
        where: null,
        payload: eventPayload(row, input.dispatchId),
      });
    if (gone.length) await tellPerson(ctx);
    return gone.map(keptSiteView);
  },
});

/** Deletes the site and signs `browser.site_stopped` as the person; null when it is gone or expired. */
async function stopIn(ctx: ApplyContext, siteId: string): Promise<KeptSiteRow | null> {
  const [row] = await ctx.tx
    .delete(keptSites)
    .where(and(eq(keptSites.id, siteId), eq(keptSites.burrowId, ctx.burrow.id)))
    .returning();
  if (!row) return null;
  // An expired one was already gone for the person: deleted, nothing to sign.
  if (keptSiteExpired(row.expiresAt, ctx.now)) return null;
  await ctx.emit({
    type: 'browser.site_stopped',
    kind: 'System',
    text: stoppedWords(row.site),
    where: null,
    payload: eventPayload(row),
  });
  await tellPerson(ctx);
  return row;
}

export const stopSite = defineCommand({
  name: 'kept_site.stop',
  schema: z.object({ siteId: SiteId }),
  async apply(_tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can stop keeping a website signed in.');
    const row = await stopIn(ctx, input.siteId);
    if (!row) throw notFound('Kept website');
    return keptSiteView(row);
  },
});

export const renewSite = defineCommand({
  name: 'kept_site.renew',
  schema: z.object({ siteId: SiteId, cookiesSealed: z.string().min(1) }),
  async apply(tx, ctx, input) {
    const [row] = await tx
      .select()
      .from(keptSites)
      .where(and(eq(keptSites.id, input.siteId), eq(keptSites.burrowId, ctx.burrow.id)))
      .for('update');
    if (!row || keptSiteExpired(row.expiresAt, ctx.now)) throw notFound('Kept website');
    const [after] = await tx
      .update(keptSites)
      .set({
        cookiesSealed: input.cookiesSealed,
        lastUsedAt: ctx.now,
        expiresAt: keptUntil(ctx.now, row.hours),
      })
      .where(eq(keptSites.id, row.id))
      .returning();
    if (!after) throw notFound('Kept website');
    await tellPerson(ctx);
    return keptSiteView(after);
  },
});

export const expireSites = defineCommand({
  name: 'kept_site.expire',
  schema: z.object({ ids: z.array(SiteId).min(1).max(500) }),
  async apply(tx, ctx, input) {
    const gone = await tx
      .delete(keptSites)
      .where(
        and(
          inArray(keptSites.id, input.ids),
          eq(keptSites.burrowId, ctx.burrow.id),
          lte(keptSites.expiresAt, ctx.now),
        ),
      )
      .returning({ id: keptSites.id });
    if (gone.length) await tellPerson(ctx);
    return { expired: gone.length };
  },
});

export const KEPT_SITE_COMMANDS = [keepSite, forgetSites, stopSite, renewSite, expireSites];

/** Undo of the agent's keep in Done recently: stops keeping the site, as the person who pressed it. */
async function undoKeep(ctx: ApplyContext, change: RecordedChange, actor: ActorInfo): Promise<UndoResult> {
  if (actor.kind !== 'person') return { ok: false, reason: 'Only you can stop keeping a website signed in.' };
  const siteId = (change.undo.payload as { siteId?: unknown } | null)?.siteId;
  if (typeof siteId !== 'string') return { ok: false, reason: 'This can’t be undone any more.' };
  const row = await stopIn(ctx, siteId);
  if (!row) return { ok: false, reason: 'That website isn’t kept signed in any more.' };
  return { ok: true };
}

registerUndoer(KEPT_SITE_CHANGE_KIND, undoKeep);

// ── Reads and the runner's calls ─────────────────────────────────────────────────────────────────────────────────

/** Deletes the expired sites (of one burrow, or of the box), each burrow's in its own commit. */
async function dropExpired(services: Services, now: Date, burrowId?: string): Promise<void> {
  const expired = await services.db
    .select({ id: keptSites.id, burrowId: keptSites.burrowId, agentId: keptSites.agentId })
    .from(keptSites)
    .where(
      burrowId
        ? and(eq(keptSites.burrowId, burrowId), lte(keptSites.expiresAt, now))
        : lte(keptSites.expiresAt, now),
    )
    .limit(500);
  const byBurrow = new Map<string, { agentId: string; ids: string[] }>();
  for (const r of expired) {
    const group = byBurrow.get(r.burrowId) ?? { agentId: r.agentId, ids: [] };
    group.ids.push(r.id);
    byBurrow.set(r.burrowId, group);
  }
  for (const [id, group] of byBurrow)
    await services.pipeline.commit(expireSites, { ids: group.ids }, { burrowId: id, actorId: group.agentId });
}

/** The live sites, soonest to expire first. */
async function liveRows(db: Db | Tx, now: Date, burrowId?: string): Promise<KeptSiteRow[]> {
  return db
    .select()
    .from(keptSites)
    .where(
      burrowId
        ? and(eq(keptSites.burrowId, burrowId), gt(keptSites.expiresAt, now))
        : gt(keptSites.expiresAt, now),
    )
    .orderBy(asc(keptSites.expiresAt), asc(keptSites.id));
}

/** The burrow's kept sites, soonest to expire first (no cookies); the expired ones are deleted. */
export async function listKeptSites(services: Services, burrowId: string): Promise<KeptSite[]> {
  const now = services.clock();
  await dropExpired(services, now, burrowId);
  return (await liveRows(services.db, now, burrowId)).map(keptSiteView);
}

/** Kept sites are the person's alone: never for an outsiders' turn or a Feedback assessment. */
function assertPersonsTurn(dispatch: DispatchRow): void {
  if (outsidersTurn(dispatch) || dispatch.trigger === 'feedback')
    throw forbidden('This work came from outside, so it can’t keep websites signed in.');
}

const turnOptions = (dispatch: DispatchRow) => ({
  burrowId: dispatch.burrowId,
  actorId: dispatch.agentId,
  onBehalfOf: {},
});

/** `runner.keptSiteKeep`: the cookies the browser has for the site, sealed, and the site kept. */
export async function keepForTurn(
  services: Services,
  dispatch: DispatchRow,
  body: { origins: string[]; hours?: number | undefined; cookies: KeptCookie[] },
): Promise<KeptSite> {
  assertPersonsTurn(dispatch);
  const origins = uniqueOrigins(body.origins);
  const id = newId('keptSite');
  const cookiesSealed = sealKeptCookies(services, id, cookiesForOrigins(body.cookies, origins));
  return ok(
    await services.pipeline.commit(
      keepSite,
      {
        id,
        dispatchId: dispatch.id,
        conversationId: dispatch.conversationId,
        origins,
        hours: keptHours(body.hours),
        cookiesSealed,
      },
      turnOptions(dispatch),
    ),
  );
}

/** `runner.keptSiteForget`. */
export async function forgetForTurn(
  services: Services,
  dispatch: DispatchRow,
  origins: string[],
): Promise<KeptSite[]> {
  assertPersonsTurn(dispatch);
  return ok(
    await services.pipeline.commit(forgetSites, { dispatchId: dispatch.id, origins }, turnOptions(dispatch)),
  );
}

/** `runner.keptSiteList`. */
export async function listForTurn(services: Services, dispatch: DispatchRow): Promise<KeptSite[]> {
  assertPersonsTurn(dispatch);
  return listKeptSites(services, dispatch.burrowId);
}

/**
 * `runner.keptSiteRestore`: every live site of the box with its cookies, for a fresh browser; the expired ones are
 * deleted, and one whose cookies don't open is left out.
 */
export async function restoreKeptSites(
  services: Services,
): Promise<{ site: KeptSite; cookies: KeptCookie[] }[]> {
  const now = services.clock();
  await dropExpired(services, now);
  const out: { site: KeptSite; cookies: KeptCookie[] }[] = [];
  for (const row of await liveRows(services.db, now)) {
    const cookies = openKeptCookies(services, row);
    if (cookies) out.push({ site: keptSiteView(row), cookies });
  }
  return out;
}

/** `runner.keptSiteRenew`: 404 when the site was forgotten, stopped or has expired. */
export async function renewKeptSite(
  services: Services,
  siteId: string,
  cookies: KeptCookie[],
): Promise<KeptSite> {
  const [row] = await services.db.select().from(keptSites).where(eq(keptSites.id, siteId));
  if (!row || keptSiteExpired(row.expiresAt, services.clock())) throw notFound('Kept website');
  const cookiesSealed = sealKeptCookies(services, row.id, cookiesForOrigins(cookies, row.origins));
  return ok(
    await services.pipeline.commit(
      renewSite,
      { siteId: row.id, cookiesSealed },
      { burrowId: row.burrowId, actorId: row.agentId },
    ),
  );
}

/** `keptSites.stop`, as the person. */
export async function stopKeptSite(
  services: Services,
  burrowId: string,
  personId: string,
  siteId: string,
): Promise<KeptSite> {
  return ok(await services.pipeline.commit(stopSite, { siteId }, { burrowId, actorId: personId }));
}
