import { ChevronDown } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import styles from './DangerFold.module.css';

/**
 * A fold for what can't be taken back (settings-groups.md): closed under its label, so a destructive
 * button is never beside everyday ones; what it holds still asks before it acts.
 */
export function DangerFold({ children, label = 'Danger' }: { children: ReactNode; label?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.fold} data-danger="">
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((was) => !was)}
      >
        <Icon icon={ChevronDown} size={14} className={cx(styles.chevron, open && styles.open)} />
        {label}
      </button>
      {open ? (
        <div id={id} className={styles.body}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
