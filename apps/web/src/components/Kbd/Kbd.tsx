import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx';
import styles from './Kbd.module.css';

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
}

/** Keyboard hint (`⌘K` on the sidebar search, `esc` in search): DM Mono 500 11px, mut. */
export function Kbd({ children, className, ...rest }: KbdProps) {
  return (
    <kbd className={cx(styles.kbd, className)} {...rest}>
      {children}
    </kbd>
  );
}

export function isApplePlatform(
  nav: { platform?: string; userAgent?: string } | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator,
): boolean {
  const s = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
  return /Mac|iPhone|iPad|iPod/i.test(s);
}

/** `⌘K` on macOS/iOS, `Ctrl K` elsewhere (DECISIONS.md B-03). */
export function formatShortcut(key: string, apple: boolean = isApplePlatform()): string {
  return apple ? `⌘${key.toUpperCase()}` : `Ctrl ${key.toUpperCase()}`;
}
