/**
 * What Whombat has seen open per connection (docs/decisions/internet-exposure.md). The first list is kept per list a
 * place has (a proxy's hosts, its streams, a router's port forwards, each tunnel's routes): the first time a list is
 * read whole, what is in it joins silently, and every opening after it is new for two weeks (`NEW_FOR_MS`), until the
 * person says it's meant or until it closes. So a list Whombat can't read (streams it may not see) doesn't hold back
 * the others. An opening that closed and opens again within 30 days isn't new: switching a host off and on again says
 * nothing. Only fingerprints and times are kept (`exposure_openings`).
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { exposureOpenings } from '../db/schema/index';
import type { Services } from '../services';
import { isNewOpening, type KeptOpening } from './openings';
import type { ReadPart } from './parse';

/**
 * The row an older Whombat wrote once a whole connection's first list was kept. It is left for that Whombat after a
 * rollback and isn't read: what makes an opening new changed with the lists, so each list is kept again once.
 */
export const FIRST_LIST = '*';
/** The row that says the first list of one list is kept: `*:proxy`, `*:tunnel:<id>`. */
export const firstListOf = (part: string) => `${FIRST_LIST}:${part}`;
const isMark = (id: string) => id.startsWith(FIRST_LIST);
/** How long a closed opening is remembered: back within this, it isn't new. */
export const FORGET_AFTER_MS = 30 * 86_400_000;
/** How stale `last_seen` may get before a pass writes it again (fewer writes for what stays open). */
const SEEN_EVERY_MS = 60 * 60_000;

export interface KeptRow {
  openingId: string;
  firstSeen: Date;
  lastSeen: Date;
  baseline: boolean;
}

/** An opening a read saw: its id and the list it was in. */
export interface SeenOpening {
  id: string;
  part: string;
}

export interface BaselineStep {
  /** Rows to write: new openings, the marks of lists kept now, and what was seen again after an hour. */
  write: KeptRow[];
  /** Openings (and lists) gone for longer than `FORGET_AFTER_MS`, after a read of everything. */
  forget: string[];
  /** Every opening open now as it is kept after this step. */
  kept: Map<string, KeptOpening>;
  /**
   * The read missed a list and a new opening wasn't in it: whether that one closed can't be told, so its line stays as
   * it is this time.
   */
  unsure: boolean;
}

/**
 * One read's step. An opening not seen before is new when its list was kept before this read, or when its list is
 * within one that was (a tunnel set up after the list of tunnels was kept). Nothing is forgotten after a read that
 * missed a list: an opening there may still be open, and forgetting it would make it new when it is read again.
 */
export function baselineStep(
  stored: readonly KeptRow[],
  current: readonly SeenOpening[],
  parts: readonly ReadPart[],
  complete: boolean,
  now: Date,
): BaselineStep {
  const byId = new Map(stored.map((r) => [r.openingId, r]));
  const within = new Map(parts.map((p) => [p.key, p.within]));
  const kept = (part: string | undefined) => !!part && byId.has(firstListOf(part));
  const listed = (part: string) => kept(part) || kept(within.get(part));
  const write: KeptRow[] = [];
  const keptNow = new Map<string, KeptOpening>();
  const open = new Set<string>();
  const seenAgain = (before: KeptRow) => {
    if (now.getTime() - before.lastSeen.getTime() >= SEEN_EVERY_MS) write.push({ ...before, lastSeen: now });
  };
  for (const { id, part } of current) {
    if (open.has(id)) continue;
    open.add(id);
    const before = byId.get(id);
    if (before) {
      seenAgain(before);
      keptNow.set(id, { firstSeen: before.firstSeen, baseline: before.baseline });
      continue;
    }
    const row = { openingId: id, firstSeen: now, lastSeen: now, baseline: !listed(part) };
    write.push(row);
    keptNow.set(id, { firstSeen: now, baseline: row.baseline });
  }
  for (const part of parts) {
    const mark = firstListOf(part.key);
    open.add(mark);
    const before = byId.get(mark);
    if (before) seenAgain(before);
    else if (part.whole) write.push({ openingId: mark, firstSeen: now, lastSeen: now, baseline: true });
  }
  const forget = complete
    ? stored
        .filter(
          (r) =>
            r.openingId !== FIRST_LIST &&
            !open.has(r.openingId) &&
            now.getTime() - r.lastSeen.getTime() > FORGET_AFTER_MS,
        )
        .map((r) => r.openingId)
    : [];
  const unsure =
    !complete && stored.some((r) => !isMark(r.openingId) && !open.has(r.openingId) && isNewOpening(r, now));
  return { write, forget, kept: keptNow, unsure };
}

/** What is kept for these connections, by connection. */
export async function keptRows(
  db: Db | Tx,
  connectionIds: readonly string[],
): Promise<Map<string, KeptRow[]>> {
  const out = new Map<string, KeptRow[]>();
  if (!connectionIds.length) return out;
  const rows = await db
    .select()
    .from(exposureOpenings)
    .where(inArray(exposureOpenings.connectionId, [...connectionIds]));
  for (const r of rows) {
    const list = out.get(r.connectionId) ?? [];
    list.push({ openingId: r.openingId, firstSeen: r.firstSeen, lastSeen: r.lastSeen, baseline: r.baseline });
    out.set(r.connectionId, list);
  }
  return out;
}

/** The kept openings of one connection as the page reads them (no writes): those open now, by id. */
export function keptOf(rows: readonly KeptRow[]): Map<string, KeptOpening> {
  return new Map(
    rows
      .filter((r) => !isMark(r.openingId))
      .map((r) => [r.openingId, { firstSeen: r.firstSeen, baseline: r.baseline }]),
  );
}

/**
 * Records one read of a connection's openings (the health pass): how each open one is kept, and whether a line of a
 * new one that wasn't read this time must stay as it is.
 */
export async function recordOpenings(
  services: Pick<Services, 'pipeline'>,
  connectionId: string,
  current: readonly SeenOpening[],
  parts: readonly ReadPart[],
  complete: boolean,
  now: Date,
): Promise<{ kept: Map<string, KeptOpening>; unsure: boolean }> {
  return services.pipeline.transactAccount(async (tx) => {
    const stored = (await keptRows(tx, [connectionId])).get(connectionId) ?? [];
    const step = baselineStep(stored, current, parts, complete, now);
    for (const row of step.write)
      await tx
        .insert(exposureOpenings)
        .values({ connectionId, ...row })
        .onConflictDoUpdate({
          target: [exposureOpenings.connectionId, exposureOpenings.openingId],
          set: { lastSeen: row.lastSeen },
        });
    if (step.forget.length)
      await tx
        .delete(exposureOpenings)
        .where(
          and(
            eq(exposureOpenings.connectionId, connectionId),
            inArray(exposureOpenings.openingId, step.forget),
          ),
        );
    return { kept: step.kept, unsure: step.unsure };
  });
}
