/**
 * The Whombat's agent and the words that name it (Whombat one-agent.md OA-01, OA-08; app one-agent.md AP-4900): the
 * burrow's bootstrap read once, so every screen says “Ask Dusty”, “Reply to Dusty…”, and “your agent” only until the
 * bootstrap is there. Web and phone.
 */
import type { Agent, Bootstrap } from '@whombat/core';
import { useMemo } from 'react';
import { type AgentWords, agentWords, theAgentOf } from '../agentName';
import { useBootstrapSelect } from './queries';

export interface TheAgent {
  /** The Whombat's agent, once the bootstrap is read. */
  agent: Agent | undefined;
  /** Its words: “Ask Dusty”, “Reply to Dusty…”. */
  words: AgentWords;
}

const principalsOf = (bootstrap: Bootstrap) => bootstrap.principals;

export function useTheAgent(burrow: string): TheAgent {
  const principals = useBootstrapSelect(burrow, principalsOf);
  return useMemo(() => {
    const agent = theAgentOf(principals) as Agent | undefined;
    return { agent, words: agentWords(agent?.name) };
  }, [principals]);
}
