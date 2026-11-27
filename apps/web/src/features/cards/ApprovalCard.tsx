import { stopAskingServer } from '@whombat/client';
import {
  type ApprovalAnswer,
  type ApprovalAnswerKey,
  type ApprovalView,
  approvalAnswer,
  approvalAnswerChoices,
  approvalCardFacts,
  approvalView,
  type Decider,
  isEverydayAsk,
  type NameInfo,
} from '@whombat/core/approvals';
import type { CommandScope } from '@whombat/core/commands';
import type { Approval } from '@whombat/core/domain';
import { alwaysAllowRow } from '@whombat/core/keys';
import type { DateInput } from '@whombat/core/text';
import { Check, Clock, LoaderCircle, type LucideIcon, TriangleAlert, X } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { currentLocale } from '../../i18n/provider';
import { AskCard, type AskCardEdit } from '../approvals/AskCard';
import { AskDetails } from '../approvals/AskDetails';
import { connectionCallView } from '../approvals/connectionCall';
import { CodeBlock } from '../messaging/CodeBlock';
import approvalStyles from './ApprovalCard.module.css';
import styles from './Card.module.css';
import { TONE_CLASS } from './parts';

export interface ApprovalCardProps {
  approval: Approval;
  /** Names of the people and agents the approval mentions. */
  names: (principalId: string) => NameInfo | undefined;
  /** The person looking at the card (“you”, whether Approve and Undo show). */
  viewer?: Decider;
  now: DateInput;
  timeZone: string;
  /** "Approve in advance" / "Approve and deploy". */
  onApprove?: () => void;
  /** "Details" opens the approval modal (`?approval=<number>`). */
  onDetails?: () => void;
  /**
   * “Tonight at 03:00” beside Approve (one-whombat.md ONE-10; app one-whombat-shell.md AP-1280): approve now, run then.
   * Only in a chat with Whombat, on a Whombat with `shell.assistant`.
   */
  approveLater?: { label: string; at: string; onSelect: () => void };
  /** The answer may have gone through: *Ask {assistant} to check* replaces the answers (command-safety.md). */
  unknown?: { checkLabel: string; onCheck: () => void } | null;
  onUndo?: () => void;
  /**
   * A `run_command`'s allow buttons (AC-42): “Allow once”, “Allow for this task”, “Always allow for Banjo”; a Vault use's
   * (GF-05); a risk-row card's “Always allow Banjo to deploy” (`agent`, RA-06); a Servers card's “Don’t ask again on The
   * Titan” (`agent`, Whombat server-asks.md SA-07).
   */
  onChoose?: (scope: CommandScope) => void;
  /** A `run_command`'s “Don’t allow”. */
  onDecline?: () => void;
  /** A decision is being saved: the buttons wait. */
  busy?: boolean;
  /** The assistant's draft report: Edit beside the answers opens the form with it. */
  edit?: AskCardEdit | null;
}

/**
 * Approval card. An everyday ask (a server's or connection's call, a message, a file, an invite; handle-it.md) reads
 * “Neo needs your OK” under its title with its answers in the one order every place uses — Yes, now · Yes, tonight · No
 * (Yes, do it · No where no later time is offered) — the lasting yes apart under a line as a text button that asks
 * first (“Don’t ask again for pve-02…”), and the tool, its target and what it sends under Technical details. Answered,
 * it keeps its title and says where it is (“Scheduled for tonight, 03:00”, Running, Done, “You said no”). Every other kind: title and target written from the action (`view`, never the requester's wording; a
 * "What actually runs" note when the stored wording disagrees), 1.5px warn border while pending, the label from `approvalView()` (NEEDS A PERSON,
 * APPROVED · WAITING FOR CHECKS, APPROVED · DEPLOYING, DEPLOYED, DEPLOY FAILED, DECLINED), the conditions
 * checklist, the explanation, and Approve + Details while pending or Undo once decided (until the
 * action has run, B-02). A `run_command` (AP-623) shows why the agent runs it under the title, the exact command as a
 * bash code block with Copy, and its three
 * allow buttons (“Allow once” first), “Don’t allow” and Details instead of Approve. A risk-row card (a deploy, a merge, a
 * push to main, an outside message, a refund; RA-06, AP-680) keeps Approve and Details and puts “Always allow Banjo to
 * deploy” between them; a Servers card that may stop asking puts “Don’t ask again on The Titan” there (Whombat
 * server-asks.md SA-07; AP-1720).
 */
