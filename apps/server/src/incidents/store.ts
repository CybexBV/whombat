/**
 * Incidents kept (docs/decisions/monitoring.md MON-06, MON-09) and the signed commands that move them, both as the
 * burrow's Servers signer (“Whombat”: what its monitoring does by itself):
 *
 * - **`incidents.pass`** (the watcher, `watch.ts`): opens, worsens and ends incidents as a pass planned (`plan.ts`).
 *   Opening signs `thing.down` or `thing.problem`, a problem going down `thing.down`, ending `thing.back`
 *   (`ThingIncidentEvent`, no text: they show in no feed), and automations are nudged. When the last incident a push
 *   named ends, its push is withdrawn quietly: its inbox row is read, and on a managed Whombat the phone's notification
 *   goes (a content-free clear). Nothing says it's back. Home's `things` hears of each opening, worsening and end, so
 *   an open page's “What happened” reads again.
 * - **`incidents.push`** (the watcher): marks the incidents one push names as pushed, then sends it through the
 *   notifications (Do not disturb and quiet hours hold it as any other). Whether each is still open and not kept quiet
 *   or down because of something else is checked again in its commit, and its words name only those left.
 */
import {
  INCIDENTS_KEEP_DAYS,
  type IncidentNature,
  newId,
  parseThingId,
  THING_BACK,
  THING_DOWN,
  THING_PROBLEM,
  ThingIncidentEvent,
} from '@whombat/core';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import { managedAppOrigin } from '../config';
import type { Db, Tx } from '../db/client';
import {
  catalogConnections,
  type IncidentRow,
  incidents,
  lookResearches,
  notifications,
} from '../db/schema/index';
import { linkOfMessage } from '../domain/links';
import { publishNotificationsRead } from '../domain/notification-read';
import { notify } from '../domain/notify';
import { GENERIC_PUSH_TITLE } from '../domain/push-preview';
import { thePerson } from '../domain/the-person';
import { homeAudience, publishHomeChanged } from '../home/notify';
import { SYSTEM_SERVERS } from '../hosts/principal';
import { forbidden } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadPrincipalRow } from '../read/principals';
import { holdsIncident } from './holds';
import { incidentPushText, type OpenIncident, pushOrder } from './plan';
import { claimThingWatches, deliverThingWatches } from './thing-watch';

/** Incidents are kept this long after they ended. */
export const INCIDENTS_KEEP_MS = INCIDENTS_KEEP_DAYS * 24 * 60 * 60_000;

/** The push's inbox key and its group on the phone: one per push. */
export const pushKey = (group: string) => `incident:${group}`;

const Kind = z.enum(['server', 'connection', 'device']);
const Nature = z.enum(['down', 'problem']);
const Cause = z.object({ thing: z.string().min(3).max(220), name: z.string().min(1).max(120) }).nullable();

const Opened = z.object({
  thing: z.string().min(3).max(220),
  kind: Kind,
  name: z.string().min(1).max(120),
  nature: Nature,
  words: z.string().min(1).max(200),
  check: z.string().max(80).nullable(),
  subject: z.string().max(160),
  cause: Cause,
  startedAt: z.iso.datetime({ offset: true }),
  /** Bad before Whombat watched: kept as told, so it never pushes. */
  pushed: z.boolean().optional(),
});
const Changed = z.object({
  id: z.string().min(1).max(80),
  nature: Nature,
  words: z.string().min(1).max(200),
  cause: Cause,
  worse: z.boolean(),
  check: z.string().max(80).nullable().optional(),
  subject: z.string().max(160).optional(),
});
const Ended = z.object({ id: z.string().min(1).max(80), endedAt: z.iso.datetime({ offset: true }) });

async function requireSigner(tx: Tx, actorId: string): Promise<void> {
  const row = await loadPrincipalRow(tx, actorId);
  if (row?.system !== SYSTEM_SERVERS) throw forbidden('Only Whombat’s monitoring keeps outages.');
}

