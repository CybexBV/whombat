/**
 * Incidents kept and the signed commands that move them, both as the
 * burrow's Servers signer (“Whombat”: what its monitoring does by itself):
 *
 * - **`incidents.pass`** (the watcher, `watch.ts`): opens, worsens and ends incidents as a pass planned (`plan.ts`).
 *   Opening signs `thing.down` or `thing.problem`, a problem going down `thing.down`, each other bad check counting
 *   on it (at the start or later) `thing.problem` once, carrying that check, and ending `thing.back`
 *   (`ThingIncidentEvent`, no text: they show in no feed); automations are nudged. A `down` incident's thing that
 *   answers again, or stops again, while the incident stays open closes or opens a stretch of its down time. An
 *   incident whose thing was removed ends without `thing.back`: it didn't come back. When the last incident a push
 *   named ends, its push is withdrawn quietly: its inbox row is read, and on a managed Whombat the phone's notification
 *   goes (a content-free clear). Nothing says it's back. Home's `things` hears of each opening, worsening and end, so an
 *   open page's “What happened” reads again. A Website check pointed at another address ends its incident the same
 *   quiet way in the edit's own commit (`endIncidentQuietly`).
 * - **`incidents.push`** (the watcher): saves the Inbox notification and marks the incidents pushed in one commit,
 *   then uses the usual push delivery. Whether each is still open, not kept quiet or down because of something else,
 *   and not pushed about by a research finding meanwhile is checked again in its commit, and its words name only those
 *   left, as each is on the watcher's pass.
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
  type DownStretchRow,
  type IncidentRow,
  incidents,
  incidentTriggers,
  lookResearches,
  notifications,
} from '../db/schema/index';
import { linkOfMessage } from '../domain/links';
import { publishNotificationsRead } from '../domain/notification-read';
import { notifyInCommit } from '../domain/notify';
import { GENERIC_PUSH_TITLE } from '../domain/push-preview';
import { thePerson } from '../domain/the-person';
import { homeAudience, publishHomeChanged } from '../home/notify';
import { SYSTEM_SERVERS } from '../hosts/principal';
import { forbidden } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadPrincipalRow } from '../read/principals';
import { holdsIncident } from './holds';
import { incidentPushText, type OpenIncident, PUSH_MAX, pushOrder } from './plan';
import { claimThingWatches, deliverThingWatches } from './thing-watch';

/** Incidents are kept this long after they ended. */
export const INCIDENTS_KEEP_MS = INCIDENTS_KEEP_DAYS * 24 * 60 * 60_000;

/** The push's inbox key and its group on the phone: one per push. */
export const pushKey = (group: string) => `incident:${group}`;

const Kind = z.enum(['server', 'connection', 'device']);
const Nature = z.enum(['down', 'problem']);
const Cause = z.object({ thing: z.string().min(3).max(220), name: z.string().min(1).max(120) }).nullable();
/** A bad check counting on a thing, with its line's words. */
const Problem = z.object({ check: z.string().min(1).max(80), words: z.string().max(200) });

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
  /** The bad checks counting on it as it opens: each other than `check` signs `thing.problem` too. */
  problems: z.array(Problem).max(30).optional(),
  /** When it stopped answering, when later than its start (passes that couldn't read it came between). */
  downSince: z.iso.datetime({ offset: true }).optional(),
});
const Changed = z.object({
  id: z.string().min(1).max(80),
  nature: Nature,
  words: z.string().min(1).max(200),
  cause: Cause,
  worse: z.boolean(),
  downSince: z.iso.datetime({ offset: true }).optional(),
  check: z.string().max(80).nullable().optional(),
  subject: z.string().max(160).optional(),
});
/** A bad check that began counting on an open incident. */
const Noted = Problem.extend({ id: z.string().min(1).max(80) });
/** A `down` incident's thing answered again (`down` false) or stopped answering again (true). */
const Stretched = z.object({
  id: z.string().min(1).max(80),
  down: z.boolean(),
  at: z.iso.datetime({ offset: true }),
});
const Ended = z.object({
  id: z.string().min(1).max(80),
  endedAt: z.iso.datetime({ offset: true }),
  /** Its thing was removed: it ends without coming back. */
  removed: z.boolean().optional(),
});

async function requireSigner(tx: Tx, actorId: string): Promise<void> {
  const row = await loadPrincipalRow(tx, actorId);
  if (row?.system !== SYSTEM_SERVERS) throw forbidden('Only Whombat’s monitoring keeps outages.');
}

/**
 * The event an incident signs, its payload checked. `about`: a check other than its own that is bad on it, with its
 * words and since when it counts; an automation that names that check starts on it, counting its delay from then.
 */
