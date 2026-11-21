import { type ConnectionWords, connectionWords } from '@whombat/client/connections';
import { useTheAgent } from '@whombat/client/react';

/** Connections' words (less-is-more.md AP-1802): the agent by its name. */
export function useConnectionWords(burrow: string): ConnectionWords {
  const { words } = useTheAgent(burrow);
  // Website feedback's reports always come to the person's Feedback (feedback-chat.md AP-1834; one-agent.md OA-04).
  return connectionWords(words.name, { feedbackChat: true });
}
