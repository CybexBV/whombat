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

/** A sentence with one value set off, e.g. `fill((v) => \`Type ${v} to confirm\`, <b>sda</b>)`. */
export function fill(template: (v: string) => string, value: ReactNode): ReactNode[] {
  return (
    template('\u0000')
      .split('\u0000')
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of a fixed sentence
      .flatMap((part, i) => (i === 0 ? [part] : [<span key={i}>{value}</span>, part]))
  );
}
