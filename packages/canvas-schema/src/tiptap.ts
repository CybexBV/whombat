/**
 * The canvas document as Tiptap extensions: the single source of the schema. The web editor uses
 * `canvasExtensions` (plus Collaboration / CollaborationCaret and its own node views); the server builds the
 * same ProseMirror schema from them (`canvasSchema`) to read and write the Y.Doc.
 *
 *   doc        title block+
 *   title      the article h1 ("Invoice PDF export"), plain text
 *   block      paragraph | heading (h2, h3) | bulletList | orderedList | planBlock
 *   planBlock  planStep*  — bound to a Plan (`planId`); the server keeps it in step with the Plan
 *   planStep   text*      — one step: `stepId`, `state`, `stateLabel` (from the Plan)
 *   marks      bold, italic, code, authorHighlight (`authorId`), commentAnchor (`commentId`, overlapping)
 *
 * Only schema-level configuration lives here (names, content, attributes, HTML parse/render). Keyboard
 * behaviour and node views are the web editor's.
 */
import { Mark, mergeAttributes, Node } from '@tiptap/core';
import Bold from '@tiptap/extension-bold';
import Code from '@tiptap/extension-code';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Heading from '@tiptap/extension-heading';
import Italic from '@tiptap/extension-italic';
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { CANVAS_HEADING_LEVELS, PLAN_STEP_STATES } from './names.js';

/** `doc` starts with the article title. */
export const CanvasDocument = Document.extend({ content: 'title block+' });

/** The article h1. Plain text: no marks, no line breaks. */
export const Title = Node.create({
  name: 'title',
  content: 'text*',
  marks: '',
  defining: true,
  parseHTML() {
    return [{ tag: 'h1' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['h1', mergeAttributes(HTMLAttributes), 0];
  },
});

const dataAttr = (name: string, attr: string, fallback: unknown = null) => ({
  default: fallback,
  keepOnSplit: false,
  parseHTML: (el: { getAttribute(name: string): string | null }) => el.getAttribute(attr) ?? fallback,
  renderHTML: (attrs: Record<string, unknown>) =>
    attrs[name] == null ? {} : { [attr]: String(attrs[name]) },
});

/** A plan rendered from its Plan object; the steps are editable text (edits update the Plan). */
export const PlanBlock = Node.create({
  name: 'planBlock',
  group: 'block',
  content: 'planStep*',
  isolating: true,
  defining: true,
  addAttributes() {
    return { planId: dataAttr('planId', 'data-plan-id') };
  },
  parseHTML() {
    return [{ tag: 'div[data-plan-id]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-type': 'plan-block' }, HTMLAttributes), 0];
  },
});

/** One plan step. `stepId` is null for a step typed into the block that the Plan does not have yet. */
export const PlanStep = Node.create({
  name: 'planStep',
  content: 'text*',
  marks: 'commentAnchor',
  defining: true,
  addAttributes() {
    return {
      stepId: dataAttr('stepId', 'data-step-id'),
      state: dataAttr('state', 'data-state', 'queued'),
      stateLabel: dataAttr('stateLabel', 'data-state-label', 'Queued'),
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="plan-step"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-type': 'plan-step' }, HTMLAttributes), 0];
  },
});

/** Text a principal highlighted; tinted by the author's role ("Rules to keep" in the mock). */
export const AuthorHighlight = Mark.create({
  name: 'authorHighlight',
  inclusive: false,
  addAttributes() {
    return { authorId: dataAttr('authorId', 'data-author-id') };
  },
  parseHTML() {
    return [{ tag: 'mark[data-author-id]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['mark', mergeAttributes(HTMLAttributes), 0];
  },
});

/** The text a side comment is about. Overlapping: several comments can cover the same words. */
export const CommentAnchorMark = Mark.create({
  name: 'commentAnchor',
  inclusive: false,
  excludes: '',
  addAttributes() {
    return { commentId: dataAttr('commentId', 'data-comment-id') };
  },
  parseHTML() {
    return [{ tag: 'span[data-comment-id]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },
});

/** Every extension that shapes the canvas schema, in schema order. */
export const canvasExtensions = [
  CanvasDocument,
  Title,
  Paragraph,
  Text,
  Heading.configure({ levels: [...CANVAS_HEADING_LEVELS] }),
  BulletList,
  OrderedList,
  ListItem,
  HardBreak,
  PlanBlock,
  PlanStep,
  Bold,
  Italic,
  Code,
  AuthorHighlight,
  CommentAnchorMark,
];

export { PLAN_STEP_STATES };
