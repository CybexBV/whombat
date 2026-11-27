import { type ResearchCard as ResearchCardData, researchVerdictLabels } from '@whombat/core/domain';
import { formatResearchLabel, formatResearchMeta } from '@whombat/core/text';
import { cx } from '../../components/cx';
import { useWebI18n } from '../../i18n/provider';
import { useLocaleWords } from '../../i18n/words';
import styles from './Card.module.css';
import research from './ResearchCard.module.css';

export interface ResearchCardProps {
  card: ResearchCardData;
}

/** Research card: `RESEARCH · TOPIC` + source count, rows [name · verdict pill · note]. */
export function ResearchCard({ card }: ResearchCardProps) {
  const RESEARCH_VERDICT_LABELS = useLocaleWords(researchVerdictLabels);
  const { tag: uiLocale } = useWebI18n();
  return (
    <section
      className={cx(styles.card, research.card)}
      aria-label={`Research: ${card.topic}`}
      data-card="research"
    >
      <div className={cx(styles.header, research.header)}>
        <span className={styles.label}>{formatResearchLabel(card.topic, uiLocale)}</span>
        <span className={styles.meta}>
          {formatResearchMeta(card.sourceCount, card.testedCount, uiLocale)}
        </span>
      </div>
      <ul className={styles.bare}>
        {card.rows.map((row) => (
          <li key={row.name} className={research.row}>
            <span className={research.name}>{row.name}</span>
            <span
              className={cx(
                research.verdict,
                row.verdict === 'pick' && research.pick,
                row.verdict === 'maybe' && research.maybe,
              )}
            >
              {RESEARCH_VERDICT_LABELS[row.verdict]}
            </span>
            <span className={research.note}>{row.note}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
