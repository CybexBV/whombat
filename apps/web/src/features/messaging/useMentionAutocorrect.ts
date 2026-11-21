import { autocorrectComposerMention } from '@whombat/client';
import type { MentionTarget } from '@whombat/core';
import { type ChangeEvent, type RefObject, useCallback, useLayoutEffect, useRef } from 'react';

interface Correction {
  /** The field's text the correction was made for: applied only while the field still holds it. */
  expected: string;
  text: string;
  caret: number;
}

/**
 * The composer's auto-correct for mentions in another letter case on a `<textarea>` (docs/decisions/app-managed.md
 * AP-607; Whombat messaging.md MS-C03): typing `@banjo ` leaves `@Banjo ` with the caret where it was. Call the
 * returned function from the field's `onChange` with the text before the change (after passing the new text on).
 *
 * The correction is applied once React has rendered the typed text, as an edit of the field (`insertText` over the
 * word), so Ctrl+Z / ⌘Z takes it back like any auto-correct. Where the browser can't (no `execCommand`), the text is
 * set through `setValue` and the caret put back. Deletions and open IME compositions are left alone.
 */
export function useMentionAutocorrect(
  ref: RefObject<HTMLTextAreaElement | null>,
  targets: readonly MentionTarget[],
  setValue: (text: string) => void,
  onCaret?: (caret: number) => void,
): (event: ChangeEvent<HTMLTextAreaElement>, previous: string) => void {
  const pending = useRef<Correction | null>(null);
  const restore = useRef<{ text: string; caret: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const back = restore.current;
    if (back) {
      restore.current = null;
      if (el && el.value === back.text) {
        el.setSelectionRange(back.caret, back.caret);
        onCaret?.(back.caret);
      }
    }
    const fix = pending.current;
    if (!fix) return;
    pending.current = null;
    // After React has finished this commit: an edit made inside it would be undone when React restores the field's
    // controlled value, since the state it sets can't be rendered during a commit.
    queueMicrotask(() => {
      const field = ref.current;
      if (!field || field.value !== fix.expected) return;
      let start = 0;
      while (start < fix.text.length && fix.text[start] === fix.expected[start]) start++;
      let end = fix.text.length;
      while (end > start && fix.text[end - 1] === fix.expected[end - 1]) end--;
      field.setSelectionRange(start, end);
      let applied = false;
      try {
        applied =
          typeof document.execCommand === 'function' &&
          document.execCommand('insertText', false, fix.text.slice(start, end)) &&
          field.value === fix.text;
      } catch {
        applied = false;
      }
      field.setSelectionRange(fix.caret, fix.caret);
      if (applied) {
        onCaret?.(fix.caret);
        return;
      }
      restore.current = { text: fix.text, caret: fix.caret };
      setValue(fix.text);
    });
  });

  return useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>, previous: string) => {
      const el = event.target;
      const native = event.nativeEvent as Partial<InputEvent>;
      const caret = el.selectionStart ?? el.value.length;
      if (el.selectionEnd !== null && el.selectionEnd !== caret) {
        pending.current = null;
        return;
      }
      const result = autocorrectComposerMention(
        {
          previous,
          next: el.value,
          caret,
          ...(native.inputType ? { inputType: native.inputType } : {}),
          ...(native.isComposing ? { composing: true } : {}),
        },
        targets,
      );
      pending.current = result ? { expected: el.value, ...result } : null;
    },
    [targets],
  );
}
