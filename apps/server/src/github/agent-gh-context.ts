/**
 * `DispatchContext.gh` (docs/decisions/agent-gh.md AGH-12): whether a turn's `gh` goes through Whombat, for which
 * repositories, and which one a command that names none uses.
 *
 * Managed mode only, GitHub mode `gh` (not `fake`, not `off`), the burrow connected (with or without switched-on GitHub
 * repositories yet, agent-repos.md AGR-02), and not a Feedback assessment, a search answer or a read-only automation
 * checkout. `repos` are the switched-on (at most `GH_REPOS_MAX`); `defaultRepo` is the turn's checkout repo when it is one of them,
 * else the only one, else null. Personal agents get it too: reads are free, their keys decide writes.
 *
 * Tests run the fake GitHub on a self-hosted server: `useAgentGhForTests` turns it on there, for one services
 * container, and only under `NODE_ENV=test` (AGH-DS notes).
 */
import { type DispatchContext, GH_REPOS_MAX, type GhDispatchContext } from '@whombat/core';
import { and, asc, eq, sql } from 'drizzle-orm';
import { type dispatches, repos } from '../db/schema/index';
import type { Services } from '../services';

const forTests = new WeakSet<Services>();

/** Test seam: `gh` through Whombat with the fake GitHub on this (test) server. Never in production. */
export function useAgentGhForTests(services: Services): void {
  if (services.config.NODE_ENV !== 'test') throw new Error('useAgentGhForTests is for tests only.');
  forTests.add(services);
}

/** Whether agents' `gh` can go through Whombat on this server at all (AGH-12: GitHub mode `gh`). */
export function agentGhOn(services: Services): boolean {
  if (forTests.has(services)) return services.github.fake !== null;
  return services.github.mode === 'gh';
}

/**
 * The burrow's switched-on GitHub repositories, the most recently pushed first (at most `GH_REPOS_MAX`): all the account
 * owns are there (agent-repos.md AGR-08), and the prompt names only the first few.
 */
export async function switchedOnGitHubRepos(services: Services, burrowId: string): Promise<string[]> {
  const rows = await services.db
    .select({ fullName: repos.fullName })
    .from(repos)
    .where(and(eq(repos.burrowId, burrowId), eq(repos.enabled, true), eq(repos.source, 'github')))
    .orderBy(sql`${repos.pushedAt} desc nulls last`, asc(repos.position), asc(repos.fullName))
    .limit(GH_REPOS_MAX);
  return rows.map((r) => r.fullName);
}

/** `DispatchContext.gh` for a turn, given its checkout (`DispatchContext.workspace`). Null: no gh through Whombat. */
export async function ghContextFor(
  services: Services,
  row: Pick<typeof dispatches.$inferSelect, 'burrowId' | 'trigger' | 'search'>,
  workspace: DispatchContext['workspace'],
): Promise<GhDispatchContext | null> {
  if (!agentGhOn(services)) return null;
  // Not a Feedback assessment, a search answer or a read-only automation checkout.
  if (row.trigger === 'feedback' || row.search || workspace?.access === 'read') return null;
  if (!(await services.github.isConnected(row.burrowId))) return null;
  // Connected is enough: a repository the connection reaches is added the first time an agent names it (agent-repos.md
  // AGR-01), so a burrow without any yet still has gh and git through Whombat.
  const list = await switchedOnGitHubRepos(services, row.burrowId);
  const checkout = workspace ? list.find((r) => r === workspace.repo) : undefined;
  return { repos: list, defaultRepo: checkout ?? (list.length === 1 ? (list[0] as string) : null) };
}
