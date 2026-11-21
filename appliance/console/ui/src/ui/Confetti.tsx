import { AVATAR_FACES } from '@whombat/avatars';
import { useMemo } from 'react';
import styles from './ui.module.css';

/** The five faces' colours. */
const COLORS = AVATAR_FACES;

/** A short burst of confetti in the faces' colours (the claim's celebration, CG-07). */
export function Confetti({ pieces = 70 }: { pieces?: number }) {
  const bits = useMemo(
    () =>
      Array.from({ length: pieces }, (_, i) => ({
        left: (i * 37.3) % 100,
        delay: ((i * 13) % 17) / 20,
        duration: 2.2 + ((i * 7) % 10) / 8,
        drift: ((i * 29) % 21) - 10,
        spin: (i * 53) % 360,
        color: COLORS[i % COLORS.length],
        round: i % 3 === 0,
      })),
    [pieces],
  );
  return (
    <div className={styles.confetti} aria-hidden="true" data-overflow-ok>
      {bits.map((b, i) => (
        <i
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
          key={i}
          className={b.round ? styles.round : undefined}
          style={
            {
              left: `${b.left}%`,
              background: `var(--face-${b.color})`,
              animationDelay: `${b.delay}s`,
              animationDuration: `${b.duration}s`,
              '--drift': `${b.drift}vw`,
              '--spin': `${b.spin}deg`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
