/**
 * Canvas document storage: a canvas's Yjs state is its snapshot (`canvases.ydoc`) plus the
 * incremental updates appended since (`canvas_updates`, in id order). Every update row is written inside
 * the commit that signed it (`record_canvas_edit`, `edit_canvas`) or, for plan-block syncs, next to the
 * signed plan change it mirrors. Compaction folds the updates into a new snapshot (a derived projection:
 * unsigned, like the search index) and deletes them.
 */
import { and, asc, count, eq, lte } from 'drizzle-orm';
import * as Y from 'yjs';
import type { Database, Db } from '../db/client';
import { canvases, canvasUpdates } from '../db/schema/index';

/** Fold the updates into the snapshot once a canvas has this many. */
export const COMPACT_AFTER_UPDATES = 64;

export interface StoredCanvasState {
  /** Snapshot and updates merged into one Yjs update (null: the canvas has no document yet). */
  state: Uint8Array | null;
  /** Id of the last update row included. */
  lastUpdateId: number;
  updates: number;
}

function bytes(buf: Buffer | Uint8Array): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export async function loadCanvasState(db: Db, canvasId: string): Promise<StoredCanvasState> {
  const [row] = await db.select({ ydoc: canvases.ydoc }).from(canvases).where(eq(canvases.id, canvasId));
  const rows = await db
    .select({ id: canvasUpdates.id, update: canvasUpdates.update })
    .from(canvasUpdates)
    .where(eq(canvasUpdates.canvasId, canvasId))
    .orderBy(asc(canvasUpdates.id));
  const parts = [...(row?.ydoc ? [bytes(row.ydoc)] : []), ...rows.map((r) => bytes(r.update))];
  return {
    state: parts.length === 0 ? null : parts.length === 1 ? (parts[0] as Uint8Array) : Y.mergeUpdates(parts),
    lastUpdateId: rows.at(-1)?.id ?? 0,
    updates: rows.length,
  };
}

export async function insertCanvasUpdate(
  tx: Db,
  row: { canvasId: string; update: Uint8Array; authorId: string | null; createdAt: Date },
): Promise<number> {
  const [inserted] = await tx
    .insert(canvasUpdates)
    .values({
      canvasId: row.canvasId,
      update: Buffer.from(row.update),
      authorId: row.authorId,
      createdAt: row.createdAt,
    })
    .returning({ id: canvasUpdates.id });
  return inserted?.id ?? 0;
}

export async function countCanvasUpdates(db: Db, canvasId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(canvasUpdates)
    .where(eq(canvasUpdates.canvasId, canvasId));
  return Number(row?.n ?? 0);
}

/**
 * Writes the first snapshot of a canvas that has none (built from its Markdown). Keeps an existing one:
 * whoever materialised first wins, so two loads racing agree on the document.
 */
export async function materializeCanvas(db: Database, canvasId: string, state: Uint8Array, at: Date) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ ydoc: canvases.ydoc })
      .from(canvases)
      .where(eq(canvases.id, canvasId))
      .for('update');
    if (!row) return null;
    if (row.ydoc) return bytes(row.ydoc);
    await tx
      .update(canvases)
      .set({ ydoc: Buffer.from(state), ydocUpdatedAt: at })
      .where(eq(canvases.id, canvasId));
    return state;
  });
}

/**
 * Folds the snapshot and every update into a new snapshot (garbage-collected through a Y.Doc) and deletes
 * the folded updates. Updates appended meanwhile stay. Returns how many were folded.
 */
export async function compactCanvas(db: Database, canvasId: string, at: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ ydoc: canvases.ydoc })
      .from(canvases)
      .where(eq(canvases.id, canvasId))
      .for('update');
    if (!row) return 0;
    const rows = await tx
      .select({ id: canvasUpdates.id, update: canvasUpdates.update })
      .from(canvasUpdates)
      .where(eq(canvasUpdates.canvasId, canvasId))
      .orderBy(asc(canvasUpdates.id));
    if (rows.length === 0) return 0;
    const doc = new Y.Doc();
    if (row.ydoc) Y.applyUpdate(doc, bytes(row.ydoc));
    for (const r of rows) Y.applyUpdate(doc, bytes(r.update));
    const snapshot = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    const last = rows.at(-1)?.id ?? 0;
    await tx
      .update(canvases)
      .set({ ydoc: Buffer.from(snapshot), ydocUpdatedAt: at })
      .where(eq(canvases.id, canvasId));
    await tx
      .delete(canvasUpdates)
      .where(and(eq(canvasUpdates.canvasId, canvasId), lte(canvasUpdates.id, last)));
    return rows.length;
  });
}
