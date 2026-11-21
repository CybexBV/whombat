import { useTheAgent } from '@whombat/client/react';
import type { FeedbackIntegration } from '@whombat/core';
import { useCallback } from 'react';
import { type FeedbackWords, feedbackWords } from './copy';
import { assessorProblem } from './settingsForm';

/**
 * Whether the agent can assess reports now (FB-18; one-agent.md AP-4935): it runs read-only on Claude Code or ChatGPT
 * (`assessorProblem`, the server's rule). True until the agent is known, so nothing flashes “can't”.
 */
export function useAgentAssesses(burrow: string): boolean {
  const { agent } = useTheAgent(burrow);
  return !agent || assessorProblem(agent) === null;
}

/**
 * Website feedback's words (less-is-more.md AP-1804; one-agent.md AP-4935): the agent by its name, and where reports go —
 * Feedback (AP-1827, AP-2410).
 */
export function useFeedbackWords(burrow: string): FeedbackWords {
  const { words } = useTheAgent(burrow);
  return feedbackWords(words.name);
}

/** Where an integration's reports go, as you read it (AP-1829): your Feedback room. */
export interface ReportsDestination {
  /** “Feedback”. */
  text: string;
  /** Its path. */
  href: string;
}

/** Where an integration's reports go (AP-1829, AP-4936): your Feedback room (one Feedback room, Whombat OP-03). */
export function useReportsDestination(burrow: string): (i: FeedbackIntegration) => ReportsDestination {
  const words = useFeedbackWords(burrow);
  return useCallback(
    (_i: FeedbackIntegration): ReportsDestination => ({ text: words.chat.inSentence, href: '/feedback' }),
    [words],
  );
}
