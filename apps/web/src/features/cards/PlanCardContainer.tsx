import { useTheAgent } from '@whombat/client/react';
import type { PlanStep } from '@whombat/core/domain';
import { usePlanActions } from '../plans/usePlanActions';
import { PlanCard, type PlanCardProps } from './PlanCard';

/** The plan card in a thread, with “Go ahead” on a step the agent stopped at for the person's word. */
export function PlanCardContainer({
  burrow,
  ...props
}: Omit<PlanCardProps, 'onGoAhead' | 'goingAhead'> & { burrow: string }) {
  const actions = usePlanActions(burrow);
  const { words } = useTheAgent(burrow);
  const goingAhead = actions.pending?.startsWith('retry:') ? actions.pending.slice('retry:'.length) : null;
  const goAhead = (step: PlanStep) => void actions.start(props.plan, step, 'retry');
  return <PlanCard {...props} onGoAhead={goAhead} goingAhead={goingAhead} assistant={words.name} />;
}
