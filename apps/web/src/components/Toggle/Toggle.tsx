import * as Switch from '@radix-ui/react-switch';
import { type ComponentPropsWithoutRef, forwardRef, type ReactNode, useId } from 'react';
import { cx } from '../cx';
import styles from './Toggle.module.css';

/** `md` 36×22 (onboarding repos), `sm` 34×20 (KEYS rows). Knob 16px either way. */
export type ToggleSize = 'md' | 'sm';

export interface ToggleProps extends Omit<ComponentPropsWithoutRef<typeof Switch.Root>, 'children'> {
  size?: ToggleSize;
}

/** On/off switch (Radix Switch). Track ok when on, line2 when off; knob slides 14px in 150ms. */
export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(function Toggle(
  { size = 'md', className, ...rest },
  ref,
) {
  return (
    <Switch.Root ref={ref} className={cx(styles.track, styles[size], className)} {...rest}>
      <Switch.Thumb className={styles.knob} />
    </Switch.Root>
  );
});

export interface ToggleRowProps {
  label: ReactNode;
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /**
   * Locked rows can never be switched on (e.g. keys agents never hold). The switch is disabled and
   * shown off at 50% opacity, the label turns mut and `note` explains why.
   */
  locked?: boolean;
  /** Short mono note before the switch ("people only", "always asks a person"). */
  note?: ReactNode;
  /**
   * A muted line under the label (“Off on this Whombat · see Settings → This Whombat”): describes the switch without
   * becoming part of its name.
   */
  hint?: ReactNode;
  size?: ToggleSize;
  className?: string;
  /** The row's id (a link that scrolls to it). */
  id?: string;
  /** Briefly highlighted: a link just brought the person here. */
  highlighted?: boolean;
  /**
   * On, and not switched here: another key brings it in (“included with the browser”, in `note`). The switch shows on,
   * disabled; the label keeps its ink.
   */
  included?: boolean;
}

/**
 * A labelled switch row as in a KEYS list (Settings → Agent): label, optional mono note, switch; the
 * whole row is clickable and separated by a top line.
 */
export function ToggleRow({
  label,
  checked,
  onCheckedChange,
  locked = false,
  note,
  hint,
  size = 'sm',
  className,
  id: rowId,
  highlighted = false,
  included = false,
}: ToggleRowProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const noteId = `${id}-note`;
  const hintId = `${id}-hint`;
  const describedBy = [note !== undefined ? noteId : null, hint ? hintId : null].filter(Boolean).join(' ');
  return (
    <label
      id={rowId}
      htmlFor={id}
      className={cx(
        styles.row,
        locked && styles.locked,
        included && styles.included,
        highlighted && styles.highlighted,
        className,
      )}
    >
      {hint ? (
        <span className={styles.labelColumn}>
          <span id={labelId} className={styles.labelText}>
            {label}
          </span>
          <span id={hintId} className={styles.hint}>
            {hint}
          </span>
        </span>
      ) : (
        <span id={labelId} className={styles.label}>
          {label}
        </span>
      )}
      {note !== undefined && (
        <span id={noteId} className={styles.note}>
          {note}
        </span>
      )}
      <Toggle
        id={id}
        size={size}
        checked={locked ? false : included ? true : checked}
        onCheckedChange={onCheckedChange}
        disabled={locked || included}
        aria-labelledby={labelId}
        aria-describedby={describedBy || undefined}
      />
    </label>
  );
}
