/**
 * Reading and writing the canvas Y.Doc as ProseMirror documents, encoded exactly as Tiptap's Collaboration
 * extension (y-tiptap) does, so server-side edits and the web editor share one document.
 *
 * Writes are diffs: `writeCanvas` reconciles the Y.XmlFragment with a new ProseMirror document the way the
 * editor binding does, so untouched paragraphs keep their Yjs items (and every relative position in them —
 * comment anchors and carets survive).
 */
import { initProseMirrorDoc, updateYFragment } from '@tiptap/y-tiptap';
import type { NodeType, Node as PMNode } from 'prosemirror-model';
import * as Y from 'yjs';
import { markdownToDoc } from './markdown.js';
import { CANVAS_FRAGMENT } from './names.js';
import { canvasSchema, type DocJSON, docFromJSON } from './schema.js';

/** y-tiptap's binding metadata: Y type → ProseMirror node, and which mark types overlap. */
export interface CanvasMeta {
  mapping: Map<Y.AbstractType<unknown>, PMNode | PMNode[]>;
  isOMark: Map<unknown, boolean>;
}

export interface CanvasSnapshot {
  doc: PMNode;
  meta: CanvasMeta;
}

export function canvasFragment(ydoc: Y.Doc): Y.XmlFragment {
  return ydoc.getXmlFragment(CANVAS_FRAGMENT);
}

function emptyMeta(): CanvasMeta {
  return { mapping: new Map(), isOMark: new Map() };
}

/** Fills in what the schema requires (a missing title, an empty body) without touching valid documents. */
export function normalizeDoc(doc: PMNode): PMNode {
  try {
    doc.check();
    return doc;
  } catch {
    // rebuild below
  }
  const { title, paragraph } = canvasSchema.nodes as Record<string, NodeType>;
  const first = doc.firstChild;
  const titleNode: PMNode =
    first && first.type === title
      ? first
      : (title as NodeType).create(
          null,
          first?.isTextblock && first.textContent ? canvasSchema.text(first.textContent) : null,
        );
  const blocks: PMNode[] = [];
  doc.forEach((n, _offset, index) => {
    if (n.type === title || (index === 0 && titleNode !== first && n.isTextblock)) return;
    if (n.type.isInGroup('block')) blocks.push(n);
  });
  const rebuilt = canvasSchema.topNodeType.create(null, [
    titleNode,
    ...(blocks.length ? blocks : [(paragraph as NodeType).create()]),
  ]);
  try {
    rebuilt.check();
    return rebuilt;
  } catch {
    return docFromJSON(markdownToDoc(doc.textContent));
  }
}

/** The document in a Y.Doc, with the binding metadata `writeCanvas` needs to diff against it. */
export function readCanvas(ydoc: Y.Doc): CanvasSnapshot {
  const fragment = canvasFragment(ydoc);
  if (fragment.length === 0) return { doc: docFromJSON(markdownToDoc('')), meta: emptyMeta() };
  const { doc, meta } = initProseMirrorDoc(fragment, canvasSchema) as unknown as {
    doc: PMNode;
    meta: CanvasMeta;
  };
  const normalized = normalizeDoc(doc);
  return { doc: normalized, meta: normalized === doc ? meta : emptyMeta() };
}

/** Reconciles the Y.Doc with `doc` (a minimal diff). Returns the metadata mapping Y types to the new nodes. */
export function writeCanvas(
  ydoc: Y.Doc,
  doc: PMNode,
  meta: CanvasMeta = emptyMeta(),
  origin?: unknown,
): CanvasMeta {
  const fragment = canvasFragment(ydoc);
  ydoc.transact(() => {
    updateYFragment(ydoc, fragment, doc, meta as never);
  }, origin);
  return meta;
}

/** A new Y.Doc holding `json`. */
export function createCanvasYDoc(json: DocJSON): Y.Doc {
  const ydoc = new Y.Doc();
  writeCanvas(ydoc, docFromJSON(json));
  return ydoc;
}

/** The Yjs update that creates `json` (what the seed stores as the canvas snapshot). */
export function canvasUpdateFromJSON(json: DocJSON): Uint8Array {
  const ydoc = createCanvasYDoc(json);
  const update = Y.encodeStateAsUpdate(ydoc);
  ydoc.destroy();
  return update;
}

/** The document inside a stored Yjs state (snapshot or merged updates). */
export function docFromUpdate(update: Uint8Array): PMNode {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, update);
  const { doc } = readCanvas(ydoc);
  ydoc.destroy();
  return doc;
}
