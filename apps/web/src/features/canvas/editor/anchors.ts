/**
 * Comment anchors in the editor. An anchor is a Yjs relative position (base64) on the first quoted character —
 * the same position the server's `anchorForQuote` makes — so it keeps pointing at the same words while everyone
 * edits around them. Positions are converted with y-prosemirror's binding mapping.
 */

import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from '@tiptap/y-tiptap';
import { decodeRelativePosition, encodeRelativePosition } from '@whombat/canvas-schema';
import type { CommentAnchor } from '@whombat/core';
import * as Y from 'yjs';

interface YSyncState {
  doc: Y.Doc;
  type: Y.XmlFragment;
  binding: { mapping: Map<unknown, unknown> } | null;
}

function ysync(state: EditorState): YSyncState | null {
  const s = ySyncPluginKey.getState(state) as YSyncState | undefined;
  return s?.binding ? s : null;
}

/** The longest quote a comment keeps (contract limit). */
export const MAX_QUOTE = 500;

/** Where an anchor points in the document now (null when its words are gone). */
export function anchorPosition(state: EditorState, anchor: CommentAnchor): number | null {
  const y = ysync(state);
  const rel = decodeRelativePosition(anchor.relativePosition);
  if (!y?.binding || !rel) return null;
  try {
    const pos = relativePositionToAbsolutePosition(y.doc, y.type, rel, y.binding.mapping as never);
    return pos === null || pos > state.doc.content.size ? null : pos;
  } catch {
    return null;
  }
}

/** The anchored words, if they are still there unchanged. */
export function anchorRange(state: EditorState, anchor: CommentAnchor): { from: number; to: number } | null {
  const from = anchorPosition(state, anchor);
  if (from === null) return null;
  const to = from + anchor.quote.length;
  if (to > state.doc.content.size) return null;
  return state.doc.textBetween(from, to, '\n', '\n') === anchor.quote ? { from, to } : null;
}

export interface SelectionAnchor {
  anchor: CommentAnchor;
  from: number;
  to: number;
}

/**
 * An anchor for the selected words: the selection within its first textblock (a comment is about words in one
 * paragraph, heading, list item or plan step), trimmed of surrounding spaces. Null when nothing is selected.
 */
export function selectionAnchor(state: EditorState): SelectionAnchor | null {
  const y = ysync(state);
  const { from, to, $from, empty } = state.selection;
  if (!y?.binding || empty || !$from.parent.isTextblock) return null;
  const end = Math.min(to, $from.end());
  let start = from;
  let stop = end;
  const text = state.doc.textBetween(start, stop, '\n', '\n');
  const lead = text.length - text.trimStart().length;
  const trail = text.length - text.trimEnd().length;
  start += lead;
  stop -= trail;
  if (stop <= start) return null;
  stop = Math.min(stop, start + MAX_QUOTE);
  const quote = state.doc.textBetween(start, stop, '\n', '\n');
  // y-prosemirror associates a position with the character before it (right for carets); an anchor sticks to
  // the first quoted character instead, as the server's `anchorForQuote` makes them.
  const caretRel = absolutePositionToRelativePosition(start, y.type, y.binding.mapping as never);
  const abs = Y.createAbsolutePositionFromRelativePosition(caretRel, y.doc);
  const rel = abs ? Y.createRelativePositionFromTypeIndex(abs.type, abs.index) : caretRel;
  return { anchor: { relativePosition: encodeRelativePosition(rel), quote }, from: start, to: stop };
}

/**
 * Top of the top-level block holding `pos`, in px from the top of `container` (threads sit level with the block
 * their words are in). Null when it is not rendered.
 */
export function blockTop(view: EditorView, pos: number, container: HTMLElement): number | null {
  const doc = view.state.doc;
  if (pos < 0 || pos > doc.content.size) return null;
  const $pos = doc.resolve(pos);
  if ($pos.depth < 1) return null;
  const dom = view.nodeDOM($pos.before(1));
  if (!(dom instanceof HTMLElement)) return null;
  return dom.getBoundingClientRect().top - container.getBoundingClientRect().top;
}
