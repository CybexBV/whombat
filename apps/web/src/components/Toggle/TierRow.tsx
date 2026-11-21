import { type ReactNode, useId } from 'react';
import { cx } from '../cx';
import { SegmentedControl, type SegmentedOption } from '../SegmentedControl';
import styles from './Toggle.module.css';

export interface TierRowProps<T extends string> {
  /** The row's name (“Merge”); also the name of its radio group. */
  label: string;
  /** The states, in display order (Off · Ask · On). */
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** A muted line under the label (“No deploy workflow is set up on this Whombat yet.”). */
  hint?: ReactNode;
  /** Read-only: the state shows but cannot change. */
  disabled?: boolean;
  className?: string;
  /** The row's id (a link that scrolls to it). */
  id?: string;
  /** Briefly highlighted: a link just brought the person here. */
  highlighted?: boolean;
  /**
   * `soft`: the device skill card's Off · Ask me · Allowed (mock 3; one-whombat-shell.md AP-1274) — a filled track, the
   * pick lifted onto the card, 13px words; the label in 500 weight. Default `outline` (an agent's KEYS rows).
   */
  variant?: 'outline' | 'soft';
  /** Under the row's line, full width: what a choice adds (the limits of an allowed action). */
  children?: ReactNode;
}

/**
 * A KEYS row with three states instead of a switch (Merge and Deploy: Off · Ask · On, AP-609): the `ToggleRow`'s
 * line, label and hint, with a small segmented control (a radio group named by the label) where the switch sits.
 */
export function TierRow<T extends string>({
  label,
  options,
  value,
  onChange,
  hint,
  disabled = false,
  className,
  id: rowId,
  highlighted = false,
  variant = 'outline',
  children,
}: TierRowProps<T>) {
  const id = useId();
  const hintId = `${id}-hint`;
  const soft = variant === 'soft';
  return (
    <div
      id={rowId}
      className={cx(
        styles.row,
        styles.tierRow,
        soft && styles.softRow,
        highlighted && styles.highlighted,
        className,
      )}
    >
      {hint ? (
        <span className={styles.labelColumn} aria-hidden="true">
          <span className={styles.labelText}>{label}</span>
          <span id={hintId} className={styles.hint}>
            {hint}
          </span>
        </span>
      ) : (
        <span className={styles.label} aria-hidden="true">
          {label}
        </span>
      )}
      <SegmentedControl<T>
        size={soft ? 'md' : 'sm'}
        variant={soft ? 'soft' : 'outline'}
        role="radiogroup"
        label={label}
        options={options}
        value={value}
        onChange={onChange}
        disabled={disabled}
        describedBy={hint ? hintId : undefined}
      />
      {children ? <div className={styles.tierExtra}>{children}</div> : null}
    </div>
  );
}
