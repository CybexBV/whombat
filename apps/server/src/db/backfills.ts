/**
 * Resumable backfills (docs/decisions/managed-db.md MD-05): data migrations too large or too slow for the
 * schema transaction. A `backfill` migration changes the schema (e.g. adds a nullable column) and names a
 * backfill here; the migration authority registers it in `whombat_meta.backfills` in the same transaction and,
 * after that commits, runs it batch by batch until a batch says `done`.
 *
 * Rules for a batch:
 * - it runs inside the transaction that also stores its cursor, so it is committed together with its progress;
 * - it is idempotent (re-running a batch after a crash before the commit changes nothing twice): prefer
 *   `update … where <column> is null` over counters;
 * - it is bounded (a few thousand rows) and ordered by a stable key; `cursor` is that key, as text;
 * - it never calls out of the database (no mail, push, GitHub, providers): backfills are data only.
 */
import type postgres from 'postgres';

export interface BackfillBatch {
  /** Where the next batch starts (null: from the start again, which an idempotent batch tolerates). */
  cursor: string | null;
  /** Rows this batch changed (reported and summed in `whombat_meta.backfills.processed`). */
  processed: number;
  /** Nothing left: the backfill is finished. */
  done: boolean;
}

export interface Backfill {
  /** One batch after `cursor` (null: the first), in `tx`. */
  batch(tx: postgres.TransactionSql, cursor: string | null): Promise<BackfillBatch>;
}

export type BackfillRegistry = Readonly<Record<string, Backfill>>;

/**
 * This build's backfills, by the name their migration's `compat.json` entry gives. None since the baseline
 * (one-agent.md OA-20): a fresh database has no older rows to fill.
 */
export const BACKFILLS: BackfillRegistry = {};
