import type { KeyboardEvent, ReactNode } from 'react';
import { cx } from '../cx';
import styles from './Tabs.module.css';

export interface TabItem<T extends string> {
  key: T;
  label: ReactNode;
  /** Mono count after the label ("Files changed 6"). */
  meta?: ReactNode;
}

export interface TabsProps<T extends string> {
  tabs: readonly TabItem<T>[];
  value: T;
  onChange: (tab: T) => void;
  /** Accessible name of the tab list, e.g. "Branch room". */
  label: string;
  /** Tab ids are `${idPrefix}-${key}` (for `aria-labelledby` on the panel and focus after arrow keys). */
  idPrefix: string;
  /** Id of the element the tabs control. */
  panelId?: string;
  className?: string;
  tabClassName?: string;
}

/**
 * Tabs with the 2px ink underline on the current one (branch room "Conversation / Files changed"). Arrow
 * keys, Home and End move between tabs (roving tabindex).
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
  panelId,
  className,
  tabClassName,
}: TabsProps<T>) {
  const move = (next: T) => {
    onChange(next);
    requestAnimationFrame(() => document.getElementById(`${idPrefix}-${next}`)?.focus());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.findIndex((t) => t.key === value);
    const index =
      event.key === 'ArrowRight'
        ? (at + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (at - 1 + tabs.length) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : null;
    const next = index === null ? undefined : tabs[index];
    if (!next) return;
    event.preventDefault();
    move(next.key);
  };
  return (
    <div className={cx(styles.tabs, className)} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t) => {
        const selected = t.key === value;
        return (
          <button
            key={t.key}
            id={`${idPrefix}-${t.key}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            className={cx(styles.tab, selected && styles.active, tabClassName)}
            onClick={() => onChange(t.key)}
          >
            {t.label}
            {t.meta !== undefined ? (
              <>
                {' '}
                <span className={styles.meta}>{t.meta}</span>
              </>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
