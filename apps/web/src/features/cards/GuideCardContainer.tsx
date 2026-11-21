import { GUIDE_NETWORK_TEXT, type GuideActInput, guideRefusalOf } from '@whombat/client';
import { useGuideAct } from '@whombat/client/react';
import type { GuideCard as GuideCardData } from '@whombat/core/domain';
import { useRef, useState } from 'react';
import { useToast } from '../../components/Toast';
import { GuideCard } from './GuideCard';
import type { GuideFormProblem } from './GuideForm';
import type { NavigateHandler } from './parts';

export interface GuideCardContainerProps {
  burrow: string;
  card: GuideCardData;
  messageId: string;
  onNavigate?: NavigateHandler;
  /** After the answer went through (the next step is posted in the card's thread). */
  onActed?: () => void;
}

/**
 * A guide card wired to `guides.act` (AG-03): the card locks at once with the answer and the server posts the
 * next step. A refusal restores it: `guide_closed` (another tab or the phone answered first) just shows the card as
 * the server has it, `invalid_values` goes back to the form's fields, anything else is the server's words in a
 * toast.
 */
export function GuideCardContainer({
  burrow,
  card,
  messageId,
  onNavigate,
  onActed,
}: GuideCardContainerProps) {
  const toast = useToast();
  const act = useGuideAct(burrow);
  const [formProblem, setFormProblem] = useState<GuideFormProblem | null>(null);

  // One act at a time: `isPending` reaches this component a tick after `mutate`, a second press can come first.
  const inFlight = useRef(false);

  const onAct = async (input: GuideActInput): Promise<boolean> => {
    if (act.isPending || inFlight.current) return false;
    inFlight.current = true;
    setFormProblem(null);
    try {
      const result = await act.mutateAsync({ messageId, ...input });
      if (result.status === 'ok') {
        onActed?.();
        return true;
      }
      toast.show(result.status === 'blocked' ? result.message : 'That needs a person to approve it first.');
      return false;
    } catch (err) {
      const refusal = guideRefusalOf(err);
      if (!refusal) toast.show(GUIDE_NETWORK_TEXT);
      else if (refusal.code === 'invalid_values' && input.values)
        setFormProblem({ message: refusal.message, fields: refusal.fields ?? {} });
      else if (refusal.code !== 'guide_closed') toast.show(refusal.message);
      return false;
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <GuideCard
      burrow={burrow}
      card={card}
      onAct={onAct}
      busy={act.isPending}
      formProblem={formProblem}
      onNavigate={onNavigate}
    />
  );
}
