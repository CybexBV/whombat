/** Names shared by the schema, the Y.Doc helpers and the web editor. */
import { PlanStepState } from '@whombat/core';

/** The Y.XmlFragment holding the document (Tiptap Collaboration's default `field`). */
export const CANVAS_FRAGMENT = 'default';

export const NODES = {
  doc: 'doc',
  title: 'title',
  paragraph: 'paragraph',
  heading: 'heading',
  bulletList: 'bulletList',
  orderedList: 'orderedList',
  listItem: 'listItem',
  hardBreak: 'hardBreak',
  planBlock: 'planBlock',
  planStep: 'planStep',
  text: 'text',
} as const;

export const MARKS = {
  bold: 'bold',
  italic: 'italic',
  code: 'code',
  authorHighlight: 'authorHighlight',
  commentAnchor: 'commentAnchor',
} as const;

/** Section headings are h2 and h3; the h1 is the `title` node. */
export const CANVAS_HEADING_LEVELS = [2, 3] as const;

/** Plan step states, core's `PlanStepState`. */
export const PLAN_STEP_STATES: readonly PlanStepState[] = PlanStepState.options;
