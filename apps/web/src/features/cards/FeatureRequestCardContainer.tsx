import { useQueryClient } from '@tanstack/react-query';
import {
  featureDecideBody,
  featureDecidedToast,
  featureRequestLabel,
  featureRequestLine,
} from '@whombat/client';
import { findCachedMessage, queryKeys, upsertMessageEverywhere } from '@whombat/client/query';
import { useApiMutation } from '@whombat/client/react';
import {
  type FeatureDecisionChoice,
  type FeatureRequestCard as FeatureRequestCardData,
  type FeatureRequestView,
  shortNameOf,
} from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { useState } from 'react';
import { writeProblem } from '../../app/problem';
import { useToast } from '../../components/Toast';
import { refusalText } from '../automations/useAutomationActions';
import { FeatureRequestCard } from './FeatureRequestCard';
import type { PrincipalLookup } from './parts';
import lineStyles from './RunLine.module.css';
import { SettledLine } from './SettledLine';

export interface FeatureRequestCardContainerProps {
  burrow: string;
  card: FeatureRequestCardData;
  messageId: string;
  conversationId: string;
  principals: PrincipalLookup;
  size: 'md' | 'sm';
  anchorId?: string;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * A feature request in its report's thread: the card while it waits for the
 * person, then one line (“Approved by John · Planned · …”) that opens the card in place. One component for both, so an
 * answer in flight and its problem survive the card turning into its line. A request the runtime couldn't resolve
 * (`request` null) adds nothing to the message's text.
 */
export function FeatureRequestCardContainer(props: FeatureRequestCardContainerProps) {
  const { request } = props.card;
  if (!request) return null;
  return <FeatureRequestLive {...props} request={request} />;
}

function FeatureRequestLive({
  burrow,
  card,
  request,
  messageId,
  conversationId,
  principals,
  size,
  anchorId,
  expanded,
  onToggle,
}: FeatureRequestCardContainerProps & { request: FeatureRequestView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const decide = useApiMutation(api.tracker.decide);
  const [busy, setBusy] = useState<FeatureDecisionChoice | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const decidedBy = request.decidedById ? principals(request.decidedById) : undefined;
  const decider = decidedBy ? shortNameOf(decidedBy) : null;

  // The card settles at once with the server's answer; its `message.updated` brings the same for every screen.
  const settle = (next: FeatureRequestView) => {
    const message = findCachedMessage(qc, messageId);
    if (message?.card?.kind !== 'feature_request') return;
    upsertMessageEverywhere(qc, { ...message, card: { ...message.card, request: next } });
  };
  // A refusal: the card may be out of date (decided elsewhere, replaced): read it again.
  const reread = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.scope('messages.list', { conversationId }) });
    void qc.invalidateQueries({ queryKey: queryKeys.scope('messages.thread') });
  };

  const onDecide = (choice: FeatureDecisionChoice, note?: string) => {
    if (busy) return;
    setBusy(choice);
    setProblem(null);
    decide.mutate(
      { params: { burrow, requestId: card.requestId }, body: featureDecideBody(choice, note) },
      {
        onSuccess: (res) => {
          if (res.status !== 'ok') {
            setProblem(refusalText(res));
            reread();
            return;
          }
          settle(res.data.request);
          toast.show(featureDecidedToast(choice, request.agent));
        },
        onError: (err) => {
          setProblem(writeProblem(err));
          reread();
        },
        onSettled: () => setBusy(null),
      },
    );
  };

  const full = (
    <FeatureRequestCard
      request={request}
      decider={decider}
      busy={busy}
      problem={problem}
      onDecide={onDecide}
    />
  );
  if (request.state === 'waiting') return full;
  return (
    <SettledLine
      line={featureRequestLine(request, decider)}
      label={featureRequestLabel(request)}
      card="feature_request"
      size={size}
      id={anchorId}
      expanded={expanded}
      onToggle={onToggle}
    >
      {/* Someone else answered first: the card is a line now, and says why this answer didn't go. */}
      {problem && !expanded && (
        <p className={lineStyles.problem} role="alert">
          {problem}
        </p>
      )}
      {expanded && <div className={lineStyles.opened}>{full}</div>}
    </SettledLine>
  );
}
