import type { ReactNode } from 'react';
import styles from './Placeholder.module.css';

export interface ScreenPlaceholderProps {
  /** Stable screen id (`channel`, `run`…), exposed as `data-screen` for tests. */
  screen: string;
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
}

/**
 * Stand-in for a screen that is not built yet: the 76px conversation-style header and a quiet note,
 * in the same visual language as the mock. Feature workstreams replace it with the real screen.
 */
export function ScreenPlaceholder({ screen, title, subtitle, children }: ScreenPlaceholderProps) {
  return (
    <section className={styles.screen} data-screen={screen}>
      <header className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
        {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
      </header>
      <div className={styles.body}>{children}</div>
    </section>
  );
}
