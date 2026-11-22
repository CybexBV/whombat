import type { CSSProperties, ReactNode } from 'react';
import styles from './ui.module.css';

/** A speech bubble; the tail points to the speaker (below-left by default, like Hazel's tip in the app). */
export function Bubble({
  children,
  tail = 'bottom-left',
  className,
  style,
}: {
  children: ReactNode;
  tail?: 'bottom-left' | 'bottom-right' | 'left' | 'right';
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <p className={[styles.bubble, styles[`tail-${tail}`], className].filter(Boolean).join(' ')} style={style}>
      {children}
    </p>
  );
}

const MARK = 0xe000;

/**
 * A sentence with its values set off, e.g. `fill((v) => \`Type ${v} to confirm\`, <b>sda</b>)`; a template of two
 * values takes two, in order.
 */
export function fill(template: (...v: string[]) => string, ...values: ReactNode[]): ReactNode[] {
  // Each value's place is marked by a private-use character of its own, which no sentence contains.
  const text = template(...values.map((_, i) => String.fromCharCode(MARK + i)));
  return (
    text
      .split(/([\uE000-\uE007])/)
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of a fixed sentence
      .map((part, i) => (i % 2 === 1 ? <span key={i}>{values[part.charCodeAt(0) - MARK]}</span> : part))
  );
}
