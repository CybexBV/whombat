/**
 * The screen's own keyboard (HD-09, CG-111) under a text field: the keys type into the field at its caret and keep the
 * focus there (a press doesn't move it), so a real keyboard and the screen's work on the same field at once. The keys
 * are real buttons with names, out of the Tab order: who has a keyboard types; who doesn't, touches.
 */
import { type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { KEYBOARD_START, type Key, type KeyboardState, keyRows, press } from '../lib/keyboard';
import { Icon } from './icons';
import styles from './wifi.module.css';

const NAMES: Record<string, string> = {
  shift: 'Shift',
  backspace: 'Delete',
  space: 'Space',
  symbols: 'Symbols',
  letters: 'Letters',
};

export function Keyboard({
  input,
  value,
  onChange,
  max,
}: {
  /** The field the keys type into (the focused one). */
  input: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  max: number;
}) {
  const [kb, setKb] = useState<KeyboardState>(KEYBOARD_START);
  // Where the caret goes after React wrote the new value.
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = input.current;
    if (caret.current === null || !el) return;
    el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  const tap = (key: Key) => {
    const el = input.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = press(kb, { value, start, end }, key, max);
    setKb(next.kb);
    if (next.field.value !== value) onChange(next.field.value);
    caret.current = next.field.start;
    el?.focus();
  };

  return (
    <div className={styles.keyboard} data-page={kb.page}>
      {keyRows(kb.page, kb.shift).map((row) => {
        // Twenty half-width columns: a shorter row (asdfghjkl) is centred.
        const offset = 10 - row.reduce((n, k) => n + k.width, 0);
        return (
          <div key={row.map((k) => k.id).join('')} className={styles.keyRow}>
            {row.map((k, i) => (
              <button
                key={k.id}
                type="button"
                tabIndex={-1}
                className={styles.kbKey}
                data-kind={k.kind}
                data-on={(k.kind === 'shift' && kb.shift !== 'off') || undefined}
                style={{
                  gridColumn: `${i === 0 ? `${offset + 1} / ` : ''}span ${k.width * 2}`,
                }}
                aria-label={NAMES[k.id] ?? (k.char === ' ' ? NAMES.space : k.char)}
                aria-pressed={k.kind === 'shift' ? kb.shift !== 'off' : undefined}
                // The field keeps the focus (and its caret) while a key is pressed.
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => tap(k)}
              >
                {k.kind === 'shift' ? (
                  <Icon name={kb.shift === 'lock' ? 'shiftLock' : 'shift'} />
                ) : k.kind === 'backspace' ? (
                  <Icon name="backspace" />
                ) : k.kind === 'page' ? (
                  k.id === 'symbols' ? (
                    '#+='
                  ) : (
                    'abc'
                  )
                ) : k.kind === 'space' ? (
                  ''
                ) : (
                  k.char
                )}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}
