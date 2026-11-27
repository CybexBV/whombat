import type { DigestCard as DigestCardData, DigestItem, DigestSection } from '@whombat/core/domain';
import { formatDigestLabel } from '@whombat/core/text';
import { useId, useState } from 'react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useWebI18n } from '../../i18n/provider';
import styles from './Card.module.css';
import digest from './DigestCard.module.css';

export interface DigestCardProps {
  card: DigestCardData;
}

function ItemBody({ item }: { item: DigestItem }) {
  return (
    <>
      <span className={digest.time}>{item.time ?? ''}</span>
      <span className={digest.text}>
        <span className={digest.line}>
          <span className={digest.title}>{item.title}</span>
          {item.source ? <span className={digest.source}>{item.source}</span> : null}
        </span>
        {item.note ? <span className={digest.note}>{item.note}</span> : null}
      </span>
      {item.url ? (
        <span className={digest.go}>
          <Icon name="external" size={14} />
          <span className={styles.srOnly}> (opens in a new tab)</span>
        </span>
      ) : null}
    </>
  );
}

function Section({ section }: { section: DigestSection }) {
  const [open, setOpen] = useState(!section.collapsed);
  const listId = useId();
  const count = section.items.length;
  return (
    <section className={digest.section} aria-label={section.label}>
      <div className={digest.sectionHeader}>
        <span className={digest.sectionLabel}>{section.label}</span>
        <span className={styles.meta}>{count}</span>
      </div>
      {open ? (
        <ul className={styles.bare} id={listId}>
          {section.items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: items are positional and never reorder
            <li key={i} className={digest.item}>
              {item.url ? (
                <a className={digest.row} href={item.url} target="_blank" rel="noopener noreferrer">
                  <ItemBody item={item} />
                </a>
              ) : (
                <div className={digest.row}>
                  <ItemBody item={item} />
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <button
          type="button"
          className={digest.folded}
          aria-expanded={false}
          aria-controls={listId}
          onClick={() => setOpen(true)}
        >
          <span className={digest.foldedTitles}>{section.items.map((i) => i.title).join(' · ')}</span>
          <span className={digest.show}>Show {count}</span>
        </button>
      )}
    </section>
  );
}

/**
 * Digest card (docs/decisions/rich-messages.md RM-08): `INBOX · 7 UNREAD`, then sections of items
 * [mono time · title + source · note], each opening where it lives. Collapsed sections fold to one line of
 * titles with “Show N”. Same frame and rhythm as the research card.
 */
export function DigestCard({ card }: DigestCardProps) {
  const { tag: uiLocale } = useWebI18n();
  return (
    <section
      className={cx(styles.card, digest.card)}
      aria-label={[card.title, card.summary].filter(Boolean).join(', ')}
      data-card="digest"
    >
      <div className={styles.header}>
        <span className={styles.label}>{formatDigestLabel(card.title, card.summary, uiLocale)}</span>
      </div>
      {card.sections.map((section, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: sections are positional and never reorder
        <Section key={i} section={section} />
      ))}
    </section>
  );
}
