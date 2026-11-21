/**
 * A repository renamed or moved on GitHub is the same repository (GitHub's id stays, and GitHub sends the old name on to
 * the new one), so it is renamed on the Whombat too (docs/decisions/agent-repos.md AGR-14…AGR-17): the repository, what
 * the Whombat keeps about it by name (its poll cursor, branches, issues, deploys, rules, check-server work, a tracker's
 * fixes), the keys that name it, a connection's settings that list it, and then every automation that names it.
 * Messages, runs and the log are history and keep the name they were written with.
 */
import { RepoFullName, renameRepoInJson } from '@whombat/core';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { renameAutomationRepo } from '../automations/commands';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Tx } from '../db/client';
import {
  automations,
  automationVersions,
  catalogConnections,
  checkServerActions,
  checkServerAsks,
  deployments,
  githubBranchHeads,
  githubDeploys,
  githubIssues,
  githubPollCursors,
  githubPushGrants,
  githubSeen,
  grants,
  repoNightRuns,
  repoRules,
  repoSetups,
  repos,
  trackerFixes,
} from '../db/schema/index';
import type { Services } from '../services';
import { systemActor } from './actors';

type RepoRow = typeof repos.$inferSelect;

/** A column naming a repository, compared the way GitHub compares names (any case). */
const named = (col: AnyPgColumn, name: string) => sql`lower(${col}) = lower(${name})`;

/** Why a rename didn't happen; the repository keeps its name and its old one keeps working through GitHub's redirect. */
export type RenameSkipped = 'same' | 'local' | 'taken' | 'other_repository';

/**
 * Renames `row` to `to` in one transaction: the repository row and everything kept by its name in the burrow. Refused
 * when the burrow already has a repository by the new name (`taken`: two rows can't become one here), when GitHub's id
 * says it is another repository, or for a repository created on the Whombat.
 */
export async function renameRepoRows(
  tx: Tx,
  ctx: ApplyContext,
  row: RepoRow,
  to: string,
  githubId: number,
): Promise<{ from: string; to: string } | { skipped: RenameSkipped }> {
  const from = row.fullName;
  if (from.toLowerCase() === to.toLowerCase()) return { skipped: 'same' };
  if (row.source !== 'github') return { skipped: 'local' };
  if (row.githubRepoId !== null && row.githubRepoId !== githubId) return { skipped: 'other_repository' };
  const burrowId = ctx.burrow.id;
  const [taken] = await tx
    .select({ id: repos.id })
    .from(repos)
    .where(
      and(eq(repos.burrowId, burrowId), ne(repos.id, row.id), sql`lower(${repos.fullName}) = lower(${to})`),
    );
  if (taken) return { skipped: 'taken' };

  await tx.update(repos).set({ fullName: to, githubRepoId: githubId }).where(eq(repos.id, row.id));
  // What the poller saw under the new name before (nothing, unless a deploy was followed there) gives way to the
  // repository's own state, which moves over.
  await tx
    .delete(githubPollCursors)
    .where(and(eq(githubPollCursors.burrowId, burrowId), named(githubPollCursors.repo, to)));
  await tx
    .delete(githubBranchHeads)
    .where(and(eq(githubBranchHeads.burrowId, burrowId), named(githubBranchHeads.repo, to)));
  await tx.delete(githubSeen).where(and(eq(githubSeen.burrowId, burrowId), named(githubSeen.repo, to)));
  for (const table of [
    githubPollCursors,
    githubBranchHeads,
    githubSeen,
    githubIssues,
    githubPushGrants,
    githubDeploys,
    repoRules,
    repoSetups,
    repoNightRuns,
    deployments,
    checkServerActions,
    checkServerAsks,
    trackerFixes,
  ] as const)
    await tx
      .update(table)
      .set({ repo: to })
      .where(and(eq(table.burrowId, burrowId), named(table.repo, from)));

  // Keys limited to the repository name it by its new name (an automation's `pr.open` in it, say).
  const keyed = await tx
    .select()
    .from(grants)
    .where(and(eq(grants.burrowId, burrowId), sql`${grants.scope}->'repos' is not null`));
  for (const g of keyed) {
    const list = g.scope?.repos;
    if (!list?.some((r) => r.toLowerCase() === from.toLowerCase())) continue;
    await tx
      .update(grants)
      .set({
        scope: { ...g.scope, repos: list.map((r) => (r.toLowerCase() === from.toLowerCase() ? to : r)) },
      })
      .where(and(eq(grants.agentId, g.agentId), eq(grants.keyId, g.keyId)));
  }
  // A connection's settings that name it (GitHub Actions' list of repositories, say).
  const connections = await tx
    .select({ id: catalogConnections.id, fields: catalogConnections.fields })
    .from(catalogConnections)
    .where(eq(catalogConnections.burrowId, burrowId));
  for (const c of connections) {
    const fields = renameRepoInJson(c.fields, from, to);
    if (fields !== c.fields)
      await tx
        .update(catalogConnections)
        .set({ fields, updatedAt: ctx.now })
        .where(eq(catalogConnections.id, c.id));
  }

  await ctx.emit({
    type: 'repo.renamed',
    kind: 'System',
    text: `GitHub renamed ${from} to ${to}`,
    where: to,
    payload: { repoId: row.id, from, to, githubRepoId: githubId },
  });
  return { from, to };
}

