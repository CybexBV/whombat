import { forwardRef, type InputHTMLAttributes } from 'react';
import { cx } from '../cx';
import styles from './Input.module.css';

/**
 * - `md` 11×14px, 12px radius, 16px text — a labelled field, like the agent's name (default)
 * - `lg` 14×16px, 12px radius, 16px text — onboarding invite email
 * - `display` 16×18px, 14px radius, 22px/600 — onboarding burrow name
 */
export type InputSize = 'md' | 'lg' | 'display';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: InputSize;
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', invalid, className, type = 'text', ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      aria-invalid={invalid || undefined}
      className={cx(styles.input, styles[size], className)}
      {...rest}
    />
  );
});
