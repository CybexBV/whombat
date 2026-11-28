/**
 * The change log (docs/decisions/outside-changes.md): what a thing's last read was (`change_baselines`), the changes
 * seen between two reads (`thing_changes`, 90 days), who made each (Whombat when its own change on the thing, or on the
 * server it runs on, came shortly before; else outside Whombat), and a burst of the same item seen again soon after
 * merged into one change. Written through the pipeline's transaction, unsigned, like the health pass's reads: no person
 * acted. An open page hears of a new change (`home.changed {things}`); nothing else does: changes never alert.
 */
import { CHANGES_KEEP_DAYS, newId, parseThingId, type ThingChangeBy } from '@whombat/core';
import { and, desc, eq, gte, inArray, isNull, lt, lte } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { changeBaselines, changes, type ThingChangeRow, thingChanges } from '../db/schema/index';
import { homeAudience, publishHomeChanged } from '../home/notify';
import type { Services } from '../services';
import { type ChangeDraft, MERGE_MS, mergeFacts } from './diff';

const DAY = 24 * 60 * 60_000;
/** Whombat's own change on the thing this long before the read before counts as what made this one. */
export const OWN_LEAD_MS = 2 * 60 * 60_000;

/** The state kept of `thing` from `source`, and when it was read; null before its first read. */
export async function readBaseline<T>(
  db: Db,
  burrowId: string,
  thing: string,
  source: string,
): Promise<{ state: T; readAt: Date } | null> {
  const [row] = await db
    .select({ state: changeBaselines.state, readAt: changeBaselines.readAt })
    .from(changeBaselines)
    .where(
      and(
        eq(changeBaselines.burrowId, burrowId),
        eq(changeBaselines.thingId, thing),
        eq(changeBaselines.source, source),
      ),
    );
  return row ? { state: row.state as T, readAt: row.readAt } : null;
}

/** The things whose `changes` rows say Whombat changed them between `from` and `to`. */
async function whombatChanged(
  tx: Db,
  burrowId: string,
  things: readonly string[],
  from: Date,
  to: Date,
): Promise<boolean> {
  for (const thing of things) {
    const parsed = parseThingId(thing);
    if (!parsed) continue;
    const [row] = await tx
      .select({ id: changes.id })
      .from(changes)
      .where(
        and(
          eq(changes.burrowId, burrowId),
          eq(changes.subjectKind, parsed.kind),
          eq(changes.subjectId, parsed.id),
          gte(changes.createdAt, from),
          lte(changes.createdAt, to),
          isNull(changes.undoneAt),
        ),
      )
      .limit(1);
    if (row) return true;
  }
  return false;
}

export interface ReadToRecord {
  burrowId: string;
  thing: string;
  source: string;
  /** What to keep for the next read. */
  state: Record<string, unknown>;
  /** What changed since the read before (none on a first read). */
  drafts: readonly ChangeDraft[];
  /** When the read before was, if there was one. */
  since: Date | null;
  /**
   * Other things Whombat's own change on counts too: the server a connection runs on (updating its container changes
   * the service's version).
   */
  alsoThings?: readonly string[];
  now: Date;
}

/**
 * Keeps a read: its state for the next read and its changes, each merged with one of the same item seen within
 * `MERGE_MS` (or gone with it when it undid that one). Returns how many changes are new.
 */
export async function recordRead(services: Services, read: ReadToRecord): Promise<number> {
  const { burrowId, thing, source, state, drafts, since, now } = read;
  return (
    await services.pipeline.transact(burrowId, async (session) => {
      const tx = session.tx;
      await tx
        .insert(changeBaselines)
        .values({ burrowId, thingId: thing, source, state, readAt: now })
        .onConflictDoUpdate({
          target: [changeBaselines.burrowId, changeBaselines.thingId, changeBaselines.source],
          set: { state, readAt: now },
        });
      if (!drafts.length) return 0;
      const from = new Date((since ?? now).getTime() - OWN_LEAD_MS);
      const own = await whombatChanged(tx, burrowId, [thing, ...(read.alsoThings ?? [])], from, now);
      const by: ThingChangeBy = own ? 'whombat' : 'outside';
      let added = 0;
      for (const d of drafts) {
        const [recent] = await tx
          .select()
          .from(thingChanges)
          .where(
            and(
              eq(thingChanges.burrowId, burrowId),
              eq(thingChanges.thingId, thing),
              eq(thingChanges.kind, d.kind),
              eq(thingChanges.subject, d.subject),
              gte(thingChanges.seenAt, new Date(now.getTime() - MERGE_MS)),
            ),
          )
          .orderBy(desc(thingChanges.seenAt))
          .limit(1);
        const merged = recent ? mergeFacts(recent.fact, d.fact) : null;
        if (recent && merged) {
          if (merged === 'gone') {
            await tx.delete(thingChanges).where(eq(thingChanges.id, recent.id));
            continue;
          }
          await tx
            .update(thingChanges)
            .set({ fact: merged, seenAt: now, by: recent.by === 'whombat' ? 'whombat' : by })
            .where(eq(thingChanges.id, recent.id));
          continue;
        }
        await tx.insert(thingChanges).values({
          id: newId('thingChange'),
          burrowId,
          thingId: thing,
          kind: d.kind,
          subject: d.subject,
          fact: d.fact,
          by,
          seenAt: now,
          since,
        });
        added++;
      }
      // An open page reads its History again (as for an outage); nothing pushes or lands in the Inbox.
      publishHomeChanged(session, await homeAudience(session, burrowId), ['things']);
      return added;
    })
  ).result;
}

/** The changes of `things` (all when absent) seen since `from`, newest first. */
export async function changesSince(
  db: Db | Tx,
  burrowId: string,
  from: Date,
  things?: readonly string[],
  limit = 500,
): Promise<ThingChangeRow[]> {
  if (things && !things.length) return [];
  return db
    .select()
    .from(thingChanges)
    .where(
      and(
        eq(thingChanges.burrowId, burrowId),
        gte(thingChanges.seenAt, from),
        things ? inArray(thingChanges.thingId, [...things]) : undefined,
      ),
    )
    .orderBy(desc(thingChanges.seenAt), desc(thingChanges.id))
    .limit(limit);
}

/** Changes older than 90 days go; returns how many. */
export async function pruneChanges(db: Db, now: Date): Promise<number> {
  const gone = await db
    .delete(thingChanges)
    .where(lt(thingChanges.seenAt, new Date(now.getTime() - CHANGES_KEEP_DAYS * DAY)))
    .returning({ id: thingChanges.id });
  return gone.length;
}