/** The event an incident signs, its payload checked. */
async function sign(ctx: ApplyContext, type: string, row: IncidentRow): Promise<void> {
  const target = parseThingId(row.thingId);
  const [connection] =
    target?.kind === 'connection'
      ? await ctx.tx
          .select({ catalogId: catalogConnections.catalogId })
          .from(catalogConnections)
          .where(and(eq(catalogConnections.id, target.id), eq(catalogConnections.burrowId, row.burrowId)))
      : [];
  const payload = ThingIncidentEvent.parse({
    incidentId: row.id,
    thing: row.thingId,
    kind: row.kind,
    name: row.name.slice(0, 120),
    nature: row.nature,
    words: row.words.slice(0, 200),
    ...(connection ? { catalogId: connection.catalogId } : {}),
    ...(row.checkId ? { check: row.checkId } : {}),
    startedAt: row.startedAt.toISOString(),
    ...(row.endedAt ? { endedAt: row.endedAt.toISOString() } : {}),
    ...(row.causeThing && row.causeName ? { cause: { thing: row.causeThing, name: row.causeName } } : {}),
  });
  const event = await ctx.emit({
    type,
    kind: 'System',
    text: null,
    where: null,
    payload,
  });
  if (await claimThingWatches(ctx, type, payload, event.id))
    ctx.background(
      'thing watch replies',
      () => deliverThingWatches(ctx.services, ctx.burrow.id),
      `thing-watches:${ctx.burrow.id}`,
    );
}

/**
 * Withdraws the pushes whose incidents all ended: their inbox rows read (and the person's devices told), the phone's
 * notification cleared on a managed Whombat. Quietly: nothing new is said.
 */
async function withdrawPushes(ctx: ApplyContext, groups: readonly string[]): Promise<void> {
  if (!groups.length) return;
  const stillOpen = await ctx.tx
    .select({ group: incidents.pushGroup })
    .from(incidents)
    .where(
      and(
        eq(incidents.burrowId, ctx.burrow.id),
        inArray(incidents.pushGroup, [...groups]),
        isNull(incidents.endedAt),
      ),
    );
  const open = new Set(stillOpen.map((r) => r.group));
  const done = groups.filter((g) => !open.has(g));
  if (!done.length) return;
  await ctx.tx
    .update(incidents)
    .set({ withdrawnAt: ctx.now })
    .where(and(eq(incidents.burrowId, ctx.burrow.id), inArray(incidents.pushGroup, done)));
  const read = await ctx.tx
    .update(notifications)
    .set({ readAt: ctx.now })
    .where(
      and(
        eq(notifications.burrowId, ctx.burrow.id),
        inArray(notifications.dedupKey, done.map(pushKey)),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id, principalId: notifications.principalId });
  const byPerson = new Map<string, string[]>();
  for (const r of read) byPerson.set(r.principalId, [...(byPerson.get(r.principalId) ?? []), r.id]);
  for (const [principalId, ids] of byPerson) await publishNotificationsRead(ctx, principalId, { ids });
  const control = ctx.services.push.control;
  const person = await thePerson(ctx.tx, ctx.burrow.id);
  if (!control || !person) return;
  const slug = ctx.burrow.slug;
  ctx.background('incident push withdrawn', async () => {
    for (const group of done)
      await control(
        [person.id],
        {
          burrow: slug,
          notificationId: null,
          kind: 'needs_you',
          title: GENERIC_PUSH_TITLE,
          body: '',
          path: `/${slug}`,
        },
        { group: pushKey(group), clear: true },
      );
  });
}

