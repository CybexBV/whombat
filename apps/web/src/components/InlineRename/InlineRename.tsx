import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { cx } from '../cx';
import styles from './InlineRename.module.css';

export interface InlineRenameProps {
  /** The name it goes by now: what the box starts with, all selected. */
  value: string;
  /** The longest name it takes. */
  maxLength: number;
  /** The box's accessible name (“Rename pve-02”). */
  label: string;
  /**
   * Saves what was typed; resolves to why it didn't go (shown under the box, which stays open), or null when it
   * went (or nothing changed).
   */
  onSave: (typed: string) => Promise<string | null>;
  /** The box closes: saved, or Esc. */
  onClose: () => void;
  /** A line under the box saying what an empty box does (“Leave it empty to use its id again.”). */
  hint?: string;
  /** The face of the text it replaces (the sidebar row's, a page's title). */
  className?: string;
}

/**
 * A name edited where it is shown (the sidebar's Rename, a page's): the name becomes a box with all of it selected,
 * Enter or clicking away saves, Esc puts it back. Why a name can't be used shows under the box, which stays open
 * until the name is changed, Esc or clicking away again.
 */
export function InlineRename({
  value,
  maxLength,
  label,
  onSave,
  onClose,
  hint,
  className,
}: InlineRenameProps) {
  const ref = useRef<HTMLInputElement>(null);
  const problemId = useId();
  const [typed, setTyped] = useState(value);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Esc closes without the blur that follows saving.
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const save = async () => {
    if (done.current || saving) return;
    setSaving(true);
    const why = await onSave(typed).catch(() => 'That didn’t work. Try again in a moment.');
    setSaving(false);
    if (why) {
      setProblem(why);
      ref.current?.focus();
      return;
    }
    done.current = true;
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      done.current = true;
      onClose();
    }
  };

  return (
    <span className={styles.wrap}>
      <input
        ref={ref}
        type="text"
        className={cx(styles.input, className)}
        value={typed}
        maxLength={maxLength}
        aria-label={label}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem || hint ? problemId : undefined}
        autoComplete="off"
        spellCheck={false}
        readOnly={saving}
        onChange={(e) => {
          setTyped(e.target.value);
          setProblem(null);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Leaving the box saves; leaving it again after a refusal puts the name back as it was.
          if (!problem) void save();
          else if (!done.current) {
            done.current = true;
            onClose();
          }
        }}
        // A click in the box stays in the box (the row around it is a link).
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      {problem ? (
        <span id={problemId} className={styles.problem} role="alert">
          {problem}
        </span>
      ) : hint ? (
        <span id={problemId} className={styles.hint}>
          {hint}
        </span>
      ) : null}
    </span>
  );
}
