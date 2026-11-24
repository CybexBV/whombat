/**
 * The quiet rows, the checks not watched, the checks that start off and someone turned on, and the health pass's states
 * (quiet-notices.md QN-11…QN-15; QN-S01, QN-S02; watch-defaults.md): reads by owner (one read for a whole Home) or by
 * thing, and what a health pass writes back (rows that ended, passes without the line, the states). People's changes
 * are the commands in `commands.ts`; which checks start off, and whether a line is quiet by its rows alone, are
 * `defaults.ts`'s.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '../../db/client';
import {
  type NoticeQuietRow,
  type NoticeStateRow,
  noticeQuiets,
  noticeStates,
  type QuietWindowRow,
  quietWindows,
  type ThingCauseRow,
  thingCauses,
  type WatchOffRow,
  type WatchOnRow,
  watchOffs,
  watchOns,
} from '../../db/schema/index';
import type { ApplyLine, ApplyResult, StateRow } from './apply';

/** One thing's quiet rows, offs, and the checks that start off someone turned on. */
export interface ThingQuiet {
  quiets: NoticeQuietRow[];
  offs: WatchOffRow[];
  ons: WatchOnRow[];
  /** Its quiet windows not ended early: `applyQuiet` asks which holds at its time. */
  windows?: QuietWindowRow[];
  /** What it is down because of, as the causes job last found it. */
  cause?: ThingCauseRow | null;
}

/** Windows not ended early and causes of some owners (and things): the reads every quiet read adds. */
async function holds(
  db: Db | Tx,
  owners: readonly string[],
  things?: readonly string[],
): Promise<[QuietWindowRow[], ThingCauseRow[]]> {
  return Promise.all([
    db
      .select()
      .from(quietWindows)
      .where(
        and(
          inArray(quietWindows.ownerId, [...owners]),
          isNull(quietWindows.endedAt),
          ...(things ? [inArray(quietWindows.thingId, [...things])] : []),
        ),
      ),
    db
      .select()
      .from(thingCauses)
      .where(
        and(
          inArray(thingCauses.ownerId, [...owners]),
          ...(things ? [inArray(thingCauses.thingId, [...things])] : []),
        ),
      ),
  ]);
}

export const NO_QUIET: ThingQuiet = { quiets: [], offs: [], ons: [] };

/** Every quiet row and off of some owners, by thing (one read for a Home, a desk glance, a Watch list). */
export interface QuietBook {
  of(thingId: string): ThingQuiet;
}

export async function quietBook(
  db: Db | Tx,
  owners: readonly (string | null | undefined)[],
): Promise<QuietBook> {
  const ids = [...new Set(owners.filter((o): o is string => !!o))];
  if (!ids.length) return { of: () => NO_QUIET };
  const [quiets, offs, ons, [windows, causes]] = await Promise.all([
    db.select().from(noticeQuiets).where(inArray(noticeQuiets.ownerId, ids)),
    db.select().from(watchOffs).where(inArray(watchOffs.ownerId, ids)),
    db.select().from(watchOns).where(inArray(watchOns.ownerId, ids)),
    holds(db, ids),
  ]);
  const by = new Map<string, ThingQuiet>();
  const at = (thing: string) => {
    const found = by.get(thing);
    if (found) return found;
    const made: ThingQuiet = { quiets: [], offs: [], ons: [] };
    by.set(thing, made);
    return made;
  };
  for (const q of quiets) at(q.thingId).quiets.push(q);
  for (const o of offs) at(o.thingId).offs.push(o);
  for (const o of ons) at(o.thingId).ons.push(o);
  addHolds(at, windows, causes);
  return { of: (thing) => by.get(thing) ?? NO_QUIET };
}

/** Puts each window and cause with its thing. */
function addHolds(
  at: (thing: string) => ThingQuiet,
  windows: readonly QuietWindowRow[],
  causes: readonly ThingCauseRow[],
): void {
  for (const w of windows) {
    const q = at(w.thingId);
    q.windows = [...(q.windows ?? []), w];
  }
  for (const c of causes) at(c.thingId).cause = c;
}

