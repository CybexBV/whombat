import { type ReactNode, useId, useState } from 'react';
import { Icon } from '../../components/Icon';
import styles from './Vault.module.css';

/**
 * A quiet fold — “Advanced” in the add form, “Technical details” on an entry — so what only an expert needs (a header's
 * name, a key's fingerprint, the line for `authorized_keys`) waits closed below the plain words and stays one click
 * away. `name` marks it for tests and screenshots (`data-fold`).
 */
export function Fold({ label, name, children }: { label: string; name: string; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.advanced} data-fold={name}>
      <button
        type="button"
        className={styles.disclosure}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((was) => !was)}
      >
        <Icon name="chevronDown" size={15} className={styles.disclosureChevron} />
        {label}
      </button>
      {open ? (
        <div id={id} className={styles.foldBody}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
