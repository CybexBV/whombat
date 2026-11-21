/**
 * Pull requests on repositories kept on this Whombat (docs/decisions/runs-approvals.md MDS-D05; repositories.md RP-01…):
 * `open_pr` opens a Whombat pull request from the branch an agent pushed to the origin — its head, files, diff and
 * commits read from the origin — and `merge_pr` merges it inside the origin with the server's git, the way GitHub merges
 * a connected repo's: squash by default (or a merge commit), as whoever merges, refusing conflicts, and only from the
 * base it read (`mergeLocalBranch`). There is no GitHub and no poller behind it, so the PR's head is read again from the
 * origin when it is merged.
 *
 * The merge is an external effect of the command before its commit (command-safety.md CS-01): `git.merge`, refused
 * (nothing happened) when the origin didn't merge.
 */
import {
  type LocalChanges,
  LocalMergeRefused,
  localBranchHead,
  localChanges,
  mergeLocalBranch,
} from '@whombat/agent-runtime/local-repos';
import { agentCommitEmail } from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import { CommandStopped, externalEffect } from '../commit/scope';
import type { ApplyContext } from '../commit/types';
import type { Tx } from '../db/client';
import { accounts, prCommits, prFiles, principals, pullRequests, type repos } from '../db/schema/index';
import { conflict } from '../lib/errors';
import { principalForEmail } from './actors';

type RepoRow = typeof repos.$inferSelect;

/** A local repo's origin on this machine, or a refusal a person and an agent can read. */
function originOf(repo: RepoRow): string {
  if (repo.source !== 'local' || !repo.originPath)
    throw conflict(`${repo.fullName} has no copy on this Whombat.`);
  return repo.originPath;
}

/** What a branch of a local repo changes against its base, as its pull request shows it. */
export async function localBranchSnapshot(
  repo: RepoRow,
  base: string,
  branch: string,
): Promise<{ headSha: string; changes: LocalChanges }> {
  const origin = originOf(repo);
  const [headSha, baseSha] = await Promise.all([
    localBranchHead(origin, branch),
    localBranchHead(origin, base),
  ]);
  if (!baseSha) throw conflict(`${repo.fullName} has no branch ${base}.`);
  if (!headSha)
    throw conflict(
      `${branch} isn’t on this Whombat yet. Commit on it: Whombat pushes your commits when you open the pull request and when your turn ends.`,
    );
  return { headSha, changes: await localChanges(origin, baseSha, headSha) };
}

/** Records what the origin says a local pull request is now: its head, diff, files and commits. */
export async function writeLocalChanges(
  tx: Tx,
  burrowId: string,
  prId: string,
  snapshot: { headSha: string; changes: LocalChanges },
  now: Date,
): Promise<void> {
  const { changes } = snapshot;
  await tx
    .update(pullRequests)
    .set({ headSha: snapshot.headSha, diff: changes.diff, updatedAt: now })
    .where(eq(pullRequests.id, prId));
  await tx.delete(prFiles).where(eq(prFiles.prId, prId));
  if (changes.files.length)
    await tx
      .insert(prFiles)
      .values(changes.files.slice(0, 500).map((f, position) => ({ prId, ...f, position })));
  const [{ max } = { max: -1 }] = await tx
    .select({ max: sql<number>`coalesce(max(${prCommits.position}), -1)::int` })
    .from(prCommits)
    .where(eq(prCommits.prId, prId));
  const commits = [];
  for (const [i, c] of changes.commits.entries())
    commits.push({
      prId,
      sha: c.sha,
      message: c.message.slice(0, 500) || 'Commit',
      authorId: await principalForEmail(tx, burrowId, c.authorEmail),
      at: new Date(c.at),
      position: max + 1 + i,
    });
  if (commits.length) await tx.insert(prCommits).values(commits).onConflictDoNothing();
}

/** Who a merge commit is by: a person's name and email, an agent's name and commit email. */
async function mergeAuthor(ctx: ApplyContext): Promise<{ name: string; email: string }> {
  const actor = ctx.actor;
  if (actor.kind === 'agent')
    return { name: actor.name, email: agentCommitEmail(actor.handle, ctx.burrow.slug) };
  const [row] = await ctx.tx
    .select({ email: principals.email, accountEmail: accounts.email })
    .from(principals)
    .leftJoin(accounts, eq(accounts.id, principals.accountId))
    .where(and(eq(principals.id, actor.id)));
  const email = row?.email ?? row?.accountEmail ?? `${actor.handle}@people.${ctx.burrow.slug}.invalid`;
  return { name: actor.name, email };
}

/**
 * Merges a local repo's pull request inside its origin, as the actor (“Merged by Mara Okafor in Whombat.”). The PR's
 * head is read again first (nothing reports pushes to an origin) and recorded with what it changes. A refusal — a
 * conflict, nothing to merge, the base moved — is a 409 and the command rolls back; the origin is unchanged.
 */
export async function mergeOnOrigin(
  ctx: ApplyContext,
  p: {
    repo: RepoRow;
    pr: { id: string; number: number; title: string; branch: string; baseBranch: string };
    method: 'merge' | 'squash' | 'rebase';
  },
): Promise<{ sha: string; headSha: string }> {
  if (p.method === 'rebase')
    throw conflict(
      `${p.repo.fullName} is kept on this Whombat, where pull requests merge with a squash or a merge commit, not a rebase.`,
    );
  const origin = originOf(p.repo);
  const snapshot = await localBranchSnapshot(p.repo, p.pr.baseBranch, p.pr.branch);
  await writeLocalChanges(ctx.tx, ctx.burrow.id, p.pr.id, snapshot, ctx.now);
  const author = await mergeAuthor(ctx);
  try {
    const merged = await externalEffect(
      'git.merge',
      () =>
        mergeLocalBranch(origin, {
          base: p.pr.baseBranch,
          branch: p.pr.branch,
          method: p.method === 'merge' ? 'merge' : 'squash',
          title: `${p.pr.title} (#${p.pr.number})`,
          message: `Merged by ${ctx.actor.name} in Whombat.`,
          author,
          now: ctx.now,
        }),
      { refused: (err) => err instanceof LocalMergeRefused },
    );
    return { sha: merged.sha, headSha: merged.headSha };
  } catch (err) {
    if (err instanceof CommandStopped) throw err;
    if (err instanceof LocalMergeRefused)
      throw conflict(`Whombat didn’t merge PR #${p.pr.number}: ${err.message}`);
    throw err;
  }
}
