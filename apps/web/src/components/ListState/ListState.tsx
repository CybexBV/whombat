import type { CSSProperties, ReactNode } from 'react';
import { Button } from '../Button';
import { cx } from '../cx';
import styles from './ListState.module.css';

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
}

/** One quiet pulsing block (TODO 16.4). Compose these to match a row's geometry. */
export function Skeleton({ width = '100%', height = 12, radius, className, style }: SkeletonProps) {
  return (
    <div
      className={cx(styles.bar, className)}
      style={{ width, height, borderRadius: radius, ...style }}
      aria-hidden="true"
    />
  );
}

export interface SkeletonRowsProps {
  /** Number of rows to show. Default 4. */
  count?: number;
  /** Leading avatar/icon size in px. Omit for no leading shape. */
  avatarSize?: number;
  /** Number of text lines per row (widths vary a little so rows don't look identical). */
  lines?: number;
  /** Height of each text line. */
  lineHeight?: number;
  /** Row height budget (padding included); only affects the outer row's min-height. */
  rowHeight?: number;
  className?: string;
}

const LINE_WIDTHS = ['62%', '40%', '78%', '52%'];

/**
 * Skeleton rows matching a list row's geometry: an optional leading avatar circle and one or more text
 * lines, repeated `count` times. Used instead of a spinner for list/section loading (TODO 16.4).
 */
export function SkeletonRows({
  count = 4,
  avatarSize,
  lines = 2,
  lineHeight = 11,
  rowHeight,
  className,
}: SkeletonRowsProps) {
  return (
    <div className={cx(styles.rows, className)} data-state="loading" aria-hidden="true">
      {Array.from({ length: count }, (_, row) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static-length placeholder rows, never reordered
        <div className={styles.row} style={rowHeight ? { minHeight: rowHeight } : undefined} key={row}>
          {avatarSize !== undefined && <Skeleton width={avatarSize} height={avatarSize} radius={999} />}
          <div className={styles.rowLines}>
            {Array.from({ length: lines }, (_, line) => (
              <Skeleton
                // biome-ignore lint/suspicious/noArrayIndexKey: static-length placeholder lines, never reordered
                key={line}
                height={lineHeight}
                width={LINE_WIDTHS[(row + line) % LINE_WIDTHS.length]}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export interface ErrorNoteProps {
  /** One-line message in the mocks' voice: short, plain, no exclamation marks. */
  message: ReactNode;
  /** Omit to show the message with no action (e.g. inside a modal that already offers Close). */
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

/** A one-line error message with a Retry button (TODO 16.4). */
export function ErrorNote({ message, onRetry, retryLabel = 'Retry', className }: ErrorNoteProps) {
  return (
    <div className={cx(styles.errorNote, className)} role="status">
      <p className={styles.errorMessage}>{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

export interface EmptyNoteProps {
  children: ReactNode;
  className?: string;
}

/** Quiet centered copy for an empty list (TODO 16.4). */
export function EmptyNote({ children, className }: EmptyNoteProps) {
  return <p className={cx(styles.emptyNote, className)}>{children}</p>;
}
