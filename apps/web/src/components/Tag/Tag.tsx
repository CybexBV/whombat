import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx';
import styles from './Tag.module.css';

export type TagTone = 'ok' | 'warn' | 'bad' | 'mut' | 'brand' | 'ink';

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  /**
   * - `soft` sf2 fill, 5px radius, 2×7px (audit log kind: `CODE`, `ASKS`) — default
   * - `outline` pill with a 1px border in the tone color, 4×9px (audit log `DECLINED`, `BLOCKED`)
   */
  variant?: 'soft' | 'outline';
  /** Text (and border) color; soft tags default to ink2, outline tags to mut. */
  tone?: TagTone;
}

/** Tag: DM Mono 500 10.5px uppercase, .04em tracking. */
export function Tag({ children, variant = 'soft', tone, className, style, ...rest }: TagProps) {
  return (
    <span
      className={cx(styles.tag, styles[variant], className)}
      style={tone ? { color: `var(--${tone})`, ...style } : style}
      {...rest}
    >
      {children}
    </span>
  );
}
