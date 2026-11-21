/**
 * Collaborators in the editor, from awareness:
 *
 * - **Carets** (y-prosemirror's cursor plugin): a 2px caret in the author's color (role accent for agents,
 *   avatar tone for people) and a tinted selection. Our own caret and selection are published as the `cursor`
 *   awareness field while the editor has focus.
 * - **"{name} is writing"**: the row someone is writing in (their caret's paragraph, list item or plan step)
 *   gets the live-edit background and a tag with their avatar, exactly like the mock's Toffee paragraph.
 * - **Our own `writing`**: set while we type, cleared a moment after we stop (and on blur).
 */

import { Extension } from '@tiptap/core';
import { isChangeOrigin } from '@tiptap/extension-collaboration';
import type { Node as PMNode } from '@tiptap/pm/model';
import { type EditorState, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { relativePositionToAbsolutePosition, yCursorPlugin, ySyncPluginKey } from '@tiptap/y-tiptap';
import { avatarUrl } from '@whombat/avatars/urls';
import { NODES } from '@whombat/canvas-schema';
import type { AgentFace, CollabUser } from '@whombat/core';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type Collaborator, collabColor, collaborators } from '../collab/users';

/** How long after the last keystroke we still count as writing. */
export const WRITING_IDLE_MS = 2500;

const HEX = /^#[0-9a-fA-F]{6}$/;

export interface CanvasPresenceOptions {
  awareness: Awareness | null;
  /** Who we are (our awareness `user`; the server stamps the same identity). */
  user: CollabUser | null;
  /** Local changes do not count as writing (read-only connection). */
  canWrite: () => boolean;
}

/** The colour of a user as y-prosemirror hands it back: the token kept aside (`tokenColor`), else its own. */
function builtColor(user: Record<string, unknown>): string {
  return typeof user.tokenColor === 'string'
    ? user.tokenColor
    : collabColor(user as Pick<CollabUser, 'color'>);
}

function caretElement(user: Record<string, unknown>): HTMLElement {
  const caret = document.createElement('span');
  caret.className = 'canvas-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.style.setProperty('--caret', builtColor(user));
  // Word joiners keep the caret on the line of the character before it (as y-prosemirror's default does).
  caret.append(document.createTextNode('⁠'), document.createElement('span'), document.createTextNode('⁠'));
  caret.children[0]?.classList.add('canvas-caret-bar');
  return caret;
}

/** How a collaborator looks beyond their awareness identity: a person's tone, the agent's face. */
export interface CollabLook {
  tone?: string | undefined;
  face?: AgentFace | undefined;
}

/** The avatar inside an "is writing" tag (the 18px small head, FA-07, or initials). */
function tagAvatar(user: CollabUser, look: CollabLook | undefined): HTMLElement {
  const box = document.createElement('span');
  box.className = 'canvas-writer-avatar';
  if (user.kind === 'agent' && look?.face) {
    // The static file as an image, never inlined: the files share gradient ids (FA-06).
    const img = document.createElement('img');
    img.src = avatarUrl(look.face, 18);
    img.alt = '';
    img.width = 18;
    img.height = 18;
    img.decoding = 'async';
    img.draggable = false;
    img.style.display = 'block';
    box.append(img);
  } else {
    box.classList.add('canvas-writer-initials');
    box.style.background = look?.tone ?? user.color;
    box.textContent = initials(user.name);
  }
  return box;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')
  ).toUpperCase();
}

function writerTags(
  writers: readonly Collaborator[],
  lookOf: (id: string) => CollabLook | undefined,
): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'canvas-writers';
  wrap.contentEditable = 'false';
  for (const w of writers) {
    const tag = document.createElement('span');
    tag.className = 'canvas-writer';
    tag.style.setProperty('--writer', collabColor(w.user));
    tag.append(
      tagAvatar(w.user, lookOf(w.user.principalId)),
      document.createTextNode(`${firstName(w.user)} is writing`),
    );
    wrap.append(tag);
  }
  return wrap;
}

/** The agent is one word ("Neo"); people go by their first name ("Mara is writing"). */
function firstName(user: CollabUser): string {
  return user.kind === 'agent' ? user.name : (user.name.split(/\s+/)[0] ?? user.name);
}

/** The row a position is in: its list item, plan step or top-level block. */
export function rowAt(doc: PMNode, pos: number): { pos: number; node: PMNode } | null {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  for (let d = $pos.depth; d >= 1; d--) {
    const node = $pos.node(d);
    if (node.type.name === NODES.listItem || node.type.name === NODES.planStep || d === 1)
      return { pos: $pos.before(d), node };
  }
  return null;
}

