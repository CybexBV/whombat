import { diffLinePrefix, type ReviewCard as ReviewCardData } from '@whombat/core/domain';
import { formatReviewLabel, segmentInlineCode } from '@whombat/core/text';
import { cx } from '../../components/cx';
import styles from './Card.module.css';
import review from './ReviewCard.module.css';

const LINE_LABEL = { add: 'Added', del: 'Removed', context: '' } as const;

export interface ReviewCardProps {
  card: ReviewCardData;
}

/** Review card: `REVIEW · N CHANGES REQUESTED` in bad, file:line, the diff block and numbered comments. */
export function ReviewCard({ card }: ReviewCardProps) {
  const where = card.line === null ? card.file : `${card.file}:${card.line}`;
  return (
    <section className={cx(styles.card, review.card)} aria-label={`Review of ${where}`} data-card="review">
      <div className={styles.header}>
        <span className={cx(styles.label, styles.toneBad)}>{formatReviewLabel(card.changesRequested)}</span>
        <span className={styles.metaMono}>{where}</span>
      </div>
      {card.diff.length > 0 && (
        <pre className={review.diff}>
          <code>
            {card.diff.map((line, i) => (
              <span
                // Diff lines have no identity beyond their position.
                // biome-ignore lint/suspicious/noArrayIndexKey: static list, never reordered
                key={i}
                className={cx(review.line, line.kind !== 'context' && review[line.kind])}
              >
                {LINE_LABEL[line.kind] && <span className={styles.srOnly}>{LINE_LABEL[line.kind]}: </span>}
                {diffLinePrefix(line.kind)}
                {line.text}
              </span>
            ))}
          </code>
        </pre>
      )}
      {card.comments.map((comment) => (
        <p key={comment.n} className={review.comment}>
          <strong className={review.number}>{comment.n}.</strong>{' '}
          {segmentInlineCode(comment.text).map((seg, i) =>
            seg.code ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: segments of a fixed string
              <code key={i} className={review.code}>
                {seg.text}
              </code>
            ) : (
              seg.text
            ),
          )}
        </p>
      ))}
    </section>
  );
}
