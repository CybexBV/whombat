import type { Decider, PullRequestDetail } from '@whombat/core';
import { useId } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { EmptyNote } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { SidePane } from '../../components/SidePane';
import { PrincipalAvatar } from '../messaging/PrincipalAvatar';
import styles from './BranchPane.module.css';
import {
  checkRows,
  MERGE_NOTE_WITH_KEYS,
  mergeButton,
  type PrincipalLookup,
  reviewerRows,
  stagingView,
} from './model';

export interface BranchPaneProps {
  detail: PullRequestDetail;
  lookup: PrincipalLookup;
  /** The signed-in person (for the approval summary: “you”). */
  viewer?: Decider;
  now: Date | number;
  timeZone: string;
  /** "Review deploy": opens the approval modal (`?approval=<number>`). */
  onReviewApproval?: (number: number) => void;
  /** Merge into main (only called when the PR can be merged). */
  onMerge?: () => void;
  merging?: boolean;
  /** Why the last merge attempt failed (the server's 409 / Blocked answer). */
  mergeError?: string | null;
}

/**
 * Branch room right pane (README "Branch room"): CHECKS, REVIEWERS, STAGING (approval summary and
 * "Review deploy"), then Merge into main — disabled (`not-allowed`) until checks and review pass — with the note
 * under it.
 */
export function BranchPane({
  detail,
  lookup,
  viewer,
  now,
  timeZone,
  onReviewApproval,
  onMerge,
  merging = false,
  mergeError = null,
}: BranchPaneProps) {
  const ids = useId();
  const checks = checkRows(detail.pr.checks);
  const reviewers = reviewerRows(detail.pr.reviewers, lookup);
  const staging = stagingView(detail, { lookup, viewer, now, timeZone });
  const merge = mergeButton(detail);
  const hintId = `${ids}-merge-hint`;
  const noteId = `${ids}-merge-note`;

  return (
    <SidePane
      width="branch"
      surface="side"
      scroll
      takeFocus={false}
      aria-label="Pull request"
      className={styles.pane}
    >
      <section className={styles.section} aria-labelledby={`${ids}-checks`}>
        <SectionLabel as="h2" id={`${ids}-checks`}>
          CHECKS
        </SectionLabel>
        {checks.length === 0 ? (
          <EmptyNote>No checks on this branch.</EmptyNote>
        ) : (
          <ul className={styles.sectionList}>
            {checks.map((c) => (
              <li key={c.name} className={styles.row}>
                <span
                  className={cx(styles.mark, c.mark === 'passed' && styles.passed)}
                  role="img"
                  aria-label={c.stateLabel}
                />
                <span className={styles.checkName}>{c.name}</span>
                <span className={styles.checkNote}>{c.note}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby={`${ids}-reviewers`}>
        <SectionLabel as="h2" id={`${ids}-reviewers`}>
          REVIEWERS
        </SectionLabel>
        {reviewers.length === 0 ? (
          <EmptyNote>No reviewers yet.</EmptyNote>
        ) : (
          <ul className={styles.sectionList}>
            {reviewers.map((r) => (
              <li key={r.principal?.id ?? r.name} className={styles.row}>
                <PrincipalAvatar principal={r.principal} size={26} crop="head" />
                <span className={styles.reviewerName}>{r.name}</span>
                <span className={styles.reviewState} style={{ color: `var(--${r.tone})` }}>
                  {r.state}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {staging && (
        <section className={styles.section} aria-labelledby={`${ids}-staging`}>
          <SectionLabel as="h2" id={`${ids}-staging`}>
            STAGING
          </SectionLabel>
          <div className={styles.staging}>
            <span className={styles.stagingText}>{staging.summary}</span>
            {staging.showReview && (
              <Button size="sm" className={styles.review} onClick={() => onReviewApproval?.(staging.number)}>
                {staging.reviewLabel}
              </Button>
            )}
          </div>
        </section>
      )}

      <div className={styles.mergeBlock}>
        <button
          type="button"
          className={cx(
            styles.merge,
            merge.look === 'ready' && styles.mergeReady,
            merge.look === 'merged' && styles.mergeMerged,
            merging && styles.mergeBusy,
          )}
          aria-disabled={!merge.canMerge || merging}
          aria-describedby={merge.hint ? `${hintId} ${noteId}` : noteId}
          onClick={() => {
            if (merge.canMerge && !merging) onMerge?.();
          }}
        >
          {merge.label}
        </button>
        {merge.hint && (
          <span id={hintId} className={styles.srOnly}>
            {merge.hint}
          </span>
        )}
        {mergeError && (
          <p className={styles.error} role="alert">
            {mergeError}
          </p>
        )}
        <span id={noteId} className={styles.note} data-merge-note>
          {/* Agents may hold Merge: the note says how they merge (AP-611). */}
          {MERGE_NOTE_WITH_KEYS}
        </span>
      </div>
    </SidePane>
  );
}