/** A collaborator's caret (`cursor.head`) as a document position, when the binding can resolve it. */
export function cursorPosition(state: EditorState, cursor: Collaborator['cursor']): number | null {
  const ystate = ySyncPluginKey.getState(state) as
    | { doc: Y.Doc; type: Y.XmlFragment; binding: { mapping: Map<unknown, unknown> } | null }
    | undefined;
  if (!cursor || !ystate?.binding || !cursor.head) return null;
  try {
    const rel = Y.createRelativePositionFromJSON(cursor.head);
    return relativePositionToAbsolutePosition(ystate.doc, ystate.type, rel, ystate.binding.mapping as never);
  } catch {
    return null;
  }
}

export const writersKey = new PluginKey<DecorationSet>('canvasWriters');

function writerDecorations(
  state: EditorState,
  awareness: Awareness,
  lookOf: (id: string) => CollabLook | undefined,
): DecorationSet {
  const own = awareness.clientID;
  const rows = new Map<number, { node: PMNode; writers: Collaborator[] }>();
  for (const c of collaborators(awareness)) {
    if (c.clientId === own || !c.writing) continue;
    const pos = cursorPosition(state, c.cursor);
    if (pos === null) continue;
    const row = rowAt(state.doc, pos);
    if (!row) continue;
    const entry = rows.get(row.pos) ?? { node: row.node, writers: [] };
    if (!entry.writers.some((w) => w.user.principalId === c.user.principalId)) entry.writers.push(c);
    rows.set(row.pos, entry);
  }
  const decorations: Decoration[] = [];
  for (const [pos, { node, writers }] of rows) {
    const first = writers[0] as Collaborator;
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: 'canvas-live',
        style: `--writer: ${collabColor(first.user)}`,
        'data-writing': writers.map((w) => w.user.name).join(', '),
      }),
      Decoration.widget(pos + 1, () => writerTags(writers, lookOf), {
        key: `writers-${pos}-${writers.map((w) => `${w.user.principalId}:${w.user.color}`).join('|')}`,
        side: -1,
        ignoreSelection: true,
        stopEvent: () => true,
      }),
    );
  }
  return DecorationSet.create(state.doc, decorations);
}

export const CanvasPresence = Extension.create<
  CanvasPresenceOptions & { lookOf: (principalId: string) => CollabLook | undefined },
  { timer: ReturnType<typeof setTimeout> | undefined }
>({
  name: 'canvasPresence',

  addOptions() {
    return { awareness: null, user: null, canWrite: () => true, lookOf: () => undefined };
  },

  addProseMirrorPlugins() {
    const { awareness, user, lookOf } = this.options;
    if (!awareness) return [];
    if (user) awareness.setLocalStateField('user', user);

    const carets = yCursorPlugin(awareness, {
      awarenessStateFilter: (ownId: number, clientId: number, aw: Record<string, unknown>) => {
        if (ownId === clientId) return false;
        // y-prosemirror only understands 6-digit hex colors (and warns otherwise); our colors are token
        // variables. Keep the real identity aside (`collabUser`) and hand the plugin a hex placeholder.
        const u = aw?.user as Record<string, unknown> | undefined;
        if (u && typeof u.color === 'string' && !HEX.test(u.color)) {
          aw.collabUser = u;
          aw.user = { ...u, color: '#000000', tokenColor: u.color };
        }
        return true;
      },
      cursorBuilder: (u: Record<string, unknown>) => caretElement(u),
      selectionBuilder: (u: Record<string, unknown>) => ({
        class: 'canvas-selection',
        style: `--caret: ${builtColor(u)}`,
      }),
    });

    const writers = new Plugin<DecorationSet>({
      key: writersKey,
      state: {
        init: (_, state) => writerDecorations(state, awareness, lookOf),
        apply: (tr, prev, _old, state) => {
          if (tr.getMeta(writersKey) || tr.docChanged || tr.getMeta(ySyncPluginKey))
            return writerDecorations(state, awareness, lookOf);
          return prev;
        },
      },
      props: { decorations: (state) => writersKey.getState(state) },
      view: (view) => {
        const onChange = () => {
          if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(writersKey, true));
        };
        awareness.on('change', onChange);
        return { destroy: () => awareness.off('change', onChange) };
      },
    });
    return [carets, writers];
  },

  addStorage() {
    return { timer: undefined };
  },

  onUpdate({ transaction }) {
    const { awareness, canWrite } = this.options;
    if (!awareness || !transaction.docChanged || isChangeOrigin(transaction) || !canWrite()) return;
    if (awareness.getLocalState()?.writing !== true) awareness.setLocalStateField('writing', true);
    clearTimeout(this.storage.timer);
    this.storage.timer = setTimeout(() => {
      if (awareness.getLocalState()) awareness.setLocalStateField('writing', false);
    }, WRITING_IDLE_MS);
  },

  onBlur() {
    const { awareness } = this.options;
    clearTimeout(this.storage.timer);
    if (awareness?.getLocalState()?.writing) awareness.setLocalStateField('writing', false);
  },

  onDestroy() {
    clearTimeout(this.storage.timer);
  },
});
