import { ChevronRight } from 'lucide-react';
import { cx } from '../cx';
import { Icon } from '../Icon';
import styles from './MoreDetail.module.css';

/**
 * “More detail”, folded under a plain sentence (an error's): what the app or the server actually said, for whoever
 * helps. Nothing when there is no detail.
 */
export function MoreDetail({ detail, className }: { detail: string | null | undefined; className?: string }) {
  if (!detail) return null;
  return (
    <details className={cx(styles.more, className)}>
      <summary>
        More detail
        <Icon icon={ChevronRight} size={13} />
      </summary>
      <p className={styles.said}>{detail}</p>
    </details>
  );
}
