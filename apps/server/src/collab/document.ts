/**
 * Server-side helpers over `@whombat/canvas-schema`: building a canvas document from its Markdown (seed,
 * canvases created before they were ever opened), exporting it back (`canvas_read`, the `markdown` column,
 * search), and copying a state into a scratch Y.Doc for edits computed inside a commit.
 */
import {
  anchorForQuote,
  type CanvasMeta,
  type CanvasNode,
  createCanvasYDoc,
  type DocJSON,
  docFromJSON,
  docToMarkdown,
  docToPlainText,
  markComment,
  markdownToDoc,
  type PlanLike,
  readCanvas,
  writeCanvas,
} from '@whombat/canvas-schema';
import type { CommentAnchor } from '@whombat/core';
import { eq } from 'drizzle-orm';

import * as Y from 'yjs';
import type { Db } from '../db/client';
import { principals } from '../db/schema/index';

/** Yjs client id used for documents built by the seed, so seeded snapshots and anchors are reproducible. */
export const SEED_CLIENT_ID = 1;

export interface BuildOptions {
  title: string;
  plan?: PlanLike | null;
}

/** Canvas Markdown → ProseMirror JSON, with the canvas's plan bound to its `:::plan{…}` block. */
export function canvasJSON(markdown: string, opts: BuildOptions): DocJSON {
  const plan = opts.plan ?? null;
  return markdownToDoc(markdown, {
    fallbackTitle: opts.title,
    plan: (id) => (plan && id === plan.id ? plan : null),
  });
}

/** A scratch copy of a Yjs state (edits on it become updates for the real document). */
export function scratchDoc(state: Uint8Array | null): Y.Doc {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, state);
  return doc;
}

/** Principal id → display name, for the plan block listing in exported Markdown. */
export async function principalNames(db: Db, burrowId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: principals.id, name: principals.name })
    .from(principals)
    .where(eq(principals.burrowId, burrowId));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export function exportMarkdown(doc: CanvasNode, _names: ReadonlyMap<string, string>): string {
  return docToMarkdown(doc);
}

/** Plain text of canvas Markdown (what the search index stores). */
export function markdownPlainText(markdown: string): string {
  try {
    return docToPlainText(docFromJSON(markdownToDoc(markdown)));
  } catch {
    return markdown;
  }
}

export interface SeededCanvasDoc {
  /** `Y.encodeStateAsUpdate` of the document. */
  state: Uint8Array;
  /** The document exported back to canvas Markdown. */
  markdown: string;
  /** Real anchors for the comments whose quote is in the document (by comment id). */
  anchors: Map<string, CommentAnchor>;
}

/**
 * The Yjs document of a seeded canvas: its Markdown with the plan bound, each anchored comment re-anchored
 * on its quote (the fixture's relative positions are placeholders) and marked in the text.
 */
export function seedCanvasDocument(
  markdown: string,
  opts: BuildOptions & {
    comments: readonly { id: string; anchor: CommentAnchor | null }[];
    names: ReadonlyMap<string, string>;
  },
): SeededCanvasDoc {
  const json = canvasJSON(markdown, opts);
  const ydoc = new Y.Doc();
  ydoc.clientID = SEED_CLIENT_ID;
  writeCanvas(ydoc, docFromJSON(json));
  const anchors = new Map<string, CommentAnchor>();
  let { doc, meta } = readCanvas(ydoc);
  for (const c of opts.comments) {
    if (!c.anchor?.quote) continue;
    const anchor = anchorForQuote(ydoc, c.anchor.quote);
    if (!anchor) continue;
    anchors.set(c.id, anchor);
    const marked = markComment(ydoc, meta, doc, c.id, anchor);
    if (marked) {
      meta = writeCanvas(ydoc, marked, meta) as CanvasMeta;
      doc = marked;
    }
  }
  const state = Y.encodeStateAsUpdate(ydoc);
  ydoc.destroy();
  return { state, markdown: exportMarkdown(doc, opts.names), anchors };
}

/** A canvas never opened since it was created: its document built from the Markdown it was created with. */
export function initialCanvasState(markdown: string, opts: BuildOptions): Uint8Array {
  const ydoc = createCanvasYDoc(canvasJSON(markdown, opts));
  const state = Y.encodeStateAsUpdate(ydoc);
  ydoc.destroy();
  return state;
}
