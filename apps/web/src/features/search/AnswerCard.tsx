import { WhombatAvatar } from '@whombat/avatars/react';

import type { AgentFace, AnswerAction, SearchAnswer } from '@whombat/core';
import { formatAnswerMeta } from '@whombat/core';
import { segmentCitations } from '@whombat/core/text';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import styles from './AnswerCard.module.css';

export interface AnswerCardProps {
  answer: SearchAnswer;
  /** The agent's name and face, for the avatar and heading ("Dusty"). */
  agentName: string;
  agentFace: AgentFace;
  onAction: (action: AnswerAction) => void;
  /** Where citation `n` opens (its result's own link); a citation without one stays a plain marker. */
  citationHref?: (n: number) => string | null;
  onNavigate?: (href: string) => void;
}

/** The Dusty answer card: avatar, receipts meta, cited answer text, and its action buttons. */
export function AnswerCard({
  answer,
  agentName,
  agentFace,
  onAction,
  citationHref,
  onNavigate,
}: AnswerCardProps) {
  return (
    <div className={styles.card}>
      <WhombatAvatar face={agentFace} size={48} label={agentName} />
      <div className={styles.body}>
        <div className={styles.heading}>
          <span className={styles.name}>{agentName}</span>
          {answer.status === 'pending' ? (
            <span className={styles.meta}>thinking…</span>
          ) : answer.status === 'failed' ? (
            <span className={styles.meta}>couldn’t find an answer</span>
          ) : (
            <span className={styles.meta}>
              {formatAnswerMeta(answer.citations.length, answer.durationMs)}
            </span>
          )}
        </div>
        {answer.status === 'ready' && (
          <>
            <p className={styles.text}>
              {segmentCitations(answer.text).map((segment, i) =>
                segment.kind === 'text' ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: segments are a stable derived split of static text
                  <span key={i}>{segment.text}</span>
                ) : citationHref?.(segment.n) ? (
                  <a
                    key={`citation-${segment.n}`}
                    href={citationHref(segment.n) ?? undefined}
                    className={cx(styles.citation, styles.citationLink)}
                    aria-label={`Receipt ${segment.n}`}
                    onClick={(event) => {
                      const href = citationHref(segment.n);
                      if (!href || !onNavigate || event.button !== 0 || event.metaKey || event.ctrlKey)
                        return;
                      event.preventDefault();
                      onNavigate(href);
                    }}
                  >
                    {segment.n}
                  </a>
                ) : (
                  <span
                    key={`citation-${segment.n}`}
                    className={styles.citation}
                    role="img"
                    aria-label={`Citation ${segment.n}`}
                  >
                    {segment.n}
                  </span>
                ),
              )}
            </p>
            {answer.actions.length > 0 && (
              <div className={styles.actions}>
                {answer.actions.map((action) => (
                  <Button key={action.label} variant="secondary" size="sm" onClick={() => onAction(action)}>
                    {action.label}
                  </Button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export interface AskCardProps {
  agentName: string;
  agentFace: AgentFace;
  onAsk: () => void;
}

/**
 * The answer slot before anyone asked (web-efficiency.md WE-10): the researcher and “Ask Dusty”. Asking is an agent
 * turn, so it waits for the person (this button, or Enter in the field), never for a pause in typing.
 */
export function AskCard({ agentName, agentFace, onAsk }: AskCardProps) {
  return (
    <div className={styles.card} data-answer-slot="ask">
      <WhombatAvatar face={agentFace} size={48} label={agentName} />
      <div className={styles.body}>
        <div className={styles.heading}>
          <span className={styles.name}>{agentName}</span>
          <span className={styles.meta}>{ASK_META}</span>
        </div>
        <div className={styles.actions}>
          <Button variant="secondary" size="sm" onClick={onAsk}>
            Ask {agentName}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Under the researcher's name in the ask slot. */
export const ASK_META = 'answers from your chats and files, with sources · or press ↵';