/** Opens, worsens and ends incidents as the watcher's pass planned. */
export const incidentsPass = defineCommand({
  name: 'incidents.pass',
  schema: z.object({
    opened: z.array(Opened).max(200),
    changed: z.array(Changed).max(200),
    ended: z.array(Ended).max(200),
  }),
  async apply(tx, ctx, input) {
    await requireSigner(tx, ctx.actor.id);
    let signed = 0;
    for (const o of input.opened) {
      const [row] = await tx
        .insert(incidents)
        .values({
          id: newId('incident'),
          burrowId: ctx.burrow.id,
          thingId: o.thing,
          kind: o.kind,
          name: o.name,
          nature: o.nature,
          words: o.words,
          checkId: o.check,
          subject: o.subject,
          startedAt: new Date(o.startedAt),
          causeThing: o.cause?.thing ?? null,
          causeName: o.cause?.name ?? null,
          // Told without a push of its own: no group, so it counts in no day's pushes and nothing is withdrawn.
          ...(o.pushed ? { pushedAt: ctx.now } : {}),
        })
        // Opened by another pass meanwhile: that one stands.
        .onConflictDoNothing()
        .returning();
      if (!row) continue;
      await sign(ctx, row.nature === 'down' ? THING_DOWN : THING_PROBLEM, row);
      signed++;
    }
    for (const c of input.changed) {
      const [row] = await tx
        .update(incidents)
        .set({
          nature: c.nature,
          words: c.words,
          ...(c.check === undefined ? {} : { checkId: c.check, subject: c.subject ?? '' }),
          ...(c.cause ? { causeThing: c.cause.thing, causeName: c.cause.name } : {}),
        })
        .where(and(eq(incidents.id, c.id), eq(incidents.burrowId, ctx.burrow.id), isNull(incidents.endedAt)))
        .returning();
      if (row && c.worse) {
        await sign(ctx, THING_DOWN, row);
        signed++;
      }
    }
    let moved = signed > 0;
    const groups: string[] = [];
    for (const e of input.ended) {
      const [row] = await tx
        .update(incidents)
        .set({ endedAt: new Date(e.endedAt) })
        .where(and(eq(incidents.id, e.id), eq(incidents.burrowId, ctx.burrow.id), isNull(incidents.endedAt)))
        .returning();
      if (!row) continue;
      await sign(ctx, THING_BACK, row);
      signed++;
      moved = true;
      if (row.pushGroup && !row.withdrawnAt) groups.push(row.pushGroup);
    }
    await withdrawPushes(ctx, [...new Set(groups)]);
    // An open page's “What happened” reads again when an outage opens, gets worse or ends.
    if (moved) publishHomeChanged(ctx, await homeAudience(ctx, ctx.burrow.id), ['things']);
    const services = ctx.services;
    if (signed) ctx.after(async () => services.automations.nudge());
    return { signed };
  },
});

/** Where a tap on the push opens: the thing's look thread when it has one, else its page; for several, the Inbox. */
async function pushLink(ctx: ApplyContext, group: readonly IncidentRow[]) {
  const [one] = group;
  if (group.length === 1 && one) {
    const [research] = await ctx.tx
      .select({ conversationId: lookResearches.conversationId, root: lookResearches.threadRootId })
      .from(lookResearches)
      .where(
        and(
          eq(lookResearches.burrowId, ctx.burrow.id),
          eq(lookResearches.lookKey, one.thingId),
          isNotNull(lookResearches.threadRootId),
        ),
      )
      .orderBy(desc(lookResearches.startedAt))
      .limit(1);
    const conversation = research?.conversationId
      ? await loadConversationRow(ctx.tx, research.conversationId)
      : null;
    if (research?.root && conversation)
      return {
        link: await linkOfMessage(ctx.tx, conversation, research.root, research.root),
        messageId: research.root,
      };
  }
  const path = one && group.length === 1 ? `/things/${encodeURIComponent(one.thingId)}` : '/inbox';
  try {
    return { link: { type: 'external' as const, url: `${managedAppOrigin(ctx.services.config)}${path}` } };
  } catch {
    // No app address configured (a development box): the person's Chat.
    return { link: { type: 'dm' as const } };
  }
}

/**
 * Marks the incidents one push names as pushed (one group), then sends it: one inbox row and one push for the person,
 * “Needs you”. Incidents already pushed, ended, with a cause, or kept quiet or down because of something else meanwhile
 * are left out, and the words name only those still in it.
 */
export const incidentsPush = defineCommand({
  name: 'incidents.push',
  schema: z.object({ ids: z.array(z.string().min(1).max(80)).min(1).max(50) }),
  async apply(tx, ctx, input) {
    await requireSigner(tx, ctx.actor.id);
    const candidates = await tx
      .select()
      .from(incidents)
      .where(
        and(
          eq(incidents.burrowId, ctx.burrow.id),
          inArray(incidents.id, input.ids),
          isNull(incidents.pushedAt),
          isNull(incidents.endedAt),
          isNull(incidents.causeThing),
        ),
      )
      .for('update');
    const ids: string[] = [];
    for (const row of candidates)
      if (!(await holdsIncident(tx, ctx.burrow.id, row.thingId, ctx.now))) ids.push(row.id);
    const person = await thePerson(tx, ctx.burrow.id);
    if (!ids.length || !person) return { pushed: 0 };
    const group = newId('incident');
    const rows = (
      await tx
        .update(incidents)
        .set({ pushedAt: ctx.now, pushGroup: group })
        .where(and(eq(incidents.burrowId, ctx.burrow.id), inArray(incidents.id, ids)))
        .returning()
    ).sort((a, b) => pushOrder(openIncidentOf(a), openIncidentOf(b)));
    if (!rows.length) return { pushed: 0 };
    const { link, messageId } = { messageId: undefined, ...(await pushLink(ctx, rows)) };
    const draft = {
      burrowId: ctx.burrow.id,
      burrowSlug: ctx.burrow.slug,
      principalId: person.id,
      kind: 'needs_you' as const,
      actorId: ctx.actor.id,
      where: rows.length === 1 ? (rows[0] as IncidentRow).name.slice(0, 120) : 'Overview',
      text: incidentPushText(rows.map(openIncidentOf)),
      link,
      createdAt: ctx.now,
      dedupKey: pushKey(group),
      ...(messageId ? { messageId } : {}),
      group: pushKey(group),
    };
    const services = ctx.services;
    ctx.background('incident push', () => notify(services, [draft]));
    return { pushed: rows.length };
  },
});

