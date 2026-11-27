import { type ApprovalTonightView, type ApprovalUnmetView, approvalCardWords } from '@whombat/core/approvals';
import { ChevronRight } from 'lucide-react';
import { type MouseEvent, type ReactNode, useId } from 'react';
import { Button, ButtonLink } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useLocaleWords } from '../../i18n/words';
import styles from './AskCard.module.css';

/** The facts the card shows before its answers (core's `approvalCardFacts`, client's `needsYouApprovalCard`). */
export interface AskCardFacts {
  status: string;
  asked: string;
  title: string;
  /** Where it happens (“pve-02”), when the title doesn't carry it (an Inbox row). */
  subject?: string | null;
  happens: string[];
  permission: string;
  unmet?: ApprovalUnmetView[];
  tonight: ApprovalTonightView | null;
}

export interface AskCardAnswer {
  id: string;
  label: string;
  onSelect: () => void;
  /** A tooltip: when *Yes, tonight* runs (“Tonight at 03:00”). */
  title?: string;
}

/**
 * A way to change what the card asks before answering (the assistant's draft report: Edit opens the form with it). A
 * link beside the answers, not one of them.
 */
export interface AskCardEdit {
  label: string;
  /** The app path it opens. */
  href: string;
  /** In-app navigation for a plain click; a modified click opens it the browser's way (a new tab). */
  onNavigate: (href: string) => void;
}

export interface AskCardProps {
  facts: AskCardFacts;
  /** “What actually runs: …” when the stored wording disagrees with the action. */
  actionNote?: string | null;
  /** What the agent needs it for, in its words. */
  why?: string | null;
  /** The answers in their one order; empty once answered. */
  answers: AskCardAnswer[];
  /** Edit beside the answers while they show. */
  edit?: AskCardEdit | null;
  busy?: boolean;
  /** Inside the Details fold: the target, the call, the message, the lasting yes. */
  details?: ReactNode;
  /** Opened at first (the approval's own dialog shows an email's whole body). */
  detailsOpen?: boolean;
  /** Shown in place of the answers once answered (“Scheduled for tonight, 03:00”, Undo). */
  answered?: ReactNode;
  /**
   * The answer may have gone through (the connection dropped after it left): the notice and *Ask {assistant} to check*
   * replace the answers, so nothing is sent twice.
   */
  unknown?: { checkLabel: string; onCheck: () => void } | null;
  /** `card` in a thread or a list; `sheet` fills the approval's dialog, its facts scrolling above the answers. */
  variant?: 'card' | 'sheet';
  /** Who asks, drawn before the status (an automation's mark). */
  asker?: ReactNode;
  /** The title's heading level: 3 in a list under its group's heading. */
  level?: 2 | 3;
  pending: boolean;
  className?: string;
  /** `data-*` the screens and tests find the card by. */
  data?: Record<`data-${string}`, string | undefined>;
}

/**
 * The one approval card (approval-card.md): who asks and when, the title, what happens to what, the permission it
 * uses, what it still waits for and the exact moment *Yes, tonight* means — all before the answers — then Details, and
 * the answers in their one order, outlined alike so none looks recommended, with Edit after them where what is asked
 * can be changed first. A long message or command scrolls in the facts; the answers sit apart under them and never
 * cover them.
 */
export function AskCard({
  facts,
  actionNote,
  why,
  answers,
  edit = null,
  busy = false,
  details,
  detailsOpen = false,
  answered,
  unknown,
  variant = 'card',
  level = 2,
  pending,
  asker,
  className,
  data,
}: AskCardProps) {
  const APPROVAL_CARD_WORDS = useLocaleWords(approvalCardWords);
  const headingId = useId();
  const Heading = level === 3 ? 'h3' : 'h2';
  const W = APPROVAL_CARD_WORDS;
  const unmet = facts.unmet ?? [];
  const editing = edit && answers.length ? edit : null;
  const openEdit = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!editing || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    // While an answer is being saved the card waits, as the answers do.
    if (!busy) editing.onNavigate(editing.href);
  };
  return (
    <section
      className={cx(
        styles.card,
        variant === 'sheet' && styles.sheet,
        pending && !answered && !unknown && styles.pending,
        className,
      )}
      aria-label={`Approval: ${facts.title}`}
      {...data}
    >
      <div
        className={styles.facts}
        {...(variant === 'sheet' ? { role: 'region', 'aria-label': W.contentLabel, tabIndex: 0 } : {})}
      >
        <p className={styles.status}>
          {pending ? <span aria-hidden="true">○</span> : null}
          {asker}
          <span>{facts.status}</span>
          <span className={styles.asked}>{facts.asked}</span>
        </p>
        <Heading id={headingId} className={styles.title}>
          {facts.title}
        </Heading>
        {actionNote ? (
          <p className={styles.actionNote} role="note">
            {actionNote}
          </p>
        ) : null}
        {facts.subject ? <p className={styles.text}>{facts.subject}</p> : null}
        {facts.happens.length === 1 ? (
          <p className={styles.text}>{facts.happens[0]}</p>
        ) : facts.happens.length > 1 ? (
          <ul className={styles.happens}>
            {facts.happens.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        ) : null}
        {why ? <p className={styles.text}>{why}</p> : null}
        <div>
          <p className={styles.label}>{W.permission}</p>
          <p className={styles.text}>{facts.permission}</p>
        </div>
        {unmet.length ? (
          <div>
            <p className={styles.label}>{W.waiting}</p>
            <ul className={styles.unmet}>
              {unmet.map((c) => (
                <li key={c.id}>
                  <span>{c.label}</span>
                  {c.note ? <span className={styles.note}>{c.note}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {facts.tonight && answers.length ? (
          <p className={styles.timing}>
            <strong>{facts.tonight.label}</strong> {facts.tonight.means}
            <br />
            {facts.tonight.at}.
          </p>
        ) : null}
        {details ? (
          <details className={styles.details} open={detailsOpen || undefined}>
            <summary>
              <Icon icon={ChevronRight} size={14} className={styles.chevron} />
              {W.details}
            </summary>
            <div className={styles.detailsBody}>{details}</div>
          </details>
        ) : null}
      </div>
      {unknown ? (
        <section className={styles.unknown} role="status" aria-label={W.unknown}>
          <h3 className={styles.unknownTitle}>{W.unknown}</h3>
          <p className={styles.unknownBody}>{W.unknownBody}</p>
          <p className={styles.label}>{W.lastReviewed}</p>
          <Button variant="secondary" size="lg" className={styles.check} onClick={unknown.onCheck}>
            {unknown.checkLabel}
          </Button>
        </section>
      ) : answered ? (
        <div className={styles.answered}>{answered}</div>
      ) : answers.length ? (
        // biome-ignore lint/a11y/useSemanticElements: a group of buttons, named for screen readers.
        <div
          className={styles.answers}
          role="group"
          aria-label={W.answersLabel}
          data-count={answers.length + (editing ? 1 : 0)}
        >
          {answers.map((a) => (
            <Button
              key={a.id}
              variant="secondary"
              size="lg"
              className={styles.answer}
              disabled={busy}
              onClick={a.onSelect}
              title={a.title}
              data-answer={a.id}
            >
              {a.label}
            </Button>
          ))}
          {editing ? (
            <ButtonLink
              variant="secondary"
              size="lg"
              className={styles.answer}
              href={editing.href}
              onClick={openEdit}
              aria-disabled={busy || undefined}
              data-edit=""
            >
              {editing.label}
            </ButtonLink>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
