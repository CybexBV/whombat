/**
 * What Whombat has seen open per connection (docs/decisions/internet-exposure.md): the first full read is the silent
 * first list, every opening after it is new for two weeks (`NEW_FOR_MS`), until the person says it's meant or until it
 * closes. An opening that closed and
 * opens again within 30 days isn't new: switching a host off and on again says nothing. Only fingerprints and times are
 * kept (`exposure_openings`).
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { exposureOpenings } from '../db/schema/index';
import type { Services } from '../services';
import type { KeptOpening } from './openings';

/** The row that says the first list of a connection is kept. */
export const FIRST_LIST = '*';
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

export interface BaselineStep {
  /** Rows to write: new openings, the first list's mark, and openings seen again after an hour. */
  write: KeptRow[];
  /** Openings closed for longer than `FORGET_AFTER_MS`. */
  forget: string[];
  /** Every opening open now as it is kept after this step. */
  kept: Map<string, KeptOpening>;
}

/**
 * One read's step. Before the first list is kept, everything read joins it silently; the list is kept once a read was
 * complete, so a partly read source never makes the rest look new later.
 */
export function baselineStep(
  stored: readonly KeptRow[],
  current: readonly string[],
  complete: boolean,
  now: Date,
): BaselineStep {
  const byId = new Map(stored.map((r) => [r.openingId, r]));
  const listed = byId.has(FIRST_LIST);
  const write: KeptRow[] = [];
  const kept = new Map<string, KeptOpening>();
  for (const id of new Set(current)) {
    const before = byId.get(id);
    if (before) {
      if (now.getTime() - before.lastSeen.getTime() >= SEEN_EVERY_MS)
        write.push({ ...before, lastSeen: now });
      kept.set(id, { firstSeen: before.firstSeen, baseline: before.baseline });
      continue;
    }
    const row = { openingId: id, firstSeen: now, lastSeen: now, baseline: !listed };
    write.push(row);
    kept.set(id, { firstSeen: now, baseline: row.baseline });
  }
  if (!listed && complete)
    write.push({ openingId: FIRST_LIST, firstSeen: now, lastSeen: now, baseline: true });
  const open = new Set(current);
  const forget = stored
    .filter(
      (r) =>
        r.openingId !== FIRST_LIST &&
        !open.has(r.openingId) &&
        now.getTime() - r.lastSeen.getTime() > FORGET_AFTER_MS,
    )
    .map((r) => r.openingId);
  return { write, forget, kept };
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
      .filter((r) => r.openingId !== FIRST_LIST)
      .map((r) => [r.openingId, { firstSeen: r.firstSeen, baseline: r.baseline }]),
  );
}

/** Records one read of a connection's openings (the health pass) and returns how each open one is kept. */
export async function recordOpenings(
  services: Pick<Services, 'pipeline'>,
  connectionId: string,
  current: readonly string[],
  complete: boolean,
  now: Date,
): Promise<Map<string, KeptOpening>> {
  return services.pipeline.transactAccount(async (tx) => {
    const stored = (await keptRows(tx, [connectionId])).get(connectionId) ?? [];
    const step = baselineStep(stored, current, complete, now);
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
    return step.kept;
  });
}