export const INCIDENT_COMMANDS = [incidentsPass, incidentsPush];

/* Reads ------------------------------------------------------------------------------------------------------------- */

/** A burrow's open incidents. */
export async function openIncidents(db: Db | Tx, burrowId: string): Promise<IncidentRow[]> {
  return db
    .select()
    .from(incidents)
    .where(and(eq(incidents.burrowId, burrowId), isNull(incidents.endedAt)))
    .orderBy(incidents.startedAt);
}

/** Whether a burrow has any incident kept (open or within the last 90 days). */
export async function anyIncident(db: Db | Tx, burrowId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: incidents.id })
    .from(incidents)
    .where(eq(incidents.burrowId, burrowId))
    .limit(1);
  return !!row;
}

/** An incident row as the planner weighs it. */
export function openIncidentOf(row: IncidentRow): OpenIncident {
  return {
    id: row.id,
    thing: row.thingId,
    kind: row.kind,
    name: row.name,
    nature: row.nature as IncidentNature,
    words: row.words,
    startedAt: row.startedAt,
    cause: row.causeThing && row.causeName ? { thing: row.causeThing, name: row.causeName } : null,
    pushedAt: row.pushedAt,
  };
}

/**
 * The incidents of a burrow (one thing's, or all) that overlap `[from, now]`: started since, or still open, or ended
 * since; newest first.
 */
export async function incidentsSince(
  db: Db | Tx,
  burrowId: string,
  from: Date,
  thing?: string,
  limit = 500,
): Promise<IncidentRow[]> {
  return db
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.burrowId, burrowId),
        thing ? eq(incidents.thingId, thing) : undefined,
        or(gte(incidents.startedAt, from), isNull(incidents.endedAt), gte(incidents.endedAt, from)),
      ),
    )
    .orderBy(desc(incidents.startedAt))
    .limit(limit);
}

/** When a research finding was last pushed about each thing (its look's key) since `from`, in ms. */
export async function findingsPushedSince(
  db: Db | Tx,
  burrowId: string,
  from: Date,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ key: lookResearches.lookKey, at: lookResearches.pushedAt })
    .from(lookResearches)
    .where(and(eq(lookResearches.burrowId, burrowId), gte(lookResearches.pushedAt, from)));
  const out = new Map<string, number>();
  for (const r of rows) if (r.at) out.set(r.key, Math.max(out.get(r.key) ?? 0, r.at.getTime()));
  return out;
}

/** The pushes made since `from` (the start of the person's day): how many, and of each thing. */
export async function pushesSince(
  db: Db | Tx,
  burrowId: string,
  from: Date,
): Promise<{ total: number; of: Map<string, number> }> {
  const rows = await db
    .select({ thing: incidents.thingId, group: incidents.pushGroup })
    .from(incidents)
    .where(
      and(eq(incidents.burrowId, burrowId), gte(incidents.pushedAt, from), isNotNull(incidents.pushGroup)),
    );
  const of = new Map<string, number>();
  for (const r of rows) of.set(r.thing, (of.get(r.thing) ?? 0) + 1);
  return { total: new Set(rows.map((r) => r.group)).size, of };
}

/** Removes incidents that ended more than 90 days ago. */
export async function pruneIncidents(db: Db | Tx, now: Date): Promise<void> {
  await db.delete(incidents).where(lt(incidents.endedAt, new Date(now.getTime() - INCIDENTS_KEEP_MS)));
}
