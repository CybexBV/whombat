/**
 * The quiet row under a list of machines (Whombat server-pages.md): “6 temporary machines hidden · Show”. Build and test
 * machines that come and go by themselves stay out of the list until someone asks for them; then “… shown · Hide”.
 */
import { TEMPORARY_WORDS } from '@whombat/client/hosts';
import styles from './Things.module.css';

export function TemporaryRow({
  count,
  shown,
  onToggle,
}: {
  /** How many the list hides (or shows, while they are shown). */
  count: number;
  shown: boolean;
  onToggle: () => void;
}) {
  if (!count) return null;
  return (
    <p className={styles.tempRow} title={TEMPORARY_WORDS.about}>
      <span>{shown ? TEMPORARY_WORDS.shown(count) : TEMPORARY_WORDS.hidden(count)}</span>
      <span aria-hidden="true">·</span>
      <button type="button" className={styles.cardLink} aria-pressed={shown} onClick={onToggle}>
        {shown ? TEMPORARY_WORDS.hide : TEMPORARY_WORDS.show}
      </button>
    </p>
  );
}
