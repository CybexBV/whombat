import { type ReactNode, useId } from 'react';
import { cx } from '../cx';
import styles from './SegmentedControl.module.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** This one can't be picked (e.g. an AI provider that isn't set up); the others still can. */
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly (SegmentedOption<T> | T)[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the group, e.g. "Actor". */
  label: string;
  /** Read-only: the selection shows but cannot change (a disabled fieldset). */
  disabled?: boolean;
  /**
   * `md` (default) as in the audit log; `sm` for a choice inside a list row (a KEYS row's Off · Ask · On, AP-609):
   * the same shape, 2px padding, 12.5px items.
   */
  size?: 'md' | 'sm';
  /**
   * `outline` (default): the audit log's bordered group, the picked item in `btn`. `soft`: a filled `sf2` track whose
   * picked item is lifted onto the card colour, in 13px muted words (Settings → This Whombat's range, box-status.md).
   */
  variant?: 'outline' | 'soft';
  /**
   * `radiogroup` when the options are the states of one setting (a key's tier), so assistive tech announces a radio
   * group rather than a plain group; default `group`.
   */
  role?: 'group' | 'radiogroup';
  /** Ids of elements describing the group (a hint under the row's label). */
  describedBy?: string;
  className?: string;
}

/**
 * Segmented control (audit log "Everyone / People / Agents"): 3px padded container with an 11px
 * radius and line2 border; 8px-radius items, the selected one in btn colors. Built on native radio
 * inputs, so arrow keys move the selection.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled = false,
  size = 'md',
  variant = 'outline',
  role,
  describedBy,
  className,
}: SegmentedControlProps<T>) {
  const name = useId();
  const items: SegmentedOption<T>[] = options.map((o) =>
    typeof o === 'string' ? { value: o, label: o } : o,
  );
  return (
    <fieldset
      className={cx(styles.group, size === 'sm' && styles.sm, variant === 'soft' && styles.soft, className)}
      disabled={disabled}
      role={role === 'radiogroup' ? 'radiogroup' : undefined}
      aria-describedby={describedBy}
    >
      <legend className={styles.srOnly}>{label}</legend>
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <label
            key={item.value}
            className={cx(styles.item, selected && styles.selected)}
            data-disabled={item.disabled || undefined}
          >
            <input
              type="radio"
              className={styles.srOnly}
              name={name}
              value={item.value}
              checked={selected}
              disabled={item.disabled}
              onChange={() => onChange(item.value)}
            />
            {item.label}
          </label>
        );
      })}
    </fieldset>
  );
}
