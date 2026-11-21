/**
 * Who and what a feedback integration may use (docs/decisions/feedback.md FB-18, FB-20). The same checks decide a
 * configuration change (refused, naming the field), the live health warnings of an integration, and — for the
 * assessment worker — whether an intake snapshot is still authorized.
 */
import type { AgentProvider } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { repos } from '../db/schema/index';
import { isThePerson } from '../domain/the-person';
import { agentRuntimeOf, loadPrincipalRow } from '../read/principals';

/**
 * Providers an assessor may run on: Claude Code and Codex, whose read-only modes Whombat can ask Hermes for
 * (hermes-engine.md HE-36).
 */
export const ASSESSOR_PROVIDERS: readonly AgentProvider[] = ['claude', 'codex'];

export type AgentProblem = 'agent_missing' | 'agent_not_eligible' | 'agent_unsupported_provider';

/** What `agentProblem` found, in words for the person setting it up (the agent by its name, one-agent.md OA-23). */
export function agentProblemText(problem: AgentProblem, name = 'The agent'): string {
  return AGENT_PROBLEM_TEXT[problem].replaceAll('{agent}', name);
}

export const AGENT_PROBLEM_TEXT: Record<AgentProblem, string> = {
  agent_missing: 'This Whombat has no agent yet.',
  agent_not_eligible: 'Only {agent} can assess reports.',
  agent_unsupported_provider:
    '{agent} must run on Claude or ChatGPT to assess reports. ACP runtimes can’t be kept read-only by Whombat.',
};

/**
 * What is wrong with the agent assessing in `channelId` (null: nothing). `assessor: false` skips the provider check
 * (building the fix works under the agent's own keys, FB-24).
 */
export async function agentProblem(
  db: Db,
  burrowId: string,
  agentId: string,
  options: { assessor: boolean } = { assessor: true },
): Promise<AgentProblem | null> {
  const row = await loadPrincipalRow(db, agentId);
  // The agent assesses and fixes (one-agent.md OA-16): Whombat's own signers never do.
  if (!row || row.burrowId !== burrowId) return 'agent_missing';
  if (row.kind !== 'agent') return 'agent_not_eligible';
  if (options.assessor) {
    const runtime = agentRuntimeOf(row.runtime);
    if (!ASSESSOR_PROVIDERS.includes(runtime.provider)) return 'agent_unsupported_provider';
  }
  return null;
}

/** Whether a repo of this burrow exists and is switched on. */
export async function repoEnabled(db: Db, burrowId: string, repoId: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: repos.enabled })
    .from(repos)
    .where(and(eq(repos.id, repoId), eq(repos.burrowId, burrowId)));
  return row?.enabled === true;
}

/**
 * Whether `personId` is the Whombat's person: an integration works under the authority of whoever set it up, and only
 * the person has any (anyone else's rows are history).
 */
export async function personHere(db: Db, burrowId: string, personId: string): Promise<boolean> {
  return isThePerson(db, burrowId, personId);
}
