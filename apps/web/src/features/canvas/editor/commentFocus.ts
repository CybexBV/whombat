/**
 * Shows which words a comment is about: the text of the comment being written (the selection is gone once the
 * comment box has focus) or of the thread under the pointer gets a quiet background.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface FocusRange {
  from: number;
  to: number;
}

interface FocusState {
  range: FocusRange | null;
  set: DecorationSet;
}

export const commentFocusKey = new PluginKey<FocusState>('canvasCommentFocus');

const NONE: FocusState = { range: null, set: DecorationSet.empty };

export const CommentFocus = Extension.create({
  name: 'canvasCommentFocus',

  addProseMirrorPlugins() {
    return [
      new Plugin<FocusState>({
        key: commentFocusKey,
        state: {
          init: () => NONE,
          apply(tr, prev): FocusState {
            const meta = tr.getMeta(commentFocusKey) as { range: FocusRange | null } | undefined;
            if (meta) {
              const r = meta.range;
              if (!r || r.to <= r.from || r.to > tr.doc.content.size) return NONE;
              return {
                range: r,
                set: DecorationSet.create(tr.doc, [
                  Decoration.inline(r.from, r.to, { class: 'canvas-comment-focus' }),
                ]),
              };
            }
            if (!tr.docChanged || !prev.range) return prev;
            const from = tr.mapping.map(prev.range.from);
            const to = tr.mapping.map(prev.range.to);
            return { range: { from, to }, set: prev.set.map(tr.mapping, tr.doc) };
          },
        },
        props: { decorations: (state) => commentFocusKey.getState(state)?.set },
      }),
    ];
  },
});
