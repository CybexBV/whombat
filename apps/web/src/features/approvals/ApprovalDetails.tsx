import { AUTOMATION_ASKING, type AutomationAsker, agentFaceOf, stopAskingServer } from '@whombat/client';
import {
  type AgentFace,
  type Approval,
  type ApprovalView,
  alwaysAllowRow,
  type CommandScope,
} from '@whombat/core';
import { Button } from '../../components/Button';
import { ModalClose, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { LiveAgentFace } from '../agent/LiveAgentFace';
import { CodeBlock } from '../messaging/CodeBlock';
import { AutomationAvatar } from '../messaging/PrincipalAvatar';
import styles from './ApprovalDetails.module.css';
import { connectionCallView } from './connectionCall';
import { LastingYes } from './LastingYes';

export interface ApprovalDetailsProps {
  approval: Approval;
  /** `approvalView()` for the viewer at this moment (labels, notes, CTA, who may decide). */
  view: ApprovalView;
  /** The agent asking ("NEO IS ASKING"). */
  /** The agent that asks: its name and face (OA-08). */
  requester: { name: string; face?: AgentFace | null };
  /** An automation asks instead (AP-997): its mark, and “AN AUTOMATION IS ASKING”. */
  asker?: AutomationAsker | null;
  onApprove?: () => void;
  onDecline?: () => void;
  onUndo?: () => void;
  /**
   * A `run_command`'s allow buttons (AC-42): once, for this task, always for the agent; a risk row's once and “Always
   * allow Banjo to deploy” (RA-06).
   */
  onChoose?: (scope: CommandScope) => void;
  /** A decision is being saved: the buttons wait. */
  busy?: boolean;
}

/**
 * Contents of the 560px approval modal (README screen 9): 64px avatar, kicker, question (written from the
 * action, with a "What actually runs" note when the stored wording disagrees); WHAT HAPPENS; WHY and COMMAND (a
 * command the agent runs: what it is for, in its words, then exactly what runs); MESSAGE (an
 * email's whole body); CONDITIONS (live); explainer on sf2; Decline / Approve ("Approve in advance" until the other
 * conditions are met, then "Approve and deploy"). Once decided it shows the card's state label and
 * message, with Undo until the action has run. Render inside `<Modal width="md">`.
 */
export function ApprovalDetails({
  approval,
  view,
  requester,
  asker = null,
  onApprove,
  onDecline,
  onUndo,
  onChoose,
  busy = false,
}: ApprovalDetailsProps) {
  const pending = approval.state === 'pending';
  // A command on the agent's computer (agent-computer.md AC-41, AC-42; AP-623), a risk row (RA-06, AP-680): the yeses
  // that go further sit above the usual pair.
  const choices = view.scopeChoices;
  const command = approval.action.type === 'run_command';
  // A connected service's call (CX-21, AP-763): the tool and its arguments, for the people who decide it.
  const call = connectionCallView(approval);
  // A risk row's “Always allow Neo to deploy” (AP-680) or a Servers call's “Don’t ask again on The Titan” (AP-1720).
  const risk = alwaysAllowRow(approval.action) !== null || stopAskingServer(approval.action) !== null;
  const person = view.conditions.find((c) => c.kind === 'person_approves');
  return (
    <div className={styles.details} data-screen="approval" data-phase={view.phase}>
      <div className={styles.head}>
        {asker ? (
          <AutomationAvatar size={64} label={asker.label} />
        ) : (
          // It waits for the person while the question is open, then rests.
          <LiveAgentFace
            face={agentFaceOf(requester)}
            size={64}
            label={requester.name}
            state={pending ? 'needs' : 'idle'}
          />
        )}
        <div className={styles.heading}>
          <SectionLabel tone={pending ? 'warn' : view.tone === 'neutral' ? 'mut' : view.tone}>
            {pending ? (asker ? AUTOMATION_ASKING : view.kicker) : view.label}
          </SectionLabel>
          <ModalTitle className={styles.question}>{view.question}</ModalTitle>
        </div>
      </div>

      {view.actionNote && (
        <p className={styles.actionNote} role="note">
          {view.actionNote}
        </p>
      )}

      {/* A command's WHAT HAPPENS repeats it word for word: the COMMAND block below says it (AP-623). */}
      {view.whatHappens.length > 0 && !(command && view.content) && (
        <div className={styles.section}>
          <SectionLabel as="h3">WHAT HAPPENS</SectionLabel>
          <ol className={styles.steps}>
            {view.whatHappens.map((s) => (
              <li key={s.n} className={styles.step}>
                <span className={styles.stepN} aria-hidden="true">
                  {s.n}
                </span>
                <span>{s.text}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {view.why && (
        <div className={styles.section}>
          <SectionLabel as="h3">WHY</SectionLabel>
          <p className={styles.why}>{view.why}</p>
        </div>
      )}

      {view.content && command ? (
        <div className={styles.section}>
          <SectionLabel as="h3">{view.content.label}</SectionLabel>
          {/* The exact command, as it will run on the agent's computer: read all of it before saying yes. */}
          <CodeBlock lang="bash" text={view.content.text} label="bash" className={styles.command} />
        </div>
      ) : view.content ? (
        <div className={styles.section}>
          <SectionLabel as="h3">{view.content.label}</SectionLabel>
          {/* The whole email as it will be sent (IN-16): the approver reads all of it before saying yes. */}
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region is reachable by keyboard. */}
          <section className={styles.content} tabIndex={0} aria-label="The whole message">
            {view.content.text}
          </section>
        </div>
      ) : null}

      {call && (
        <div className={styles.section}>
          <SectionLabel as="h3">{call.label}</SectionLabel>
          {call.text !== null ? (
            <CodeBlock lang="json" text={call.text} label={call.tool} className={styles.command} />
          ) : (
            <p className={styles.actionNote}>
              {call.tool} · only the people who decide this see what it sends.
            </p>
          )}
        </div>
      )}

      {/* A person's yes alone is no checklist: the answers ask it (approval-card.md). */}
      {view.conditions.every((c) => c.kind === 'person_approves') ? null : (
        <div className={styles.conditions}>
          <SectionLabel as="h3" className={styles.conditionsLabel}>
            CONDITIONS
          </SectionLabel>
          <ul className={styles.list}>
            {view.conditions.map((c) => (
              <li key={c.id} className={styles.condition} data-met={c.met}>
                <span className={styles.check} aria-hidden="true">
                  {c.mark}
                </span>
                <span className={styles.conditionLabel}>
                  {c.label}
                  <span className={styles.srOnly}>{c.met ? ' · met' : ' · not yet'}</span>
                </span>
                <span className={styles.note}>{c.note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className={styles.explainer} data-testid="approval-explainer">
        {pending ? approval.explainer || view.message : view.message}
      </p>

      {/* The answers in the card's order and words, outlined alike so none looks recommended (approval-card.md). */}
      <div
        className={choices && pending ? `${styles.actions} ${styles.choices}` : styles.actions}
        data-answers=""
      >
        {pending && view.canDecline && view.ask && (
          <>
            <Button
              variant="secondary"
              size="xl"
              disabled={busy}
              onClick={choices ? () => onChoose?.('once') : onApprove}
            >
              {view.ask.yes}
            </Button>
            <Button variant="secondary" size="xl" disabled={busy} onClick={onDecline}>
              {view.ask.no}
            </Button>
            {view.lasting && view.canApprove ? (
              <LastingYes
                words={view.lasting}
                busy={busy}
                onConfirm={() => onChoose?.('agent')}
                className={styles.lasting}
              />
            ) : null}
          </>
        )}
        {pending && view.canDecline && !view.ask && choices && !risk && (
          <>
            {/* Allow once · Allow for this task · Always allow for Banjo · Don’t allow, as on the card (AC-42). */}
            {choices.map((choice) => (
              <Button
                key={choice.scope}
                variant="secondary"
                size="xl"
                disabled={busy}
                onClick={() => onChoose?.(choice.scope)}
              >
                {choice.label}
              </Button>
            ))}
            <Button variant="secondary" size="xl" disabled={busy} onClick={onDecline}>
              {view.declineCta}
            </Button>
          </>
        )}
        {pending && view.canDecline && !view.ask && choices && risk && (
          <>
            {/* Approve · Always allow Banjo to deploy · Decline, as on the card (AP-680, AP-1720). */}
            <Button variant="secondary" size="xl" disabled={busy} onClick={() => onChoose?.('once')}>
              {view.cta}
            </Button>
            {choices
              .filter((c) => c.scope !== 'once')
              .map((choice) => (
                <Button
                  key={choice.scope}
                  variant="secondary"
                  size="xl"
                  disabled={busy}
                  onClick={() => onChoose?.(choice.scope)}
                  data-always-allow=""
                >
                  {choice.label}
                </Button>
              ))}
            <Button variant="secondary" size="xl" disabled={busy} onClick={onDecline}>
              {view.declineCta}
            </Button>
          </>
        )}
        {pending && view.canDecline && !view.ask && !choices && (
          <>
            <Button variant="secondary" size="xl" disabled={busy} onClick={onApprove}>
              {view.cta}
            </Button>
            <Button variant="secondary" size="xl" disabled={busy} onClick={onDecline}>
              {view.declineCta}
            </Button>
          </>
        )}
        {pending && !view.canDecline && (
          <span className={styles.waiting}>Only {person?.note || 'a person'} can decide this.</span>
        )}
        {!pending && (
          <>
            {view.canUndo && (
              <Button variant="secondary" size="xl" disabled={busy} onClick={onUndo}>
                Undo
              </Button>
            )}
            <ModalClose asChild>
              <Button variant="primary" size="xl" padX={20}>
                Close
              </Button>
            </ModalClose>
          </>
        )}
      </div>
    </div>
  );
}
