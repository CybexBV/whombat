/**
 * ⋯ at the end of a page's head (Whombat server-pages.md): every page's head is Ask {assistant}, then the service's own
 * page (“Open Home Assistant”) where it has one, then this menu with the rest — a shell, Restart, Pause, Update lists.
 * What may not be done stays in the menu, greyed, with why in its tooltip. Escape or a click elsewhere closes it.
 */
import { Ellipsis } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import styles from '../Things.module.css';

export interface HeadMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Why it can't be done here (the tooltip of a greyed item). */
  reason?: string | null;
  /** Stops or removes something: drawn in the serious colour. */
  serious?: boolean;
}

export function HeadMenu({ name, items }: { name: string; items: readonly HeadMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !wrap.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  if (!items.length) return null;
  return (
    <div ref={wrap} className={styles.menuWrap}>
      <button
        type="button"
        className={cx(styles.iconBtn, styles.headMore)}
        aria-label={`More for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon icon={Ellipsis} size={16} />
      </button>
      {open ? (
        <div className={styles.menu} role="menu" aria-label={`More for ${name}`}>
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className={it.serious ? styles.menuSerious : undefined}
              disabled={it.disabled}
              title={it.disabled ? (it.reason ?? undefined) : undefined}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
