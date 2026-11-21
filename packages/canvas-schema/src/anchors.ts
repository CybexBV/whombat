/**
 * Comment anchors and carets as Yjs relative positions (TODO 11.3). A relative position points at a Yjs
 * item, not an offset, so it keeps pointing at the same words while people and agents edit around them.
 *
 * Anchors are created at the Y level (`Y.createRelativePositionFromTypeIndex` on the paragraph's
 * Y.XmlText), which is what y-prosemirror's `absolutePositionToRelativePosition` produces for a text
 * position, so the web editor resolves them with `relativePositionToAbsolutePosition` unchanged.
 */

import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition } from '@tiptap/y-tiptap';
import type { CommentAnchor } from '@whombat/core';
import { fromBase64, toBase64 } from 'lib0/buffer';
import type { Node as PMNode } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import * as Y from 'yjs';
import { MARKS } from './names.js';
import { canvasSchema } from './schema.js';
import { type CanvasMeta, canvasFragment } from './ydoc.js';

const LEAF = '￼';

/** A Y.XmlText's content as a string (one placeholder per embed), so offsets are Yjs indexes. */
export function yTextString(text: Y.XmlText): string {
  return (text.toDelta() as { insert: unknown }[])
    .map((d) => (typeof d.insert === 'string' ? d.insert : LEAF))
    .join('');
}

function* texts(type: Y.XmlFragment | Y.XmlElement): Generator<Y.XmlText> {
  for (const child of type.toArray()) {
    if (child instanceof Y.XmlText) yield child;
    else if (child instanceof Y.XmlElement) yield* texts(child);
  }
}

/** The first Y.XmlText containing `quote` and the index where it starts. */
export function locateText(ydoc: Y.Doc, quote: string): { text: Y.XmlText; index: number } | null {
  if (!quote) return null;
  for (const text of texts(canvasFragment(ydoc))) {
    const index = yTextString(text).indexOf(quote);
    if (index >= 0) return { text, index };
  }
  return null;
}

export function encodeRelativePosition(pos: Y.RelativePosition): string {
  return toBase64(Y.encodeRelativePosition(pos));
}

export function decodeRelativePosition(encoded: string): Y.RelativePosition | null {
  try {
    return Y.decodeRelativePosition(fromBase64(encoded));
  } catch {
    return null;
  }
}

/** An anchor at the start of `quote` (null when the text is not in the document). */
export function anchorForQuote(ydoc: Y.Doc, quote: string): CommentAnchor | null {
  const at = locateText(ydoc, quote);
  if (!at) return null;
  return {
    relativePosition: encodeRelativePosition(Y.createRelativePositionFromTypeIndex(at.text, at.index)),
    quote: quote.slice(0, 500),
  };
}

export interface ResolvedAnchor {
  text: Y.XmlText;
  index: number;
  /** The document's text where the quote was (same length as the quote). */
  current: string;
  /** The quoted words are still there, unchanged. */
  intact: boolean;
}

/** Where an anchor points now; null when it cannot be decoded or its paragraph is gone. */
export function resolveAnchor(ydoc: Y.Doc, anchor: CommentAnchor): ResolvedAnchor | null {
  const rel = decodeRelativePosition(anchor.relativePosition);
  if (!rel) return null;
  const abs = Y.createAbsolutePositionFromRelativePosition(rel, ydoc);
  if (!abs || !(abs.type instanceof Y.XmlText)) return null;
  const type = abs.type;
  if (type._item?.deleted) return null;
  const current = yTextString(type).slice(abs.index, abs.index + anchor.quote.length);
  return { text: type, index: abs.index, current, intact: current === anchor.quote };
}

/** An anchor is a well-formed Yjs relative position (what the comment endpoint accepts). */
export function isRelativePosition(encoded: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  const rel = decodeRelativePosition(encoded);
  return (
    rel !== null &&
    (rel.item !== null || rel.type !== null || rel.tname !== null) &&
    encodeRelativePosition(rel) === encoded
  );
}

/** Document position → Yjs relative position JSON (the `cursor.anchor` / `cursor.head` awareness format). */
export function caretJSON(ydoc: Y.Doc, meta: CanvasMeta, pos: number): unknown {
  const rel = absolutePositionToRelativePosition(pos, canvasFragment(ydoc), meta.mapping as never);
  return Y.relativePositionToJSON(rel);
}

/** Yjs relative position (encoded anchor) → document position, or null. */
export function anchorPosition(ydoc: Y.Doc, meta: CanvasMeta, anchor: CommentAnchor): number | null {
  const rel = decodeRelativePosition(anchor.relativePosition);
  if (!rel) return null;
  return relativePositionToAbsolutePosition(ydoc, canvasFragment(ydoc), rel, meta.mapping as never);
}

/**
 * Adds the `commentAnchor` mark for a comment over its quoted words (if they are still where the anchor
 * points). Returns the new document, or null when there is nothing to mark or it is marked already.
 */
export function markComment(
  ydoc: Y.Doc,
  meta: CanvasMeta,
  doc: PMNode,
  commentId: string,
  anchor: CommentAnchor,
): PMNode | null {
  if (!anchor.quote) return null;
  const from = anchorPosition(ydoc, meta, anchor);
  if (from === null) return null;
  const to = from + anchor.quote.length;
  if (to > doc.content.size || doc.textBetween(from, to, LEAF, LEAF) !== anchor.quote) return null;
  const type = canvasSchema.marks[MARKS.commentAnchor];
  if (!type) return null;
  let marked = false;
  doc.nodesBetween(from, to, (node) => {
    if (node.isText && node.marks.some((m) => m.type === type && m.attrs.commentId === commentId))
      marked = true;
  });
  if (marked) return null;
  const tr = new Transform(doc);
  tr.addMark(from, to, type.create({ commentId }));
  return tr.docChanged ? tr.doc : null;
}

/** Removes a comment's `commentAnchor` mark (resolved comments); null when the document has none. */
export function unmarkComment(doc: PMNode, commentId: string): PMNode | null {
  const type = canvasSchema.marks[MARKS.commentAnchor];
  if (!type) return null;
  const tr = new Transform(doc);
  tr.removeMark(0, doc.content.size, type.create({ commentId }));
  return tr.docChanged ? tr.doc : null;
}
