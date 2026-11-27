import {
  AUTOMATION_ASKING,
  type AutomationAsker,
  nextAt,
  TEAM_REPORT_WORDS,
  teamReportDraftOf,
  teamReportDraftPath,
} from '@whombat/client';
import { useChangeWindow } from '@whombat/client/react';
import {
  type ApprovalAnswerKey,
  type ApprovalView,
  approvalAnswer,
  approvalAnswerChoices,
  approvalCardFacts,
  approvalCardWords,
  type NameInfo,
} from '@whombat/core/approvals';
import type { Approval } from '@whombat/core/domain';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigateHref } from '../../app/routing/navigation';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Skeleton } from '../../components/ListState';
import { ModalClose, ModalTitle } from '../../components/Modal';
import { currentLocale } from '../../i18n/provider';
import { useLocaleWords } from '../../i18n/words';
import { AutomationAvatar } from '../messaging/PrincipalAvatar';
import { AskCard } from './AskCard';
import { AskDetails } from './AskDetails';
import styles from './AskSheet.module.css';
import { useAskToCheck, useUnknownAnswer } from './unknownAnswer';

/** The approval's dialog head: “Approval details” and Close. */
function SheetHead() {
  return (
    <header className={styles.head}>
      <ModalTitle className={styles.title}>Approval details</ModalTitle>
      <ModalClose asChild>
        <Button variant="secondary" size="md" className={styles.close} aria-label="Close approval details">
          <Icon icon={X} size={16} />
        </Button>
      </ModalClose>
    </header>
  );
}

/**
 * An everyday ask's Details (`?approval=`): the same card as the thread's, in a dialog — its facts scrolling, its
 * answers in the card's order and words under them, the email's whole body open in Details. Answered, its state; when
 * the answer may have gone through, *Ask {assistant} to check* instead of the answers.
 */
export function AskSheet({
  burrow,
  approval,
  view,
  asker = null,
  names,
  timeZone,
  busy,
  refreshFailed,
  onRetry,
  onAnswer,
  onLasting,
}: {
  burrow: string;
  approval: Approval;
  view: ApprovalView;
  names: (id: string) => NameInfo | undefined;
  timeZone: string;
  busy: boolean;
  /** The last read failed: the saved copy shows, without answers until a read succeeds. */
  refreshFailed: boolean;
  onRetry: () => void;
  onAnswer: (key: ApprovalAnswerKey, executeAt?: string) => void;
  onLasting: () => void;
  /** An automation asks (AP-997): its mark and “AN AUTOMATION IS ASKING”. */
  asker?: AutomationAsker | null;
}) {
  const APPROVAL_CARD_WORDS = useLocaleWords(approvalCardWords);
  const quiet = useChangeWindow(burrow);
  // The assistant's draft report (team-reports.md) goes now or not at all, and Edit opens the form with it.
  const draftId = teamReportDraftOf(approval);
  const navigate = useNavigateHref();
  const tonight = draftId ? null : nextAt(Date.now(), timeZone, quiet.start);
  const pending = approval.state === 'pending';
  const card = approvalCardFacts(approval, view, { timeZone, tonight });
  const facts = asker && pending ? { ...card, status: AUTOMATION_ASKING } : card;
  const answer = approvalAnswer(approval, { names, now: Date.now(), timeZone });
  const mayHaveGoneThrough = useUnknownAnswer(burrow, approval.number);
  const check = useAskToCheck(burrow, view.title);
  const choices =
    view.canApprove && view.canDecline && !refreshFailed
      ? approvalAnswerChoices(draftId === null, currentLocale())
      : [];
  return (
    <div className={styles.sheet} data-screen="approval" data-phase={view.phase}>
      <SheetHead />
      <div className={styles.body}>
        {refreshFailed ? (
          <ReadProblem
            title={APPROVAL_CARD_WORDS.failedRefresh}
            body={APPROVAL_CARD_WORDS.saved}
            onRetry={onRetry}
          />
        ) : null}
        <AskCard
          variant="sheet"
          facts={facts}
          asker={asker ? <AutomationAvatar size={20} label={asker.label} /> : null}
          actionNote={view.actionNote}
          why={view.why}
          pending={pending}
          busy={busy}
          detailsOpen={view.content !== null}
          answers={choices.map((c) => ({
            id: c.key,
            label: c.label,
            onSelect: () =>
              onAnswer(c.key, c.key === 'later' ? nextAt(Date.now(), timeZone, quiet.start) : undefined),
          }))}
          edit={
            draftId
              ? { label: TEAM_REPORT_WORDS.edit, href: teamReportDraftPath(draftId), onNavigate: navigate }
              : null
          }
          answered={answer ? <p className={styles.answered}>{answer.text}</p> : null}
          unknown={pending && mayHaveGoneThrough ? check : null}
          details={<AskDetails approval={approval} view={view} busy={busy} onLasting={onLasting} />}
          data={{ 'data-card': 'approval', 'data-ask': '', 'data-answer': answer?.state }}
        />
      </div>
    </div>
  );
}

/** A read that went wrong: what happened, what shows, and Try again (it only reads). */
function ReadProblem({ title, body, onRetry }: { title: string; body: string; onRetry: () => void }) {
  const APPROVAL_CARD_WORDS = useLocaleWords(approvalCardWords);
  return (
    <section className={styles.problem} role="status">
      <h3 className={styles.problemTitle}>{title}</h3>
      <p className={styles.problemBody}>{body}</p>
      <div className={styles.recovery}>
        <Button variant="secondary" size="lg" onClick={onRetry}>
          {APPROVAL_CARD_WORDS.retry}
        </Button>
      </div>
    </section>
  );
}

/** The approval's read states in its dialog: loading, nothing to show, a first read that failed. */
export function AskSheetState({
  state,
  onRetry,
  onOpenInbox,
  children,
}: {
  state: 'loading' | 'empty' | 'failed';
  onRetry: () => void;
  onOpenInbox: () => void;
  /** A note that replaces the words (an app too old for this Whombat). */
  children?: ReactNode;
}) {
  const APPROVAL_CARD_WORDS = useLocaleWords(approvalCardWords);
  const W = APPROVAL_CARD_WORDS;
  return (
    <div className={styles.sheet} data-screen="approval" aria-busy={state === 'loading' || undefined}>
      <SheetHead />
      <div className={styles.body}>
        {children ? (
          children
        ) : state === 'loading' ? (
          <section className={styles.state} role="status" aria-label={W.loading}>
            <p className={styles.stateBody}>{W.loading}</p>
            <div className={styles.skeletons} aria-hidden="true">
              <Skeleton width="100%" height={14} />
              <Skeleton width="78%" height={14} />
              <Skeleton width="60%" height={14} />
            </div>
          </section>
        ) : state === 'empty' ? (
          <section className={styles.state}>
            <h3 className={styles.stateTitle}>{W.empty}</h3>
            <p className={styles.stateBody}>{W.emptyBody}</p>
            <div className={styles.recovery}>
              <Button variant="secondary" size="lg" onClick={onOpenInbox}>
                {W.openInbox}
              </Button>
            </div>
          </section>
        ) : (
          <ReadProblem title={W.failed} body={W.noSaved} onRetry={onRetry} />
        )}
      </div>
    </div>
  );
}