async function sign(
  ctx: ApplyContext,
  type: string,
  row: IncidentRow,
  about?: { check: string; words: string; since: Date },
): Promise<void> {
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
    words: (about?.words || row.words).slice(0, 200),
    ...(connection ? { catalogId: connection.catalogId } : {}),
    ...(about ? { check: about.check } : row.checkId ? { check: row.checkId } : {}),
    startedAt: (about?.since ?? (type === THING_DOWN ? row.downSince : null) ?? row.startedAt).toISOString(),
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

/** A list of checks with one more, once. */
const withCheck = (checks: readonly string[], check: string | null | undefined): string[] =>
  check && !checks.includes(check) ? [...checks, check] : [...checks];

/** Opens, worsens and ends incidents as the watcher's pass planned. */
export const incidentsPass = defineCommand({
  name: 'incidents.pass',
  schema: z.object({
    opened: z.array(Opened).max(200),
    changed: z.array(Changed).max(200),
    noted: z.array(Noted).max(200).optional(),
    stretched: z.array(Stretched).max(200).optional(),
    ended: z.array(Ended).max(200),
  }),
  async apply(tx, ctx, input) {
    await requireSigner(tx, ctx.actor.id);
    let signed = 0;
    for (const o of input.opened) {
      const others = (o.problems ?? []).filter((p) => p.check !== o.check);
      const checks = others.reduce((list, p) => withCheck(list, p.check), withCheck([], o.check));
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
          downSince: o.nature === 'down' ? new Date(o.downSince ?? o.startedAt) : null,
          causeThing: o.cause?.thing ?? null,
          causeName: o.cause?.name ?? null,
          checks,
          // Told without a push of its own: no group, so it counts in no day's pushes and nothing is withdrawn.
          ...(o.pushed ? { pushedAt: ctx.now } : {}),
        })
        // Opened by another pass meanwhile: that one stands.
        .onConflictDoNothing()
        .returning();
      if (!row) continue;
      await sign(ctx, row.nature === 'down' ? THING_DOWN : THING_PROBLEM, row);
      signed++;
      // Something else took it down: it starts nothing, as its own event doesn't.
      if (row.causeThing) continue;
      for (const p of others) {
        await sign(ctx, THING_PROBLEM, row, { ...p, since: row.startedAt });
        signed++;
      }
    }
    for (const c of input.changed) {
      const [was] = await tx
        .select({ checks: incidents.checks, checkId: incidents.checkId, nature: incidents.nature })
        .from(incidents)
        .where(and(eq(incidents.id, c.id), eq(incidents.burrowId, ctx.burrow.id)));
      const wentDown = c.worse && was?.nature === 'problem' && c.nature === 'down';
      const [row] = await tx
        .update(incidents)
        .set({
          nature: c.nature,
          words: c.words,
          ...(wentDown ? { downSince: c.downSince ? new Date(c.downSince) : ctx.now } : {}),
          ...(c.check === undefined
            ? {}
            : {
                checkId: c.check,
                subject: c.subject ?? '',
                checks: withCheck(withCheck(was?.checks ?? [], was?.checkId), c.check),
              }),
          ...(c.cause ? { causeThing: c.cause.thing, causeName: c.cause.name } : {}),
        })
        .where(and(eq(incidents.id, c.id), eq(incidents.burrowId, ctx.burrow.id), isNull(incidents.endedAt)))
        .returning();
      if (row && wentDown) {
        await sign(ctx, THING_DOWN, row);
        signed++;
      }
    }
    // A bad check that began counting on an open incident: `thing.problem` once for it, from now.
    for (const n of input.noted ?? []) {
      const [was] = await tx
        .select()
        .from(incidents)
        .where(and(eq(incidents.id, n.id), eq(incidents.burrowId, ctx.burrow.id), isNull(incidents.endedAt)))
        .for('update');
      if (!was || was.causeThing || was.checkId === n.check || was.checks.includes(n.check)) continue;
      const [row] = await tx
        .update(incidents)
        .set({ checks: withCheck(withCheck(was.checks, was.checkId), n.check) })
        .where(eq(incidents.id, was.id))
        .returning();
      if (!row) continue;
      await sign(ctx, THING_PROBLEM, row, { check: n.check, words: n.words, since: ctx.now });
      signed++;
    }
    let moved = signed > 0;
    for (const s of input.stretched ?? []) {
      const [was] = await tx
        .select()
        .from(incidents)
        .where(and(eq(incidents.id, s.id), eq(incidents.burrowId, ctx.burrow.id), isNull(incidents.endedAt)))
        .for('update');
      if (was?.nature !== 'down') continue;
      const stretches: DownStretchRow[] = was.downStretches.length
        ? was.downStretches.map((x) => ({ ...x }))
        : [{ from: (was.downSince ?? was.startedAt).toISOString(), to: null }];
      const last = stretches.at(-1);
      // Closing needs one still open, opening one that closed: a pass told twice changes nothing.
      if (!last || (last.to === null) === s.down) continue;
      if (s.down) stretches.push({ from: s.at, to: null });
      else last.to = s.at;
      await tx.update(incidents).set({ downStretches: stretches }).where(eq(incidents.id, was.id));
      moved = true;
    }
    const groups: string[] = [];
    for (const e of input.ended) {
      const [row] = await tx
        .update(incidents)
        .set({ endedAt: new Date(e.endedAt) })
        .where(and(eq(incidents.id, e.id), eq(incidents.burrowId, ctx.burrow.id), isNull(incidents.endedAt)))
        .returning();
      if (!row) continue;
      moved = true;
      // Removed isn't back: nothing starts and no watch hears that it came back.
      if (!e.removed) {
        await sign(ctx, THING_BACK, row);
        signed++;
      }
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

/**
 * Ends a thing's open incident inside the caller's commit, quietly, as a removed thing's: nothing says it is back, its
 * push is withdrawn and the delayed starts waiting on it are dropped. For a Website check pointed at another address:
 * the old target's outage says nothing of the new one, which opens its own after the usual passes.
 */
export async function endIncidentQuietly(ctx: ApplyContext, thing: string): Promise<void> {
  const rows = await ctx.tx
    .update(incidents)
    .set({ endedAt: ctx.now })
    .where(
      and(eq(incidents.burrowId, ctx.burrow.id), eq(incidents.thingId, thing), isNull(incidents.endedAt)),
    )
    .returning();
  if (!rows.length) return;
  await ctx.tx.delete(incidentTriggers).where(
    and(
      eq(incidentTriggers.burrowId, ctx.burrow.id),
      inArray(
        incidentTriggers.incidentId,
        rows.map((r) => r.id),
      ),
      isNotNull(incidentTriggers.dueAt),
    ),
  );
  await withdrawPushes(ctx, [
    ...new Set(rows.flatMap((r) => (r.pushGroup && !r.withdrawnAt ? [r.pushGroup] : []))),
  ]);
  publishHomeChanged(ctx, await homeAudience(ctx, ctx.burrow.id), ['things']);
}

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
 * Saves one Inbox row in the commit marking its incidents as pushed (one group), then sends the person a push,
 * “Needs you”. Incidents already pushed, ended, with a cause, kept quiet or down because of something else, or pushed
 * about by a research finding meanwhile are left out, and the words name only those still in it, as each is now
 * (`now`, from the watcher's pass: a thing that answers again is no longer down).
 */
export const incidentsPush = defineCommand({
  name: 'incidents.push',
  schema: z.object({
    ids: z.array(z.string().min(1).max(80)).min(1).max(PUSH_MAX),
    now: z
      .array(z.object({ id: z.string().min(1).max(80), nature: Nature, words: z.string().min(1).max(200) }))
      .max(PUSH_MAX)
      .optional(),
  }),
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
    // A research finding that pushed while this waited told the person already: one outage buzzes once.
    const oldest = Math.min(...candidates.map((r) => r.startedAt.getTime()));
    const findings = candidates.length
      ? await findingsPushedSince(tx, ctx.burrow.id, new Date(oldest))
      : new Map<string, number>();
    const ids: string[] = [];
    for (const row of candidates)
      if (
        (findings.get(row.thingId) ?? 0) < row.startedAt.getTime() &&
        !(await holdsIncident(tx, ctx.burrow.id, row.thingId, ctx.now))
      )
        ids.push(row.id);
    const person = await thePerson(tx, ctx.burrow.id);
    if (!ids.length || !person) return { pushed: 0 };
    const group = newId('incident');
    const current = new Map((input.now ?? []).map((n) => [n.id, n] as const));
    const asNow = (r: IncidentRow) => {
      const n = current.get(r.id);
      return { ...openIncidentOf(r), ...(n ? { nature: n.nature, words: n.words } : {}) };
    };
    const rows = (
      await tx
        .update(incidents)
        .set({ pushedAt: ctx.now, pushGroup: group })
        .where(and(eq(incidents.burrowId, ctx.burrow.id), inArray(incidents.id, ids)))
        .returning()
    ).sort((a, b) => pushOrder(asNow(a), asNow(b)));
    if (!rows.length) return { pushed: 0 };
    const { link, messageId } = { messageId: undefined, ...(await pushLink(ctx, rows)) };
    await notifyInCommit(ctx, {
      burrowId: ctx.burrow.id,
      burrowSlug: ctx.burrow.slug,
      principalId: person.id,
      kind: 'needs_you' as const,
      actorId: ctx.actor.id,
      where: rows.length === 1 ? (rows[0] as IncidentRow).name.slice(0, 120) : 'Overview',
      text: incidentPushText(rows.map(asNow)),
      link,
      createdAt: ctx.now,
      dedupKey: pushKey(group),
      ...(messageId ? { messageId } : {}),
      group: pushKey(group),
    });
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
    checks: withCheck(row.checks ?? [], row.checkId),
    answeringSince: answeringSince(row),
  };
}

/** When a `down` incident's thing answered again, while it still answers; null while it is down. */
function answeringSince(row: IncidentRow): Date | null {
  const to = row.nature === 'down' ? row.downStretches?.at(-1)?.to : null;
  return to ? new Date(to) : null;
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
