import { type Principal, shortNameOf, turnStopLabel } from '@whombat/core';
import type { ReactNode } from 'react';
import { Button } from '../../components/Button';
import { useLocaleWords } from '../../i18n/words';
import type { TypingLine } from './MessageList';
import listStyles from './MessageList.module.css';
import { useCanStop, useStopTurn } from './useStopTurn';

/**
 * “Stop” after “Banjo is thinking” (docs/decisions/web-messages.md WX-10): the app's inline action (the run line's
 * Try again: 13.5px 600 `--brand`), named for whom it stops, busy while the answer is out.
 */
export function StopTurnButton({
  agent,
  pending,
  onStop,
  className,
}: {
  agent: Principal | undefined;
  pending: boolean;
  onStop: () => void;
  className?: string;
}) {
  const TURN_STOP_LABEL = useLocaleWords(turnStopLabel);
  const name = agent ? shortNameOf(agent) : 'the agent';
  return (
    <Button
      variant="link"
      className={className ?? listStyles.stop}
      disabled={pending}
      aria-busy={pending || undefined}
      aria-label={`${TURN_STOP_LABEL} ${name}`}
      title={`${TURN_STOP_LABEL} ${name}`}
      onClick={onStop}
      data-stop-turn=""
    >
      {TURN_STOP_LABEL}
    </Button>
  );
}

/**
 * The thinking line's Stop (WX-10) for a conversation or one of its threads: a line about an agent's turn
 * (`dispatchId`) gets the button where the viewer may stop it.
 */
export function useTypingStop(
  burrow: string,
  conversationId: string | undefined,
  lookup: (id: string) => Principal | undefined,
  viewer: Principal | undefined,
): (line: TypingLine) => ReactNode {
  const canStop = useCanStop();
  const { stop, pending } = useStopTurn(burrow);
  return (line) => {
    const id = line.dispatchId;
    if (!id || !line.principalId || !conversationId) return null;
    const agent = lookup(line.principalId);
    if (!canStop(agent, viewer)) return null;
    return (
      <StopTurnButton
        agent={agent}
        pending={pending === id}
        onStop={() => void stop(id, agent, { conversationId })}
      />
    );
  };
}