/** One thing's quiet rows, offs and ons (also inside a pipeline transaction: `thingQuiet(session.tx, …)`). */
export async function thingQuiet(db: Db | Tx, owner: string, thingId: string): Promise<ThingQuiet> {
  const [quiets, offs, ons, [windows, causes]] = await Promise.all([
    db
      .select()
      .from(noticeQuiets)
      .where(and(eq(noticeQuiets.ownerId, owner), eq(noticeQuiets.thingId, thingId))),
    db
      .select()
      .from(watchOffs)
      .where(and(eq(watchOffs.ownerId, owner), eq(watchOffs.thingId, thingId))),
    db
      .select()
      .from(watchOns)
      .where(and(eq(watchOns.ownerId, owner), eq(watchOns.thingId, thingId))),
    holds(db, [owner], [thingId]),
  ]);
  return { quiets, offs, ons, windows, cause: causes[0] ?? null };
}

export async function thingStates(db: Db | Tx, thingId: string): Promise<NoticeStateRow[]> {
  return db.select().from(noticeStates).where(eq(noticeStates.thingId, thingId));
}

/** Many things' quiet rows and line states, each thing with its owner (`passQuiet`). */
export interface PassQuiet {
  /** One thing's quiet rows, offs and ons, as `thingQuiet` reads them. */
  of(owner: string, thingId: string): ThingQuiet;
  /** One thing's line states, as `thingStates` reads them. */
  states(thingId: string): NoticeStateRow[];
}

/**
 * The quiet rows, offs, ons and line states of many things, one read of each table for them all (a health pass's
 * connections) instead of four per thing.
 */
export async function passQuiet(
  db: Db | Tx,
  things: readonly { owner: string; thingId: string }[],
): Promise<PassQuiet> {
  const owners = [...new Set(things.map((t) => t.owner))];
  const ids = [...new Set(things.map((t) => t.thingId))];
  if (!ids.length) return { of: () => NO_QUIET, states: () => [] };
  const [quiets, offs, ons, states, [windows, causes]] = await Promise.all([
    db
      .select()
      .from(noticeQuiets)
      .where(and(inArray(noticeQuiets.ownerId, owners), inArray(noticeQuiets.thingId, ids))),
    db
      .select()
      .from(watchOffs)
      .where(and(inArray(watchOffs.ownerId, owners), inArray(watchOffs.thingId, ids))),
    db
      .select()
      .from(watchOns)
      .where(and(inArray(watchOns.ownerId, owners), inArray(watchOns.thingId, ids))),
    db.select().from(noticeStates).where(inArray(noticeStates.thingId, ids)),
    holds(db, owners, ids),
  ]);
  const key = (owner: string, thingId: string) => `${owner}\u0000${thingId}`;
  const by = new Map<string, ThingQuiet>();
  const at = (owner: string, thingId: string) => {
    const k = key(owner, thingId);
    const found = by.get(k);
    if (found) return found;
    const made: ThingQuiet = { quiets: [], offs: [], ons: [] };
    by.set(k, made);
    return made;
  };
  for (const q of quiets) at(q.ownerId, q.thingId).quiets.push(q);
  for (const o of offs) at(o.ownerId, o.thingId).offs.push(o);
  for (const o of ons) at(o.ownerId, o.thingId).ons.push(o);
  for (const w of windows) {
    const q = at(w.ownerId, w.thingId);
    q.windows = [...(q.windows ?? []), w];
  }
  for (const c of causes) at(c.ownerId, c.thingId).cause = c;
  const stateBy = new Map<string, NoticeStateRow[]>();
  for (const st of states) {
    const list = stateBy.get(st.thingId);
    if (list) list.push(st);
    else stateBy.set(st.thingId, [st]);
  }
  return {
    of: (owner, thingId) => by.get(key(owner, thingId)) ?? { quiets: [], offs: [], ons: [] },
    states: (thingId) => stateBy.get(thingId) ?? [],
  };
}

const rowKey = (owner: string, thingId: string, r: { checkId: string; subject: string }) =>
  and(
    eq(noticeQuiets.ownerId, owner),
    eq(noticeQuiets.thingId, thingId),
    eq(noticeQuiets.checkId, r.checkId),
    eq(noticeQuiets.subject, r.subject),
  );

/** A quiet row as written (`clearPasses` starts at 0). */
export type QuietInsert = Omit<NoticeQuietRow, 'clearPasses'> & { clearPasses?: number };

/** Writes (or replaces) one quiet row, inside the caller's transaction (a command's `tx`). */
export async function putQuiet(tx: Tx, row: QuietInsert): Promise<NoticeQuietRow> {
  const values = { ...row, clearPasses: row.clearPasses ?? 0 };
  const [written] = await tx
    .insert(noticeQuiets)
    .values(values)
    .onConflictDoUpdate({
      target: [noticeQuiets.ownerId, noticeQuiets.thingId, noticeQuiets.checkId, noticeQuiets.subject],
      set: values,
    })
    .returning();
  return written as NoticeQuietRow;
}

