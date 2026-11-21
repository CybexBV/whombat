import type { StatusLevel } from '@whombat/client';
import { cx, variantClass } from '../cx';
import styles from './StatusMark.module.css';

/**
 * A status level by shape (ui-refresh-status.md): not working is a dot in a ring, needs a look a filled dot, learning a
 * hollow ring, connected nothing. With `label` it is an image with that name (“blackbox: disk array failed”); without,
 * it is decoration beside words that say it.
 */
export function StatusMark({
  level,
  label,
  className,
}: {
  level: StatusLevel;
  label?: string | null | undefined;
  className?: string | undefined;
}) {
  if (level === 'connected') return null;
  return (
    <span
      className={cx(styles.mark, styles[level], className)}
      data-level={level}
      {...(label ? { role: 'img', 'aria-label': label, title: label } : { 'aria-hidden': true })}
    />
  );
}

/** A card's status pill: the mark and its word in mono, in the level's colour on `sf2`. */
export function LevelPill({
  level,
  word,
  className,
}: {
  level: StatusLevel;
  word: string;
  className?: string | undefined;
}) {
  return (
    <span className={cx(styles.pill, variantClass(styles, 'pill', level), className)} data-level={level}>
      {level === 'connected' ? (
        <span className={styles.okDot} aria-hidden="true" />
      ) : (
        <StatusMark level={level} />
      )}
      {word}
    </span>
  );
}
