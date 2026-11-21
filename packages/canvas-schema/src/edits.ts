/**
 * Agent edits (`canvas_edit`) applied to the ProseMirror document: append, insert after a heading or text,
 * replace and delete. Text is found inside one paragraph, heading, list item or plan step; replacing words
 * with inline Markdown edits them in place (the rest of the paragraph, its marks and its comment anchors
 * stay), replacing a whole block with Markdown swaps the block.
 */
import type { CanvasEdit } from '@whombat/core';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import type * as Y from 'yjs';
import { markdownToBlocks, markdownToInline, type ParseOptions } from './markdown.js';
import { NODES } from './names.js';
import { canvasSchema, type DocJSON } from './schema.js';
import { type CanvasMeta, readCanvas, writeCanvas } from './ydoc.js';

export class CanvasEditError extends Error {}

export interface EditResult {
  doc: PMNode;
  /** Document position just after the last change (where the writer's caret rests), if any. */
  caret: number | null;
}

/** A place in a textblock where some text was found. */
export interface TextHit {
  /** Position of the textblock node. */
  blockPos: number;
  block: PMNode;
  from: number;
  to: number;
  /** The text is the whole textblock. */
  whole: boolean;
}

const LEAF = '￼';

/** A textblock's text with one placeholder per inline leaf, so string offsets map 1:1 to positions. */
function blockText(block: PMNode): string {
  let s = '';
  block.forEach((child) => {
    s += child.isText ? (child.text ?? '') : LEAF;
  });
  return s;
}

function needles(text: string): string[] {
  const out = [text];
  const stripped = text
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    .trim();
  if (stripped && stripped !== text) out.push(stripped);
  const plain = markdownToInline(stripped || text)
    .map((n) => n.text ?? '')
    .join('')
    .trim();
  if (plain && !out.includes(plain)) out.push(plain);
  return out;
}

/** Finds text in the document: a whole textblock equal to it first, then the first textblock containing it. */
export function findText(doc: PMNode, text: string): TextHit | null {
  for (const needle of needles(text)) {
    if (!needle) continue;
    let exact: TextHit | null = null;
    let partial: TextHit | null = null;
    doc.descendants((node, pos) => {
      if (exact) return false;
      if (!node.isTextblock) return true;
      const s = blockText(node);
      if (s.trim() === needle.trim() && s.length > 0) {
        const lead = s.length - s.trimStart().length;
        exact = {
          blockPos: pos,
          block: node,
          from: pos + 1 + lead,
          to: pos + 1 + lead + s.trim().length,
          whole: true,
        };
        return false;
      }
      if (!partial) {
        const at = s.indexOf(needle);
        if (at >= 0)
          partial = {
            blockPos: pos,
            block: node,
            from: pos + 1 + at,
            to: pos + 1 + at + needle.length,
            whole: needle.length === s.length,
          };
      }
      return false;
    });
    const hit = exact ?? partial;
    if (hit) return hit;
  }
  return null;
}

function nodesFrom(json: DocJSON[]): PMNode[] {
  return json.map((j) => {
    const n = canvasSchema.nodeFromJSON(j);
    n.check();
    return n;
  });
}

/** The top-level block (depth 1) around a position, and its position. */
function topLevel(doc: PMNode, pos: number): { node: PMNode; pos: number } {
  const $pos = doc.resolve(pos);
  if ($pos.depth < 1) throw new CanvasEditError('That text is not in a block.');
  return { node: $pos.node(1), pos: $pos.before(1) };
}

/** The unit a whole-block edit replaces or removes: the list item, plan step or top-level block. */
function unitOf(
  doc: PMNode,
  hit: TextHit,
): { node: PMNode; pos: number; kind: 'listItem' | 'planStep' | 'title' | 'block' } {
  const $pos = doc.resolve(hit.blockPos + 1);
  const name = hit.block.type.name;
  if (name === NODES.title) return { node: hit.block, pos: hit.blockPos, kind: 'title' };
  if (name === NODES.planStep) return { node: hit.block, pos: hit.blockPos, kind: 'planStep' };
  for (let d = $pos.depth - 1; d >= 1; d--) {
    const n = $pos.node(d);
    if (n.type.name === NODES.listItem && n.firstChild === hit.block)
      return { node: n, pos: $pos.before(d), kind: 'listItem' };
  }
  return { ...topLevel(doc, hit.blockPos + 1), kind: 'block' };
}

