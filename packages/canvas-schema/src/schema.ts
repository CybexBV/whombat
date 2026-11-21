/** The ProseMirror schema of a canvas, built from the same Tiptap extensions the web editor uses. */
import { getSchema } from '@tiptap/core';
import type { Node as PMNode, Schema } from 'prosemirror-model';
import { canvasExtensions } from './tiptap.js';

export const canvasSchema: Schema = getSchema(canvasExtensions);

/** A canvas document (or any node in it). */
export type CanvasNode = PMNode;

/** ProseMirror JSON (`Node.toJSON()`). */
export interface DocJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocJSON[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

/** Parses ProseMirror JSON into a checked canvas document node (throws on schema violations). */
export function docFromJSON(json: DocJSON): PMNode {
  const node = canvasSchema.nodeFromJSON(json);
  node.check();
  return node;
}
