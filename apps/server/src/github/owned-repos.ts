/**
 * Every repository the GitHub account owns is the agent's (docs/decisions/agent-repos.md AGR-08…AGR-13): nobody picks
 * them one by one. Connecting GitHub brings them all in, and so do “Sync repos” and the poller every
 * `OWNED_SYNC_MS`, so one made on GitHub later joins by itself. Archived ones stay out (nothing can be pushed there).
 * A repository the account no longer owns is left as it is: its pull requests and rooms are history.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { repos } from '../db/schema/index';
import { githubScope } from '../managed/providers/github-adapter';
import type { Services } from '../services';
import type { GhRepo } from './adapter';
import { insertRepoRow, RepoInput } from './commands';
import { renameRepoInAutomations, renameRepoRows } from './rename';

/** At most this many of the account's repositories come in, the most recently pushed first (AGR-10). */
export const OWNED_REPOS_MAX = 300;
/** How often the poller reads the account's repositories again (AGR-09). */
export const OWNED_SYNC_MS = 10 * 60_000;

/**
 * The account's repositories as GitHub just listed them join the burrow (one signed event for all of them), switched
 * on; ones it has already are switched on and get GitHub's language, default branch and last push.
 */
export const bringInOwnedRepos = defineCommand({
  name: 'github.owned_repos',
  schema: z.object({ repos: z.array(RepoInput).max(OWNED_REPOS_MAX) }),
  async apply(tx, ctx, input) {
    const rows = await tx.select().from(repos).where(eq(repos.burrowId, ctx.burrow.id));
    const byName = new Map(rows.map((r) => [r.fullName.toLowerCase(), r]));
    const byGitHubId = new Map(
      rows.filter((r) => r.source === 'github' && r.githubRepoId !== null).map((r) => [r.githubRepoId, r]),
    );
    let position = rows.reduce((m, r) => Math.max(m, r.position), -1);
    const added: string[] = [];
    const renamed: { from: string; to: string }[] = [];
    let updated = 0;
    // Oldest push first, so the newest repository ends up last in the list, as it would have been added.
    for (const r of [...input.repos].reverse()) {
      // One the burrow has under its old name was renamed on GitHub: it takes the new name (AGR-14), not a second row.
      const moved = byName.has(r.fullName.toLowerCase()) ? undefined : byGitHubId.get(r.id);
      if (moved) {
        const res = await renameRepoRows(tx, ctx, moved, r.fullName, r.id);
        if ('from' in res) {
          renamed.push(res);
          byName.set(r.fullName.toLowerCase(), { ...moved, fullName: r.fullName });
        }
      }
      const row = byName.get(r.fullName.toLowerCase());
      if (row) {
        // A repository created on the Whombat by that name (RP-01) is a different one.
        if (row.source !== 'github') continue;
        const pushedAt = r.pushedAt ? new Date(r.pushedAt) : row.pushedAt;
        const language = r.language?.slice(0, 40) ?? null;
        const defaultBranch = r.defaultBranch || 'main';
        if (
          row.enabled &&
          row.githubRepoId === r.id &&
          row.language === language &&
          row.defaultBranch === defaultBranch &&
          row.pushedAt?.getTime() === pushedAt?.getTime()
        )
          continue;
        await tx
          .update(repos)
          .set({ enabled: true, githubRepoId: r.id, language, defaultBranch, pushedAt })
          .where(eq(repos.id, row.id));
        updated++;
        continue;
      }
      position++;
      await insertRepoRow(tx, ctx.burrow.id, r, position);
      added.push(r.fullName);
    }
    if (added.length)
      await ctx.emit({
        type: 'github.repos_synced',
        kind: 'System',
        text:
          added.length === 1
            ? `Added ${added[0]} from GitHub`
            : `Added ${added.length} repositories from GitHub`,
        where: 'Settings · Connections · GitHub',
        payload: { added: added.slice(0, 100), count: added.length },
      });
    return { added, updated, renamed };
  },
});

/** What the account owns on GitHub, for `bringInOwnedRepos`: not archived, at most `OWNED_REPOS_MAX`. */
function ownedInput(list: readonly GhRepo[]) {
  return list
    .filter((r) => r.archived !== true)
    .map((r) => ({
      id: r.id,
      fullName: r.fullName,
      description: r.description,
      language: r.language,
      defaultBranch: r.defaultBranch,
      pushedAt: r.pushedAt,
      private: r.private,
    }));
}

/**
 * Lists the repositories the burrow's GitHub account owns, as that connection, and brings them in signed by `actorId`
 * (the person who connected or pressed Sync, else GitHub itself). Returns the ones that joined; GitHub's errors are
 * thrown.
 */
export async function syncOwnedRepos(
  services: Services,
  burrowId: string,
  actorId: string,
): Promise<{ added: string[]; updated: number; renamed: { from: string; to: string }[] }> {
  const adapter = services.github.require();
  const list = await githubScope.run({ burrowId }, () => adapter.listRepos(OWNED_REPOS_MAX, { owned: true }));
  const res = await services.pipeline.commit(
    bringInOwnedRepos,
    { repos: ownedInput(list.repos) },
    { burrowId, actorId },
  );
  if (res.status !== 'ok') throw new Error(`github.owned_repos: ${res.status} (${res.message})`);
  for (const r of res.result.renamed) await renameRepoInAutomations(services, burrowId, r.from, r.to);
  // A repository not read yet is due in the next tick anyway: the wake only brings the tick closer.
  const [first] = res.result.added;
  if (first) services.github.poller.wake(burrowId, first);
  return res.result;
}
