/**
 * The live canvas article: a Tiptap editor on the canvas schema, bound to the collaboration session's Y.Doc
 * and awareness. Layout and type follow the reference article (h1 + provenance, h2 sections, 17px body, plan
 * rows, rules with bullets); highlights are tinted by their author's role.
 */

import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import './prosemirror-base.css';
import type { CollabUser } from '@whombat/core';
import { type CSSProperties, useEffect, useMemo, useRef } from 'react';
import type { CanvasCollabSession } from '../collab/types';
import type { PrincipalLite } from '../principals';
import styles from './CanvasEditor.module.css';
import { canvasEditorExtensions, highlightVars } from './extensions';

export interface CanvasEditorProps {
  session: CanvasCollabSession;
  /** Our awareness identity (null until known; the server stamps it anyway). */
  user: CollabUser | null;
  editable: boolean;
  principals: Map<string, PrincipalLite>;
  /** The editor instance, once created (and null when it goes). */
  onEditor?: (editor: Editor | null) => void;
  /** Mod-Alt-M in the editor. */
  onCommentShortcut?: () => boolean;
  className?: string;
}

/**
 * Highlight tint of an author: the agent's face's accent at the editor's `--tint-share` (16 % light, 24 % dark) — Dusty
 * keeps the mock's mark — people the brand (OA-08).
 */
export function highlightTint(p: PrincipalLite): { bg: string; line: string } {
  if (p.kind === 'agent' && p.face) {
    const bg =
      p.face === 'dusty'
        ? 'var(--mark)'
        : `color-mix(in srgb, var(--face-${p.face}) var(--tint-share), transparent)`;
    return { bg, line: `var(--face-${p.face})` };
  }
  return { bg: 'var(--tint-person)', line: 'var(--brand)' };
}

export function CanvasEditor({
  session,
  user,
  editable,
  principals,
  onEditor,
  onCommentShortcut,
  className,
}: CanvasEditorProps) {
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const principalsRef = useRef(principals);
  principalsRef.current = principals;
  const shortcutRef = useRef(onCommentShortcut);
  shortcutRef.current = onCommentShortcut;
  const userRef = useRef(user);
  userRef.current = user;

  const editor = useEditor(
    {
      extensions: canvasEditorExtensions({
        session,
        user: userRef.current,
        canWrite: () => editableRef.current,
        lookOf: (id) => principalsRef.current.get(id),
        onCommentShortcut: () => shortcutRef.current?.() ?? false,
      }),
      editable: editableRef.current,
      // The base CSS ships in prosemirror-base.css (no inline <style> under the hosted CSP, AP-23).
      injectCSS: false,
      editorProps: {
        attributes: {
          class: styles.prose as string,
          'aria-label': 'Canvas',
        },
      },
    },
    [session],
  );

  useEffect(() => {
    if (editor && !editor.isDestroyed && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (user) session.awareness.setLocalStateField('user', user);
  }, [session, user]);

  useEffect(() => {
    onEditor?.(editor);
    return () => onEditor?.(null);
  }, [editor, onEditor]);

  const style = useMemo(() => {
    const vars: Record<string, string> = {};
    for (const p of principals.values()) {
      const names = highlightVars(p.id);
      const tint = highlightTint(p);
      vars[names.bg] = tint.bg;
      vars[names.line] = tint.line;
    }
    return vars as CSSProperties;
  }, [principals]);

  return (
    <div className={[styles.editor, className].filter(Boolean).join(' ')} style={style}>
      <EditorContent editor={editor} />
    </div>
  );
}
