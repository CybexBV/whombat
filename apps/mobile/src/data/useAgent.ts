/**
 * The Whombat's agent and the words that name it (Whombat one-agent.md OA-01, OA-08; app one-agent.md AP-4900, AP-4960):
 * `@whombat/client`'s `theAgentOf` and `agentWords`, read from `useBurrowBase`'s people, which change only when the
 * principals do (AP-900). The client's `useTheAgent(burrow)` reads the whole bootstrap, which changes with every message
 * (its sidebar), and would re-render every chat's composer each time. A rename shows everywhere as soon as the bootstrap
 * has it (`useSetAgentModel`'s answer, or `agent.updated`).
 */
import { type AgentWords, agentWords } from '@whombat/client';
import { useMemo } from 'react';
import { useBurrowBase } from './BurrowProvider';
import type { AgentPrincipal } from './people';

/** The agent, once the bootstrap has it. */
export function useTheAgentHere(): AgentPrincipal | undefined {
  return useBurrowBase().people.agent;
}

/** “Neo”, “Ask Neo…”, “Reply to Neo…”; “your agent” while the bootstrap has none. */
export function useAgentWords(): AgentWords {
  const name = useTheAgentHere()?.name ?? null;
  return useMemo(() => agentWords(name), [name]);
}