/** Deletes one quiet row; returns it, or null when there was none. */
export async function dropQuiet(
  tx: Tx,
  key: { ownerId: string; thingId: string; checkId: string; subject: string },
): Promise<NoticeQuietRow | null> {
  const [gone] = await tx
    .delete(noticeQuiets)
    .where(rowKey(key.ownerId, key.thingId, key))
    .returning();
  return gone ?? null;
}

/** Writes an off (a check, or one item of it, not watched); false when it was off already. */
export async function putOff(tx: Tx, row: WatchOffRow): Promise<boolean> {
  const written = await tx.insert(watchOffs).values(row).onConflictDoNothing().returning();
  return written.length > 0;
}

/** Writes an on (a check that starts off, turned on); false when it was on already. */
export async function putOn(tx: Tx, row: WatchOnRow): Promise<boolean> {
  const written = await tx.insert(watchOns).values(row).onConflictDoNothing().returning();
  return written.length > 0;
}

/** Deletes an on; false when there was none. */
export async function dropOn(
  tx: Tx,
  key: { ownerId: string; thingId: string; checkId: string },
): Promise<boolean> {
  const gone = await tx
    .delete(watchOns)
    .where(
      and(
        eq(watchOns.ownerId, key.ownerId),
        eq(watchOns.thingId, key.thingId),
        eq(watchOns.checkId, key.checkId),
      ),
    )
    .returning();
  return gone.length > 0;
}

/** Deletes an off; false when there was none. */
export async function dropOff(
  tx: Tx,
  key: { ownerId: string; thingId: string; checkId: string; subject: string },
): Promise<boolean> {
  const gone = await tx
    .delete(watchOffs)
    .where(
      and(
        eq(watchOffs.ownerId, key.ownerId),
        eq(watchOffs.thingId, key.thingId),
        eq(watchOffs.checkId, key.checkId),
        eq(watchOffs.subject, key.subject),
      ),
    )
    .returning();
  return gone.length > 0;
}

/**
 * What a health pass learned (operational, like the glance; QN-17: an Ignore ending by itself isn't recorded): the
 * rows that end, the passes without their line, the states of the lines it saw and of those that went.
 */
export async function writePass(
  tx: Tx,
  owner: string,
  thingId: string,
  result: Pick<ApplyResult<ApplyLine, NoticeQuietRow>, 'lift' | 'cleared' | 'states' | 'gone'>,
): Promise<void> {
  for (const r of result.lift) await tx.delete(noticeQuiets).where(rowKey(owner, thingId, r));
  for (const r of result.cleared)
    await tx
      .update(noticeQuiets)
      .set({ clearPasses: r.clearPasses })
      .where(rowKey(owner, thingId, r));
  for (const s of result.gone)
    await tx
      .delete(noticeStates)
      .where(
        and(
          eq(noticeStates.thingId, thingId),
          eq(noticeStates.checkId, s.checkId),
          eq(noticeStates.subject, s.subject),
        ),
      );
  if (result.states.length)
    await tx
      .insert(noticeStates)
      .values(result.states.map((s: StateRow) => ({ ...s, thingId })))
      .onConflictDoUpdate({
        target: [noticeStates.thingId, noticeStates.checkId, noticeStates.subject],
        set: {
          lastSeen: sqlExcluded('last_seen'),
          seenPasses: sqlExcluded('seen_passes'),
          tone: sqlExcluded('tone'),
        },
      });
}

/**
 * Rows of connections and devices that are gone (removed, or gone with their account or burrow: the rows have no foreign
 * key, a thing id names several kinds of row). Servers are the servers' part's.
 */
export async function pruneGoneThings(tx: Tx | Db): Promise<void> {
  const gone = (table: string) =>
    sql.raw(`delete from ${table} t
      where (t.thing_id like 'connection:%' or t.thing_id like 'device:%')
        and not exists (select 1 from catalog_connections c where c.id = split_part(t.thing_id, ':', 2))
        and not exists (select 1 from connections c where c.id = split_part(t.thing_id, ':', 2))`);
  await tx.execute(gone('notice_quiets'));
  await tx.execute(gone('watch_offs'));
  await tx.execute(gone('watch_ons'));
  await tx.execute(gone('notice_states'));
  await tx.execute(gone('quiet_windows'));
  await tx.execute(gone('thing_causes'));
}

function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}
