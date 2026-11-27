import {
  ApiError,
  approveToastFor,
  automationAsker,
  type CommitResult,
  NeedsNewerAppError,
  namesWithAsker,
  problemText,
  SCREEN_NEEDS_NEWER_APP,
} from '@whombat/client';
import { useApproval, useDecideApproval, useUndoApproval } from '@whombat/client/react';
import {
  type ApprovalResponse,
  approvalView,
  type CommandScope,
  conversationLabel,
  type Decider,
} from '@whombat/core';
import { type ApprovalAnswerKey, isEverydayAsk } from '@whombat/core/approvals';
import { useMemo } from 'react';
import { useNavigateHref } from '../../app/routing/navigation';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { currentLocale } from '../../i18n/provider';
import { useBurrowViewer } from '../runs/useBurrowViewer';
import { ApprovalDetails } from './ApprovalDetails';
import styles from './ApprovalModal.module.css';
import { AskSheet, AskSheetState } from './AskSheet';
import { forgetUnknown, markIfUnknown } from './unknownAnswer';

export interface ApprovalModalProps {
  burrow: string;
  /** Approval number (`?approval=<number>` on any burrow page). */
  number: number;
  open: boolean;
  /** Closing removes `?approval=` and leaves the page underneath as it was. */
  onOpenChange: (open: boolean) => void;
}

/** What to say when a decision did not go through. */
export function decisionFailedToast(result: CommitResult<ApprovalResponse> | Error): string {
  if (result instanceof Error) return problemText(result, 'Couldn’t save that. Try again.', currentLocale());
  if (result.status === 'blocked') return result.message;
  return 'That didn’t go through. Try again.';
}

/**
 * Approval modal, 560px (TODO 9.1, 9.3): live from `approvals.get` (kept current by
 * `approval.updated` on the burrow topic). Approve and Decline close the modal and toast as the mock
 * does, optimistically; Undo is offered until the action has executed.
 */
export function ApprovalModal({ burrow, number, open, onOpenChange }: ApprovalModalProps) {
  const { data, error, refetch, isRefetchError } = useApproval(open ? { params: { burrow, number } } : null);
  const navigateHref = useNavigateHref();
  const viewer = useBurrowViewer(burrow);
  const toast = useToast();
  const decide = useDecideApproval(burrow);
  const undo = useUndoApproval(burrow);

  const approval = data?.approval;
  const decider: Decider | undefined = viewer.me ? { id: viewer.me.id, kind: 'person' } : undefined;
  const where = useMemo(() => {
    if (!approval || !viewer.bootstrap) return undefined;
    const s = viewer.bootstrap.sidebar;
    const conv = [...s.branchRooms, ...s.dms].find((c) => c.id === approval.conversationId);
    return conv ? conversationLabel(conv) : undefined;
  }, [approval, viewer.bootstrap]);
  const requester = approval ? viewer.principal(approval.requesterId) : undefined;
  // An automation asking (AP-997): its mark and “The automation is waiting …”, not an agent's.
  const asker = approval ? automationAsker(approval, requester) : null;
  const names = namesWithAsker(
    (id: string) => {
      const p = viewer.principal(id);
      return p ? { name: p.name, shortName: viewer.shortName(id) } : undefined;
    },
    approval?.requesterId ?? '',
    asker,
  );
  const view =
    approval &&
    approvalView(approval, {
      names,
      viewer: decider,
      now: Date.now(),
      timeZone: viewer.timeZone,
      where,
    });

  const onDecide = (decision: 'approve' | 'decline', scope?: CommandScope, executeAt?: string) => {
    if (!view || !approval) return;
    // A yes says how far it goes: “Allowed for this task. Banjo runs the command now.” (AC-42, AP-623), “Approved. From
    // now on Banjo may deploy without asking.” (RA-06, AP-680).
    const message =
      decision === 'approve'
        ? approveToastFor(approval, scope, {
            names,
            viewer: decider,
            now: Date.now(),
            timeZone: viewer.timeZone,
            where,
          })
        : view.toasts.decline;
    decide.mutate(
      { number, decision, ...(scope ? { scope } : {}), ...(executeAt ? { executeAt } : {}) },
      {
        onSuccess: (result) => {
          if (result.status !== 'ok') toast.show(decisionFailedToast(result));
        },
        // It may have gone through: the approval says so and offers a check, never the answers again.
        onError: (err) => {
          if (!markIfUnknown(burrow, number, err)) toast.show(decisionFailedToast(err));
        },
      },
    );
    onOpenChange(false);
    toast.show(message);
  };

  const onUndo = () =>
    undo.mutate(
      { number },
      {
        onSuccess: (result) => {
          if (result.status !== 'ok') toast.show(decisionFailedToast(result));
        },
        onError: (err) => toast.show(decisionFailedToast(err)),
      },
    );

  // An everyday ask: the thread's card, in a dialog of its own (approval-card.md).
  const everyday = approval ? isEverydayAsk(approval) : null;
  const notFound = error instanceof ApiError && (error.status === 404 || error.code === 'not_found');
  const retry = () => {
    forgetUnknown(burrow, number);
    void refetch();
  };
  if (!approval || !view || everyday)
    return (
      <Modal open={open} onOpenChange={onOpenChange} width="lg" padded={false} className={styles.sheetModal}>
        {approval && view ? (
          <AskSheet
            burrow={burrow}
            approval={approval}
            view={view}
            asker={asker}
            names={names}
            timeZone={viewer.timeZone}
            busy={decide.isPending || undo.isPending}
            refreshFailed={isRefetchError}
            onRetry={retry}
            onAnswer={(key: ApprovalAnswerKey, executeAt?: string) =>
              key === 'no' ? onDecide('decline') : onDecide('approve', undefined, executeAt)
            }
            onLasting={() => onDecide('approve', 'agent')}
          />
        ) : (
          <AskSheetState
            state={error ? (notFound ? 'empty' : 'failed') : 'loading'}
            onRetry={retry}
            onOpenInbox={() => navigateHref('/inbox')}
          >
            {error instanceof NeedsNewerAppError ? (
              <p className={styles.emptyText}>{SCREEN_NEEDS_NEWER_APP}</p>
            ) : null}
          </AskSheetState>
        )}
      </Modal>
    );

  return (
    <Modal open={open} onOpenChange={onOpenChange} width="md">
      <ApprovalDetails
        approval={approval}
        view={view}
        requester={{
          name: requester?.name ?? 'Someone',
          face: requester?.kind === 'agent' ? requester.face : null,
        }}
        asker={asker}
        busy={decide.isPending || undo.isPending}
        onApprove={() => onDecide('approve')}
        onDecline={() => onDecide('decline')}
        onChoose={(scope) => onDecide('approve', scope)}
        onUndo={onUndo}
      />
    </Modal>
  );
}
