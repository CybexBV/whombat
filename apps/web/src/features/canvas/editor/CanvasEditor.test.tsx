/**
 * The live editor on a local Yjs hub: two people on one canvas see each other's text, carets and "is writing";
 * the plan block shows the live Plan and edits it through the document; highlights are tinted by author;
 * read-only connections cannot type.
 */

import { act, render, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { buildCanvasYDoc, readCanvas } from '@whombat/canvas-schema';
import type { Plan } from '@whombat/core/domain';
import { CANVAS_MARKDOWN, canvas, dusty, mara, plan } from '@whombat/fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import '../test/jsdom';
import { LocalCollabHub } from '../collab/local';
import type { CanvasCollabSession } from '../collab/types';
import { collabUserOf } from '../collab/users';
import type { PrincipalLite } from '../principals';
import { CanvasEditor } from './CanvasEditor';
import { CanvasViewContext } from './context';

const PRINCIPALS = new Map<string, PrincipalLite>([
  [
    mara.id,
    { id: mara.id, kind: 'person', name: mara.name, shortName: 'Mara', initials: 'MO', tone: mara.tone },
  ],
  [
    dusty.id,
    { id: dusty.id, kind: 'agent', name: 'Dusty', shortName: 'Dusty', initials: 'DU', face: 'dusty' },
  ],
]);

const MARA = collabUserOf({ id: mara.id, kind: 'person', name: mara.name, tone: mara.tone });
const DUSTY = collabUserOf({ id: dusty.id, kind: 'agent', name: 'Dusty', face: 'dusty' });

let hub: LocalCollabHub | null = null;
afterEach(() => {
  hub?.destroy();
  hub = null;
});

function openHub(): LocalCollabHub {
  const { ydoc } = buildCanvasYDoc(CANVAS_MARKDOWN[canvas.id] ?? '', { title: canvas.title, plan });
  hub = new LocalCollabHub(ydoc);
  ydoc.destroy();
  return hub;
}

function mount(
  session: CanvasCollabSession,
  user = MARA,
  opts: { editable?: boolean; plan?: Plan } = {},
): { container: HTMLElement; editor: () => Editor } {
  let instance: Editor | null = null;
  const { container } = render(
    <CanvasViewContext.Provider
      value={{ principals: PRINCIPALS, plan: opts.plan ?? plan, provenance: 'Drafted by Dusty' }}
    >
      <CanvasEditor
        session={session}
        user={user}
        editable={opts.editable ?? true}
        principals={PRINCIPALS}
        onEditor={(e) => {
          instance = e ?? instance;
        }}
      />
    </CanvasViewContext.Provider>,
  );
  return {
    container,
    editor: () => {
      if (!instance) throw new Error('editor not ready');
      return instance;
    },
  };
}

/** Document position right after `text` (first occurrence). */
function after(editor: Editor, text: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text?.includes(text)) found = pos + (node.text.indexOf(text) + text.length);
    return true;
  });
  if (found < 0) throw new Error(`no “${text}”`);
  return found;
}

describe('CanvasEditor on a local hub', () => {
  it('shows what the other person types, their caret and that they are writing', async () => {
    const h = openHub();
    const a = mount(h.join(), MARA);
    const b = mount(h.join(), DUSTY);
    await waitFor(() => {
      a.editor();
      b.editor();
    });

    // Dusty types at the end of the third rule.
    act(() => {
      const ed = b.editor();
      const pos = after(ed, 'keyed by invoice number and locale');
      ed.chain().focus().insertContentAt(pos, ' (and currency)').run();
    });
    await waitFor(() =>
      expect(a.container.textContent).toContain('keyed by invoice number and locale (and currency)'),
    );

    // Its caret, in its face's accent, and the "Dusty is writing" tag on that rule (hi background).
    await waitFor(() => {
      const caret = a.container.querySelector('.canvas-caret') as HTMLElement | null;
      expect(caret?.style.getPropertyValue('--caret')).toBe('var(--face-dusty)');
    });
    await waitFor(() =>
      expect(a.container.querySelector('.canvas-writer')?.textContent).toBe('Dusty is writing'),
    );
    const live = a.container.querySelector('.canvas-live') as HTMLElement;
    expect(live.tagName).toBe('LI');
    expect(live.textContent).toContain('(and currency)');
    // Our own writing is not tagged on our side.
    expect(b.container.querySelector('.canvas-writer')).toBeNull();

    // Mara edits too: Dusty sees it.
    act(() => {
      const ed = a.editor();
      ed.chain().insertContentAt(after(ed, 'Credit notes and bulk export.'), ' Refunds too.').run();
    });
    await waitFor(() =>
      expect(b.container.textContent).toContain('Credit notes and bulk export. Refunds too.'),
    );
  });

  it('cannot be edited on a read-only connection', async () => {
    const h = openHub();
    const reader = h.join({ scope: 'readonly' });
    const writer = h.join();
    const r = mount(reader, MARA, { editable: false });
    await waitFor(() => r.editor());
    const dom = r.container.querySelector('[contenteditable]') as HTMLElement;
    expect(dom.getAttribute('contenteditable')).toBe('false');
    // Changes a read-only peer makes locally never reach the others (as the server drops them).
    act(() => {
      r.editor().commands.insertContentAt(after(r.editor(), 'Out of scope'), '!');
    });
    expect(readCanvas(writer.ydoc).doc.textContent).not.toContain('Out of scope!');
  });
});
