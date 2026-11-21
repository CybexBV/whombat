import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react';
import { cx } from '../cx';
import styles from './Chip.module.css';

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
  /** Selected filter: btn fill, btnfg text, btn border. Exposed as `aria-pressed`. */
  active?: boolean;
  /** Optional count, shown in DM Mono at 70% opacity after the label. */
  count?: number | string;
}

/** Pill filter chip (audit log kinds, search types). README "Chip/filter". */
export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { children, active = false, count, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={active}
      className={cx(styles.chip, active && styles.active, className)}
      {...rest}
    >
      {children}
      {count !== undefined && (
        <>
          {' '}
          <span className={styles.count}>{count}</span>
        </>
      )}
    </button>
  );
});

export interface RemovableChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
  /** Accessible name, e.g. "Remove filter: Only Banjo". Defaults to "Remove filter". */
  removeLabel?: string;
}

/** Applied filter that clears on click ("Only Banjo ×" in the audit log). */
export const RemovableChip = forwardRef<HTMLButtonElement, RemovableChipProps>(function RemovableChip(
  { children, removeLabel, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(styles.removable, className)}
      aria-label={removeLabel}
      {...rest}
    >
      {children}
      <span aria-hidden="true" className={styles.x}>
        ×
      </span>
    </button>
  );
});
