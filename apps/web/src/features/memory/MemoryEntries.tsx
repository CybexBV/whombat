import { type FormEvent, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import styles from './MemoryEntries.module.css';

export interface MemoryEntryView {
  id: string;
  text: string;
  /** A line under the text, or none. */
  meta?: string;
}

/**
 * The entries of one of the person's memory files (HE-39; AP-5221; was the profile's, AP-681): each its text, and Edit
 * (in place: the text in a box, Save and Cancel) and Remove. Removing is at once: the agent can be told again. Not in
 * the mocks: Settings' bordered rows.
 */
export function MemoryEntries({
  entries,
  label,
  canEdit,
  entryMax,
  copy,
  onSave,
  onRemove,
  busy = false,
  variant = 'rows',
}: {
  entries: readonly MemoryEntryView[];
  /** `card`: rows inside a Settings card (14px 18px); `rows`: the agent settings page's rows (10px 0, a top line). */
  variant?: 'card' | 'rows';
  /** The list's accessible name (“What Neo remembers about working with you”, “About you”). */
  label: string;
  canEdit: boolean;
  /** At most this many characters in one entry (the file's limit). */
  entryMax: number;
  copy: { edit: string; save: string; cancel: string; remove: string };
  /** Resolves to a problem to show under the box, or null when it saved. */
  onSave: (id: string, text: string) => Promise<string | null>;
  onRemove: (id: string) => void;
  busy?: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <ul className={cx(styles.list, variant === 'card' ? styles.inCard : styles.inRows)} aria-label={label}>
      {entries.map((entry) =>
        editing === entry.id ? (
          <EditRow
            key={entry.id}
            entry={entry}
            entryMax={entryMax}
            copy={copy}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSave={async (text) => {
              const problem = await onSave(entry.id, text);
              if (!problem) setEditing(null);
              return problem;
            }}
          />
        ) : (
          <li key={entry.id} className={styles.row}>
            <span className={styles.main}>
              <span className={styles.text}>{entry.text}</span>
              {entry.meta ? <span className={styles.meta}>{entry.meta}</span> : null}
            </span>
            {canEdit && (
              <span className={styles.actions}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={`${copy.edit}: ${entry.text}`}
                  onClick={() => setEditing(entry.id)}
                >
                  {copy.edit}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={`${copy.remove}: ${entry.text}`}
                  onClick={() => onRemove(entry.id)}
                >
                  {copy.remove}
                </Button>
              </span>
            )}
          </li>
        ),
      )}
    </ul>
  );
}

function EditRow({
  entry,
  entryMax,
  copy,
  busy,
  onSave,
  onCancel,
}: {
  entry: MemoryEntryView;
  entryMax: number;
  copy: { save: string; cancel: string; edit: string };
  busy: boolean;
  onSave: (text: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const ids = useId();
  const [text, setText] = useState(entry.text);
  const [problem, setProblem] = useState<string | null>(null);
  const clean = text.trim();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!clean) return;
    if (clean === entry.text) return onCancel();
    setProblem(await onSave(clean));
  };
  return (
    <li className={cx(styles.row, styles.editing)}>
      <form className={styles.form} onSubmit={submit}>
        <textarea
          // biome-ignore lint/a11y/noAutofocus: the person just pressed Edit on this entry.
          autoFocus
          className={styles.textarea}
          rows={2}
          maxLength={entryMax}
          value={text}
          aria-label={copy.edit}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${ids}-problem` : `${ids}-count`}
          onChange={(e) => {
            setText(e.target.value);
            if (problem) setProblem(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel();
          }}
        />
        <span className={styles.formFoot}>
          <span id={`${ids}-count`} className={styles.count}>
            {[...clean].length} / {entryMax}
          </span>
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
            {copy.cancel}
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={busy || !clean}>
            {copy.save}
          </Button>
        </span>
        {problem && (
          <span id={`${ids}-problem`} className={styles.problem} role="alert">
            {problem}
          </span>
        )}
      </form>
    </li>
  );
}
