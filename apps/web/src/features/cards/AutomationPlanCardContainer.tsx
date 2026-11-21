import { useQueryClient } from '@tanstack/react-query';
import { findCachedMessage, queryKeys, upsertMessageEverywhere } from '@whombat/client/query';
import { useApiMutation, useBootstrap, useTheAgent } from '@whombat/client/react';
import {
  type AutomationPlanCard as AutomationPlanCardData,
  type AutomationPlanState,
  type AutomationPlanView,
  shortNameOf,
} from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { useState } from 'react';
import { useToast } from '../../components/Toast';
import { useAutomationSamples } from '../automations/hooks';
import {
  errorWords,
  refusalText,
  useApplyAutomation,
  useStartRun,
} from '../automations/useAutomationActions';
import { AutomationPlanCard } from './AutomationPlanCard';
import { newestSample, PLAN_TOASTS, planSettledLine, tryItLabel } from './automationPlan';
import lineStyles from './RunLine.module.css';
import { SettledLine } from './SettledLine';

export interface AutomationPlanCardContainerProps {
  burrow: string;
  card: AutomationPlanCardData;
  messageId: string;
  conversationId: string;
  size: 'md' | 'sm';
  anchorId?: string;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * A plan in a conversation (docs/decisions/automation-chat.md): the card with Turn it on, Try it and Not
 * now while it waits; once decided, replaced or its automation deleted, one line that opens the card. A plan the
 * runtime couldn't resolve (`plan` null) adds nothing to the message's text.
 */
export function AutomationPlanCardContainer(props: AutomationPlanCardContainerProps) {
  const { plan } = props.card;
  if (!plan) return null;
  return <PlanCardLive {...props} plan={plan} />;
}

function PlanCardLive({
  burrow,
  plan,
  messageId,
  conversationId,
  size,
  anchorId,
  expanded,
  onToggle,
}: AutomationPlanCardContainerProps & { plan: AutomationPlanView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { words } = useTheAgent(burrow);
  const { data: boot } = useBootstrap({ params: { burrow } });
  const apply = useApplyAutomation(burrow);
  const accept = useApiMutation(api.automations.acceptPlan);
  const decline = useApiMutation(api.automations.declinePlan);
  const start = useStartRun(burrow);
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const waiting = plan.state === 'waiting';
  // Try it's sample, asked only while the plan waits and something like an issue starts it.
  const samples = useAutomationSamples(
    waiting && plan.tryIt === 'sample' ? { params: { burrow, id: plan.automationId } } : null,
    { retry: false },
  );
  const sample = newestSample(samples.data?.samples);
  const timeZone = boot?.preferences.timeZone ?? boot?.burrow.timeZone ?? 'Europe/Amsterdam';

  // The card settles at once; the runtime's `message.updated` brings the same for every screen.
  const settle = (state: AutomationPlanState, version: number | null = null) => {
    const message = findCachedMessage(qc, messageId);
    if (message?.card?.kind !== 'automation_plan' || !message.card.plan) return;
    upsertMessageEverywhere(qc, {
      ...message,
      card: {
        ...message.card,
        plan: {
          ...message.card.plan,
          state,
          decidedAt: new Date().toISOString(),
          decidedById: boot?.me.id ?? null,
          version,
        },
      },
    });
  };
  // A refusal: the card may be out of date (replaced, decided elsewhere): read it again.
  const reread = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.scope('messages.list', { conversationId }) });
    void qc.invalidateQueries({ queryKey: queryKeys.scope('messages.thread') });
  };
  const refreshAutomations = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.scope(api.automations.list) });
    void qc.invalidateQueries({ queryKey: queryKeys.scope(api.automations.get, { id: plan.automationId }) });
  };

  const onAccept = () => {
    if (busy) return;
    setBusy('accept');
    accept.mutate(
      { params: { burrow, planId: plan.planId } },
      {
        onSuccess: (res) => {
          if (res.status !== 'ok') {
            toast.show(refusalText(res));
            reread();
            return;
          }
          apply(res.data);
          settle('accepted', res.data.automation.currentVersion);
          toast.show(PLAN_TOASTS.accepted(res.data.automation.name));
        },
        onError: (err) => {
          toast.show(errorWords(err));
          reread();
        },
        onSettled: () => setBusy(null),
      },
    );
  };

  const onDecline = () => {
    if (busy) return;
    setBusy('decline');
    decline.mutate(
      { params: { burrow, planId: plan.planId } },
      {
        onSuccess: (res) => {
          if (res.status !== 'ok') {
            toast.show(refusalText(res));
            reread();
            return;
          }
          settle('declined');
          refreshAutomations();
          toast.show(plan.change ? PLAN_TOASTS.kept : PLAN_TOASTS.declined);
        },
        onError: (err) => {
          toast.show(errorWords(err));
          reread();
        },
        onSettled: () => setBusy(null),
      },
    );
  };

  const card = (
    <AutomationPlanCard
      plan={plan}
      agentName={words.name}
      tryLabel={waiting ? tryItLabel(plan.tryIt, sample) : null}
      busy={busy ?? (start.busy ? 'try' : null)}
      onAccept={onAccept}
      onDecline={onDecline}
      onTry={() => void start.tryIt(plan.automationId, plan.tryIt, plan.tryIt === 'sample' ? sample : null)}
    />
  );
  if (waiting) return card;

  const decider =
    plan.decidedById && plan.decidedById !== boot?.me.id
      ? boot?.principals.find((p) => p.id === plan.decidedById)
      : undefined;
  return (
    <SettledLine
      line={planSettledLine(plan, {
        decider: decider ? shortNameOf(decider) : null,
        timeZone,
        now: Date.now(),
      })}
      label={`Automation plan: ${plan.name}`}
      card="automation_plan"
      size={size}
      id={anchorId}
      expanded={expanded}
      onToggle={onToggle}
    >
      {expanded && <div className={lineStyles.opened}>{card}</div>}
    </SettledLine>
  );
}
