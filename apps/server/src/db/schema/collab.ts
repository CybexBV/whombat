/**
 * Collaborative canvas storage (TODO 11.1). A canvas's Y.Doc is its snapshot (`canvases.ydoc`) plus the
 * incremental Yjs updates appended since (`canvas_updates`, in `id` order). Compaction folds the updates
 * into a new snapshot and deletes them. `author_id` is who made the update (null for the server itself:
 * plan sync, seeding); the signed `canvas.edited` events are the audit trail.
 */
import { bigserial, index, pgTable, text } from 'drizzle-orm/pg-core';
import { bytea, ts } from './common';
import { canvases } from './content';

export const canvasUpdates = pgTable(
  'canvas_updates',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    canvasId: text('canvas_id')
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    update: bytea('update').notNull(),
    authorId: text('author_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('canvas_updates_canvas_idx').on(t.canvasId, t.id)],
);