/** The poller found a repository under a new name on GitHub (AGR-15): renamed here, signed by GitHub. */
export const renameGitHubRepo = defineCommand({
  name: 'github.repo_renamed',
  schema: z.object({ repoId: z.string(), fullName: RepoFullName, githubRepoId: z.number().int() }),
  async apply(tx, ctx, input) {
    const [row] = await tx
      .select()
      .from(repos)
      .where(and(eq(repos.burrowId, ctx.burrow.id), eq(repos.id, input.repoId)));
    if (!row) return { skipped: 'gone' as const };
    return renameRepoRows(tx, ctx, row, input.fullName, input.githubRepoId);
  },
});

/**
 * Every automation of the burrow whose current version or draft names `from` takes `to` (AGR-16), each committed as the
 * automation itself. Returns how many changed; one that can't is logged and keeps working through GitHub's redirect.
 */
export async function renameRepoInAutomations(
  services: Services,
  burrowId: string,
  from: string,
  to: string,
): Promise<number> {
  const rows = await services.db
    .select({ id: automations.id, principalId: automations.principalId })
    .from(automations)
    .leftJoin(
      automationVersions,
      and(
        eq(automationVersions.automationId, automations.id),
        eq(automationVersions.n, automations.currentVersion),
      ),
    )
    .where(
      and(
        eq(automations.burrowId, burrowId),
        sql`${automations.deletedAt} is null`,
        sql`(${automationVersions.definition}::text ilike ${`%${from}%`} or ${automations.draftJson}::text ilike ${`%${from}%`})`,
      ),
    );
  let changed = 0;
  for (const row of rows) {
    try {
      const res = await services.pipeline.commit(
        renameAutomationRepo,
        { automationId: row.id, from, to },
        { burrowId, actorId: row.principalId },
      );
      if (res.status === 'ok' && res.result.version !== null) changed++;
    } catch (err) {
      services.log.warn(
        { err: err instanceof Error ? err.message : String(err), automationId: row.id, from, to },
        'automations: an automation could not take a repository’s new name',
      );
    }
  }
  if (changed) services.automations.nudge();
  return changed;
}

/**
 * Follows a rename GitHub reported for the burrow's repository `repoId`: renames it and what names it, signed by GitHub,
 * then its automations. Returns the names, or why nothing was renamed.
 */
export async function followRepoRename(
  services: Services,
  p: { burrowId: string; repoId: string; fullName: string; githubRepoId: number },
): Promise<{ from: string; to: string } | { skipped: RenameSkipped | 'gone' }> {
  const actor = await systemActor(services, p.burrowId);
  const res = await services.pipeline.commit(
    renameGitHubRepo,
    { repoId: p.repoId, fullName: p.fullName, githubRepoId: p.githubRepoId },
    { burrowId: p.burrowId, actorId: actor.principalId },
  );
  if (res.status !== 'ok') throw new Error(`github.repo_renamed: ${res.status} (${res.message})`);
  const out = res.result;
  if ('skipped' in out) {
    if (out.skipped !== 'same')
      services.log.warn(
        { burrowId: p.burrowId, repoId: p.repoId, to: p.fullName, why: out.skipped },
        'github: a renamed repository kept its old name',
      );
    return out;
  }
  services.log.info(
    { burrowId: p.burrowId, from: out.from, to: out.to },
    'github: followed a repository’s new name',
  );
  await renameRepoInAutomations(services, p.burrowId, out.from, out.to);
  return out;
}