export function ApprovalCard({
  approval,
  names,
  viewer,
  now,
  timeZone,
  onApprove,
  onDetails,
  approveLater,
  onUndo,
  onChoose,
  onDecline,
  unknown = null,
  busy = false,
  edit = null,
}: ApprovalCardProps) {
  const view: ApprovalView = useMemo(
    () => approvalView(approval, { names, viewer, now, timeZone }),
    [approval, names, viewer, now, timeZone],
  );
  const pending = approval.state === 'pending';
  const showActions = pending || view.canUndo;
  // A command the agent runs (agent-computer.md AC-41, AC-42; AP-623): the exact command, and how far a yes goes.
  const command = approval.action.type === 'run_command' ? view.content : null;
  // A connected service's call (CX-21, AP-763): the tool and its arguments, for the people who decide it.
  const call = connectionCallView(approval);
  // A risk row's “Always allow Banjo to …” (RA-06, AP-680) and a Servers call's “Don’t ask again on The Titan”
  // (Whombat server-asks.md SA-07; AP-1720): beside Approve, not the choices of a command or Vault card.
  const beside = alwaysAllowRow(approval.action) !== null || stopAskingServer(approval.action) !== null;
  const always = beside ? (view.scopeChoices?.find((c) => c.scope === 'agent') ?? null) : null;
  const choices = beside ? null : view.scopeChoices;
  const soleYes = view.conditions.every((c) => c.kind === 'person_approves');
  // An everyday ask (handle-it.md): “Neo needs your OK”, its answers, the lasting yes apart; the tool under Technical
  // details. Answered, the same card with where it is.
  if (isEverydayAsk(approval)) {
    const answer = approvalAnswer(approval, { names, viewer, now, timeZone });
    const later = view.canApprove ? approveLater : undefined;
    const choices = view.canApprove && view.canDecline ? approvalAnswerChoices(!!later, currentLocale()) : [];
    const run: Record<ApprovalAnswerKey, (() => void) | undefined> = {
      now: onApprove,
      later: later?.onSelect,
      no: onDecline,
    };
    const facts = approvalCardFacts(approval, view, { timeZone, tonight: later?.at ?? null });
    return (
      <AskCard
        facts={facts}
        actionNote={view.actionNote}
        why={view.why}
        pending={pending}
        busy={busy}
        answers={choices.map((c) => ({
          id: c.key,
          label: c.label,
          onSelect: () => run[c.key]?.(),
          ...(c.key === 'later' && later ? { title: later.label } : {}),
        }))}
        edit={edit}
        answered={answer ? <AnswerState answer={answer} /> : null}
        unknown={pending ? unknown : null}
        details={
          <AskDetails approval={approval} view={view} busy={busy} onLasting={() => onChoose?.('agent')} />
        }
        data={{
          'data-card': 'approval',
          'data-phase': view.phase,
          'data-ask': '',
          'data-answer': answer?.state,
        }}
      />
    );
  }
  return (
    <section
      className={cx(styles.card, approvalStyles.card, view.pendingBorder && approvalStyles.pending)}
      aria-label={`Approval: ${view.title}`}
      data-card="approval"
      data-phase={view.phase}
    >
      <div className={styles.header}>
        <span className={cx(styles.label, TONE_CLASS[view.tone])}>{view.label}</span>
        <span className={styles.metaMono}>{view.target}</span>
      </div>
      <span className={styles.title}>{view.title}</span>
      {/* What the agent needs the command for, in its words: the person decides by it. */}
      {view.why && <p className={approvalStyles.why}>{view.why}</p>}
      {view.actionNote && <p className={approvalStyles.actionNote}>{view.actionNote}</p>}
      {command && (
        <CodeBlock lang="bash" text={command.text} label={command.label} className={approvalStyles.command} />
      )}
      {call?.text != null && (
        <CodeBlock
          lang="json"
          text={call.text}
          label={`${call.label} · ${call.tool}`}
          className={approvalStyles.command}
        />
      )}
      {/* A person's yes alone is no checklist: the answers ask it (approval-card.md). */}
      {soleYes ? null : (
        <ul className={cx(styles.bare, approvalStyles.conditions)} aria-label="Conditions">
          {view.conditions.map((c) => (
            <li key={c.id} className={approvalStyles.condition} data-met={c.met}>
              <span className={cx(approvalStyles.check, c.met && approvalStyles.met)}>
                {c.met && <Icon name="can" size={12} />}
              </span>
              <span className={approvalStyles.conditionLabel}>
                {c.label}
                <span className={styles.srOnly}>{c.met ? ' (met)' : ' (not met yet)'}</span>
              </span>
              <span className={approvalStyles.note}>{c.note}</span>
            </li>
          ))}
        </ul>
      )}
      <p className={approvalStyles.message}>{view.message}</p>
      {showActions && choices && pending ? (
        <div className={cx(approvalStyles.actions, approvalStyles.choices)} data-answers="">
          {view.canApprove &&
            choices.map((choice) => (
              <Button
                key={choice.scope}
                variant="secondary"
                size="md"
                disabled={busy}
                onClick={() => onChoose?.(choice.scope)}
              >
                {choice.label}
              </Button>
            ))}
          {view.canDecline && (
            <Button variant="secondary" size="md" disabled={busy} onClick={onDecline}>
              {view.declineCta}
            </Button>
          )}
          <Button variant="ghost" size="md" onClick={onDetails}>
            Details
          </Button>
        </div>
      ) : showActions ? (
        <div className={cx(approvalStyles.actions, always && approvalStyles.choices)} data-answers="">
          {pending && view.canApprove && (
            <Button variant="secondary" size="lg" onClick={onApprove}>
              {view.cta}
            </Button>
          )}
          {pending && view.canApprove && approveLater && (
            <Button variant="secondary" size="lg" disabled={busy} onClick={approveLater.onSelect}>
              {approveLater.label}
            </Button>
          )}
          {pending && view.canApprove && always && (
            <Button
              variant="secondary"
              size="lg"
              disabled={busy}
              onClick={() => onChoose?.('agent')}
              data-always-allow=""
            >
              {always.label}
            </Button>
          )}
          {pending && (
            <Button variant="secondary" size="lg" onClick={onDetails}>
              Details
            </Button>
          )}
          {!pending && view.canUndo && (
            <Button variant="secondary" size="sm" className={approvalStyles.undo} onClick={onUndo}>
              Undo
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}

const ANSWER_ICONS: Record<ApprovalAnswer['state'], LucideIcon> = {
  scheduled: Clock,
  running: LoaderCircle,
  done: Check,
  approved: Check,
  failed: TriangleAlert,
  declined: X,
};

/** Where an answered ask is, under its title (its line above it keeps Undo while the yes can be taken back). */
function AnswerState({ answer }: { answer: ApprovalAnswer }) {
  return (
    <p className={approvalStyles.state} data-tone={answer.tone}>
      <Icon icon={ANSWER_ICONS[answer.state]} size={16} />
      {answer.text}
    </p>
  );
}