/** End of the last textblock in [from, to): where a writer's caret rests after inserting that range. */
function lastTextEnd(doc: PMNode, from: number, to: number): number | null {
  let end: number | null = null;
  doc.nodesBetween(from, Math.min(to, doc.content.size), (node, pos) => {
    if (node.isTextblock) {
      end = pos + node.nodeSize - 1;
      return false;
    }
    return true;
  });
  return end;
}

function inlineFor(parent: PMNode, json: DocJSON[]): PMNode[] {
  const nodes: PMNode[] = [];
  for (const j of json) {
    if (j.type === NODES.text) {
      const marks = (j.marks ?? [])
        .map((m) => canvasSchema.markFromJSON(m))
        .filter((m) => parent.type.allowsMarkType(m.type));
      if (j.text) nodes.push(canvasSchema.text(j.text, marks));
    } else if (parent.type.contentMatch.matchType(canvasSchema.nodes[j.type] as never)) {
      nodes.push(canvasSchema.nodeFromJSON(j));
    }
  }
  return nodes;
}

function removeUnit(tr: Transform, unit: ReturnType<typeof unitOf>): number {
  if (unit.kind === 'title') throw new CanvasEditError('The title can be changed, not removed.');
  const $pos = tr.doc.resolve(unit.pos);
  const parent = $pos.parent;
  // Removing the only item of a list removes the list.
  if (unit.kind === 'listItem' && parent.childCount === 1) {
    const list = topLevel(tr.doc, unit.pos + 1);
    if (list.node === parent) {
      tr.delete(list.pos, list.pos + list.node.nodeSize);
      return list.pos;
    }
    tr.delete($pos.before(), $pos.after());
    return $pos.before();
  }
  tr.delete(unit.pos, unit.pos + unit.node.nodeSize);
  // The document needs at least one block after the title.
  if (tr.doc.childCount === 1)
    tr.insert(tr.doc.content.size, canvasSchema.nodes.paragraph?.create() as PMNode);
  return unit.pos;
}

function replaceInline(tr: Transform, hit: TextHit, markdown: string, opts: ParseOptions): number {
  const inline = inlineFor(hit.block, markdownToInline(markdown, opts));
  if (inline.length) tr.replaceWith(hit.from, hit.to, inline);
  else tr.delete(hit.from, hit.to);
  return hit.from + inline.reduce((n, node) => n + node.nodeSize, 0);
}

/** Insert blocks after the unit that holds `hit`: into its list when the new blocks are items of the same kind. */
function insertAfter(tr: Transform, hit: TextHit, blocks: PMNode[]): { from: number; to: number } {
  const unit = unitOf(tr.doc, hit);
  if (unit.kind === 'listItem' && blocks.length === 1) {
    const list = tr.doc.resolve(unit.pos).parent;
    const only = blocks[0] as PMNode;
    if (only.type === list.type) {
      const at = unit.pos + unit.node.nodeSize;
      tr.insert(at, only.content);
      return { from: at, to: at + only.content.size };
    }
  }
  const at =
    unit.kind === 'title'
      ? unit.pos + unit.node.nodeSize
      : (() => {
          const top = topLevel(tr.doc, unit.pos + 1);
          return top.pos + top.node.nodeSize;
        })();
  const fragment = Fragment.fromArray(blocks);
  tr.insert(at, fragment);
  return { from: at, to: at + fragment.size };
}

/** Deletes found text: the whole unit (list item, step, block) when the text is all of it. */
function deleteHit(tr: Transform, hit: TextHit): number {
  if (hit.block.type.name === NODES.title && hit.whole)
    throw new CanvasEditError('The title can be changed, not removed.');
  if (hit.whole) return removeUnit(tr, unitOf(tr.doc, hit));
  tr.delete(hit.from, hit.to);
  return hit.from;
}

