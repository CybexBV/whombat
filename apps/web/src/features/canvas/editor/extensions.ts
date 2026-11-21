/**
 * The editor's extension list: the canvas schema (`@whombat/canvas-schema/tiptap`, shared with the server) with
 * the web's node views and highlight rendering, bound to the canvas Y.Doc (Collaboration) and its awareness
 * (carets, "is writing").
 */

import { type AnyExtension, Extension, mergeAttributes } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { CANVAS_FRAGMENT } from '@whombat/canvas-schema';
import { AuthorHighlight, canvasExtensions, PlanBlock, PlanStep, Title } from '@whombat/canvas-schema/tiptap';
import type { CollabUser } from '@whombat/core';
import type { CanvasCollabSession } from '../collab/types';
import { CommentFocus } from './commentFocus';
import { PlanBlockView, PlanStepView, TitleView } from './nodeViews';
import { CanvasPresence, type CollabLook } from './presence';

/** CSS custom property names of an author's highlight tint and underline (set on the editor from principals). */
export function highlightVars(authorId: string): { bg: string; line: string } {
  const id = authorId.replace(/[^A-Za-z0-9_-]/g, '_');
  return { bg: `--hl-bg-${id}`, line: `--hl-line-${id}` };
}

export interface CanvasExtensionOptions {
  session: CanvasCollabSession;
  user: CollabUser | null;
  canWrite: () => boolean;
  /** A person's tone and the agent's face, by principal id (the “is writing” tags). */
  lookOf: (principalId: string) => CollabLook | undefined;
  /** Mod-Alt-M: comment on the selection. */
  onCommentShortcut?: () => boolean;
}

/** The schema's nodes with the web's node views, and highlights tinted by author. */
const WEB_VIEWS = new Map<AnyExtension, AnyExtension>([
  [
    Title,
    Title.extend({
      addNodeView() {
        return ReactNodeViewRenderer(TitleView);
      },
    }),
  ],
  [
    PlanBlock,
    PlanBlock.extend({
      addNodeView() {
        return ReactNodeViewRenderer(PlanBlockView);
      },
    }),
  ],
  [
    PlanStep,
    PlanStep.extend({
      addNodeView() {
        return ReactNodeViewRenderer(PlanStepView, { contentDOMElementTag: 'span' });
      },
    }),
  ],
  [
    AuthorHighlight,
    AuthorHighlight.extend({
      // Tinted by the author: the editor sets `--hl-bg-<id>` / `--hl-line-<id>` for everyone it knows.
      renderHTML({ HTMLAttributes }) {
        const authorId = HTMLAttributes['data-author-id'];
        const vars = highlightVars(typeof authorId === 'string' ? authorId : '');
        return [
          'mark',
          mergeAttributes(HTMLAttributes, {
            class: 'canvas-highlight',
            style: `background: var(${vars.bg}, var(--sel)); border-bottom-color: var(${vars.line}, var(--line2))`,
          }),
          0,
        ];
      },
    }),
  ],
]);

export function canvasEditorExtensions(options: CanvasExtensionOptions): AnyExtension[] {
  const shortcuts = Extension.create({
    name: 'canvasShortcuts',
    addKeyboardShortcuts() {
      return { 'Mod-Alt-m': () => options.onCommentShortcut?.() ?? false };
    },
  });
  return [
    ...(canvasExtensions as AnyExtension[]).map((ext) => WEB_VIEWS.get(ext) ?? ext),
    Collaboration.configure({ document: options.session.ydoc, field: CANVAS_FRAGMENT }),
    CanvasPresence.configure({
      awareness: options.session.awareness,
      user: options.user,
      canWrite: options.canWrite,
      lookOf: options.lookOf,
    }),
    CommentFocus,
    shortcuts,
  ];
}
