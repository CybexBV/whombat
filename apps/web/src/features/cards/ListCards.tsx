import type {
  AnswerCard as AnswerCardData,
  CommitsCard as CommitsCardData,
  PillCard as PillCardData,
} from '@whombat/core/domain';
import { shortNameOf } from '@whombat/core/domain';
import { formatAdditions, formatDeletions, plural, shortSha } from '@whombat/core/text';
import { cx } from '../../components/cx';
import { StatusPill } from '../../components/StatusDot';
import styles from './Card.module.css';
import list from './ListCard.module.css';
import { answerSearchHref, receiptHref } from './links';
import { CardAction, CardLink, DiffStatText, type NavigateHandler, type PrincipalLookup } from './parts';

/* Commits ----------------------------------------------------------------------------------------- */

export interface CommitsCardProps {
  card: CommitsCardData;
  principals: PrincipalLookup;
}

/** Commits list: sha (brand, mono) + message rows, footer `+214 −12 · 6 files · signed by Banjo`. */
export function CommitsCard({ card, principals }: CommitsCardProps) {
  const signer = principals(card.signedById);
  const signerName = signer ? shortNameOf(signer) : 'Someone';
  return (
    <section
      className={cx(styles.card, styles.list, list.commits)}
      aria-label={card.prNumber ? `Commits on PR #${card.prNumber}` : 'Commits'}
      data-card="commits"
    >
      <ul className={styles.bare}>
        {card.commits.map((c) => (
          <li key={c.sha} className={list.commit}>
            <span className={list.sha}>{shortSha(c.sha)}</span>
            <span className={list.message}>{c.message}</span>
          </li>
        ))}
      </ul>
      <span className={list.footer}>
        <DiffStatText
          add={formatAdditions(card.diff.add)}
          del={formatDeletions(card.diff.del)}
          suffix={`· ${plural(card.diff.files, 'file')} · signed by ${signerName}`}
        />
      </span>
    </section>
  );
}

/* Status pill ------------------------------------------------------------------------------------- */

const PILL_TONE = { ok: 'ok', warn: 'warn', bad: 'bad', neutral: 'mut' } as const;

export interface PillCardProps {
  card: PillCardData;
}

/** Status pill: dot + mono text ("38 of 41 passed · 3 failing in invoice_format_test"). */
export function PillCard({ card }: PillCardProps) {
  return (
    <StatusPill variant="outline" tone={PILL_TONE[card.tone]} className={list.pill} data-card="pill">
      {card.text}
    </StatusPill>
  );
}

/* Receipts ---------------------------------------------------------------------------------------- */

export interface AnswerCardProps {
  card: AnswerCardData;
  /** `thread` is the thread pane's compact list (no label, where under the source). */
  variant?: 'message' | 'thread';
  onNavigate?: NavigateHandler;
}

/**
 * RECEIPTS under an agent answer: numbered rows [n · source · where] that deep-link, and "Open in search"
 * when the answer came from a search. A `where` too long to sit beside the source wraps under it (CD-11).
 */
export function AnswerCard({ card, variant = 'message', onNavigate }: AnswerCardProps) {
  const search = answerSearchHref(card);
  const thread = variant === 'thread';
  return (
    <section
      className={cx(styles.card, styles.list, thread ? list.thread : list.receipts)}
      aria-label="Receipts"
      data-card="answer"
    >
      {!thread && <span className={cx(styles.label, list.receiptsLabel)}>RECEIPTS</span>}
      <ol className={styles.bare}>
        {card.receipts.map((r) => (
          <li key={r.n}>
            <CardLink className={list.receipt} href={receiptHref(card, r)} onNavigate={onNavigate}>
              <span className={list.number}>
                <span className={styles.srOnly}>Receipt </span>
                {r.n}
              </span>
              <span className={thread ? list.stack : list.line}>
                <span className={list.source}>{r.source}</span>
                <span className={list.where}>{r.detail}</span>
              </span>
            </CardLink>
          </li>
        ))}
      </ol>
      {search && !thread && (
        <CardAction size="sm" className={list.openSearch} href={search} onNavigate={onNavigate}>
          Open in search
        </CardAction>
      )}
    </section>
  );
}
