import type { ApprovalView } from '@whombat/core/approvals';
import type { Approval } from '@whombat/core/domain';
import { CodeBlock } from '../messaging/CodeBlock';
import styles from './AskDetails.module.css';
import { connectionCallView } from './connectionCall';
import { LastingYes } from './LastingYes';

/**
 * What an everyday ask's Details fold holds, on the card and in its dialog alike: the target, the call and what it
 * sends, the message's whole body, the explainer, and the lasting yes behind its own confirmation.
 */
export function AskDetails({
  approval,
  view,
  busy,
  onLasting,
}: {
  approval: Approval;
  view: ApprovalView;
  busy: boolean;
  /** The lasting yes, confirmed. */
  onLasting?: () => void;
}) {
  const call = connectionCallView(approval);
  const lasting = view.canApprove ? view.lasting : null;
  return (
    <>
      <p className={styles.target}>{view.target}</p>
      {call ? (
        call.text !== null ? (
          <CodeBlock
            lang="json"
            text={call.text}
            label={`${call.label} · ${call.tool}`}
            className={styles.code}
          />
        ) : (
          <p>{call.tool} · only the people who decide this see what it sends.</p>
        )
      ) : null}
      {view.content ? (
        approval.action.type === 'run_command' ? (
          <CodeBlock lang="bash" text={view.content.text} label="bash" className={styles.code} />
        ) : (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a long message scrolls; a keyboard reaches it.
          <section className={styles.message} tabIndex={0} aria-label="The whole message">
            {view.content.text}
          </section>
        )
      ) : null}
      {approval.explainer ? <p>{approval.explainer}</p> : null}
      {lasting ? <LastingYes words={lasting} busy={busy} onConfirm={() => onLasting?.()} /> : null}
    </>
  );
}
