import { WhombatAvatar, type WhombatAvatarProps } from '@whombat/avatars/react';
import type { CSSProperties, ReactNode } from 'react';
import styles from './ui.module.css';

export interface BurrowProps extends Pick<WhombatAvatarProps, 'face' | 'label'> {
  /** The avatar's size in layout px. */
  size: number;
  /** Dirt flying from the hole (the installer at work). */
  digging?: boolean;
  /** A mound that grows with the installation, 0–1. */
  pile?: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/**
 * A wombat peeking out of its burrow (CG-16, CG-35): the agent's static bust (one image, the app's file) rises from
 * a hole, the front lip of dirt covers its lower edge. Without a label the wombat is decorative.
 */
export function Burrow({ face, label, size, digging, pile, className, style, children }: BurrowProps) {
  const cls = [styles.burrow, className].filter(Boolean).join(' ');
  return (
    <div className={cls} style={{ width: size * 1.22, height: size * 0.98, ...style }}>
      <span className={styles.hole} />
      {pile !== undefined && (
        <span
          className={styles.pile}
          style={{ transform: `scale(${0.25 + 0.75 * Math.min(Math.max(pile, 0), 1)})` }}
        />
      )}
      <div className={styles.burrowAvatar} style={{ width: size, height: size }}>
        {/* Every scene is above the fold on a screen with nothing to scroll: load now. */}
        <WhombatAvatar face={face} label={label} size={size} crop="bust" eager />
      </div>
      <svg className={styles.lip} viewBox="0 0 130 22" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 22 C3 14 10 10 20 11 C30 7 44 9 52 10 C62 8 74 9 82 10 C92 7 104 8 112 11 C121 10 128 15 130 22 Z" />
        <path
          className={styles.lipTop}
          d="M9 14 C16 11 24 11 30 10 M50 11 C60 9 70 10 80 11 M100 10 C108 9 116 11 121 14"
        />
      </svg>
      <span className={styles.pebbles} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {digging && (
        <span className={styles.dirt} aria-hidden="true">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <i key={i} style={{ animationDelay: `${i * 0.23}s` }} />
          ))}
        </span>
      )}
      {children}
    </div>
  );
}
