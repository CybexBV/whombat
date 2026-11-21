/**
 * Building a canvas Y.Doc from canvas Markdown the way the seed does: the plan bound to its block, each
 * anchored comment re-anchored on its quote and marked in the text, written with a fixed Yjs client id so the
 * result (and every relative position in it) is reproducible. The web app's fixture mode and tests build the
 * same document the seeded server serves, so the fixtures' comment anchors resolve in both.
 */
import type { CommentAnchor } from '@whombat/core';
import * as Y from 'yjs';
import { anchorForQuote, markComment } from './anchors.js';
import { markdownToDoc, type PlanLike } from './markdown.js';
import { docFromJSON } from './schema.js';
import { type CanvasMeta, readCanvas, writeCanvas } from './ydoc.js';

/** Yjs client id of documents built from Markdown by the seed (stable snapshots and anchors). */
export const SEED_CLIENT_ID = 1;

export interface BuildCanvasOptions {
  /** Title when the Markdown has no `# …` line. */
  title: string;
  /** The Plan bound to the canvas's `:::plan{…}` block. */
  plan?: PlanLike | null;
  /** Anchored comments to re-anchor on their quotes and mark, in order. */
  comments?: readonly { id: string; anchor: CommentAnchor | null }[];
  /** Yjs client id of the writer (default `SEED_CLIENT_ID`). */
  clientId?: number;
}

export interface BuiltCanvas {
  ydoc: Y.Doc;
  /** Anchors of the comments whose quote is in the document, by comment id. */
  anchors: Map<string, CommentAnchor>;
}

/** A new Y.Doc holding the canvas built from `markdown` (see the file comment). */
export function buildCanvasYDoc(markdown: string, opts: BuildCanvasOptions): BuiltCanvas {
  const plan = opts.plan ?? null;
  const json = markdownToDoc(markdown, {
    fallbackTitle: opts.title,
    plan: (id) => (plan && id === plan.id ? plan : null),
  });
  const ydoc = new Y.Doc();
  ydoc.clientID = opts.clientId ?? SEED_CLIENT_ID;
  writeCanvas(ydoc, docFromJSON(json));
  const anchors = new Map<string, CommentAnchor>();
  let { doc, meta } = readCanvas(ydoc);
  for (const c of opts.comments ?? []) {
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
  return { ydoc, anchors };
}
