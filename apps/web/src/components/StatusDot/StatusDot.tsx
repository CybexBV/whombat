import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx';
import styles from './StatusDot.module.css';

/** Agent statuses plus a person's online presence. */
export type DotStatus = 'working' | 'waiting' | 'idle' | 'online';
/** Theme tones for non-agent states (checks, branch state, approvals). */
export type DotTone = 'ok' | 'warn' | 'bad' | 'mut' | 'brand';

export const STATUS_LABELS: Record<DotStatus, string> = {
  working: 'Working',
  waiting: 'Waiting',
  idle: 'Idle',
  online: 'Online',
};

const STATUS_VAR: Record<DotStatus, string> = {
  working: 'var(--status-working)',
  waiting: 'var(--status-waiting)',
  idle: 'var(--status-idle)',
  online: 'var(--presence)',
};

export function dotColor(status: DotStatus | undefined, tone: DotTone | undefined): string {
  if (tone) return `var(--${tone})`;
  return STATUS_VAR[status ?? 'idle'];
}

export interface StatusDotProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  status?: DotStatus;
  tone?: DotTone;
  /** Diameter in px. 7 in lists and badges, 8 in pills and branch rooms, 9 for presence. */
  size?: number;
  /**
   * Accessible label. Defaults to the status name ("Working"); pass `null` when the dot sits next to
   * text that already says the same (the dot is then hidden from assistive tech).
   */
  label?: string | null;
  /** 2px ring in the given CSS color (presence dot on an avatar: `var(--side)`). */
  ring?: string;
  /** Live halo (run in progress). */
  halo?: boolean;
}

/** Status dot: working #6fcf97, waiting #d9a84a, idle #a0958a, presence #6fcf97. */
export function StatusDot({
  status,
  tone,
  size = 7,
  label,
  ring,
  halo,
  className,
  style,
  ...rest
}: StatusDotProps) {
  const name = label === undefined ? (status ? STATUS_LABELS[status] : undefined) : label;
  const props = {
    className: cx(styles.dot, halo && styles.halo, className),
    style: {
      width: size,
      height: size,
      background: dotColor(status, tone),
      ...(ring && { border: `2px solid ${ring}` }),
      ...style,
    },
    ...rest,
  };
  return name ? <span role="img" aria-label={name} {...props} /> : <span aria-hidden="true" {...props} />;
}

export interface StatusPillProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  status?: DotStatus;
  tone?: DotTone;
  /**
   * - `soft` sf2 fill, 4×10px, mono 11px, 7px dot (roster status) — default
   * - `outline` sf fill + line border, 6×12px, mono 12.5px, 8px dot (checks result in chat)
   */
  variant?: 'soft' | 'outline';
}

/** Status pill: dot + mono text. */
export function StatusPill({
  children,
  status,
  tone,
  variant = 'soft',
  className,
  ...rest
}: StatusPillProps) {
  return (
    <span className={cx(styles.pill, styles[variant], className)} {...rest}>
      <StatusDot status={status} tone={tone} size={variant === 'outline' ? 8 : 7} label={null} />
      {children}
    </span>
  );
}