/** Applies `edits` in order. Throws `CanvasEditError` (with a message for the agent) when one cannot apply. */
export function applyEdits(doc: PMNode, edits: readonly CanvasEdit[], opts: ParseOptions = {}): EditResult {
  const tr = new Transform(doc);
  let caret: number | null = null;
  const blocksOf = (markdown: string) => {
    const blocks = nodesFrom(markdownToBlocks(markdown, opts));
    if (!blocks.length) throw new CanvasEditError('There is nothing to write.');
    return blocks;
  };
  const find = (text: string) => {
    const hit = findText(tr.doc, text);
    if (!hit) throw new CanvasEditError(`Couldn’t find “${text}” in the canvas.`);
    return hit;
  };

  for (const edit of edits) {
    switch (edit.op) {
      case 'append': {
        const blocks = blocksOf(edit.markdown);
        const at = tr.doc.content.size;
        const fragment = Fragment.fromArray(blocks);
        tr.insert(at, fragment);
        caret = lastTextEnd(tr.doc, at, at + fragment.size);
        break;
      }
      case 'insert_after': {
        const hit = find(edit.after);
        const range = insertAfter(tr, hit, blocksOf(edit.markdown));
        caret = lastTextEnd(tr.doc, range.from, range.to);
        break;
      }
      case 'replace': {
        const hit = find(edit.find);
        if (!edit.markdown.trim()) {
          caret = deleteHit(tr, hit);
          break;
        }
        const blocks = markdownToBlocks(edit.markdown, opts);
        const single = blocks.length === 1 && blocks[0]?.type === NODES.paragraph;
        if (single || hit.block.type.name === NODES.title || hit.block.type.name === NODES.planStep) {
          if (!single) throw new CanvasEditError('Replace a title or plan step with plain text.');
          caret = replaceInline(tr, hit, edit.markdown, opts);
          break;
        }
        if (!hit.whole)
          throw new CanvasEditError(
            'Replace part of a paragraph with plain text, or the whole paragraph with blocks.',
          );
        const unit = unitOf(tr.doc, hit);
        const nodes = nodesFrom(blocks);
        if (unit.kind === 'listItem') {
          const list = tr.doc.resolve(unit.pos).parent;
          const only = nodes[0] as PMNode;
          const items = nodes.length === 1 && only.type === list.type ? only.content : null;
          if (items) {
            tr.replaceWith(unit.pos, unit.pos + unit.node.nodeSize, items);
            caret = lastTextEnd(tr.doc, unit.pos, unit.pos + items.size);
            break;
          }
          // Blocks that are not items of this list go after the list; the item goes.
          const top = topLevel(tr.doc, unit.pos + 1);
          const at = top.pos + top.node.nodeSize;
          const fragment = Fragment.fromArray(nodes);
          tr.insert(at, fragment);
          const mark = tr.steps.length;
          removeUnit(tr, unit);
          const moved = tr.mapping.slice(mark);
          caret = lastTextEnd(tr.doc, moved.map(at), moved.map(at + fragment.size));
          break;
        }
        const fragment = Fragment.fromArray(nodes);
        tr.replaceWith(unit.pos, unit.pos + unit.node.nodeSize, fragment);
        caret = lastTextEnd(tr.doc, unit.pos, unit.pos + fragment.size);
        break;
      }
      case 'delete': {
        caret = deleteHit(tr, find(edit.find));
        break;
      }
    }
  }
  const out = tr.doc;
  out.check();
  return { doc: out, caret };
}

export interface YEditResult extends EditResult {
  meta: CanvasMeta;
}

/**
 * Applies `edits` to a Y.Doc one at a time, each written as its own minimal diff — what an editor produces
 * when a person makes the same changes one after another. Writing several edits as one diff can make the
 * binding rewrite a neighbouring paragraph in place, which would move the comment anchors in it. Throws
 * `CanvasEditError` like `applyEdits`; edits before the failing one are already written, so apply to a
 * scratch copy when it has to be all or nothing.
 */
export function applyEditsToYDoc(
  ydoc: Y.Doc,
  edits: readonly CanvasEdit[],
  opts: ParseOptions = {},
): YEditResult {
  let { doc, meta } = readCanvas(ydoc);
  let caret: number | null = null;
  for (const edit of edits) {
    const result = applyEdits(doc, [edit], opts);
    meta = writeCanvas(ydoc, result.doc, meta);
    doc = result.doc;
    caret = result.caret;
  }
  return { doc, meta, caret };
}
