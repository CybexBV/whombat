/**
 * Connecting a burrow to GitHub through the host's gh, and refreshing its repos from GitHub
 * (docs/decisions/github-gh.md). People only; both need "Change burrow settings".
 */
import { newId, RepoFullName } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Tx } from '../db/client';
import { burrows, githubConnections, githubIdentities, repos } from '../db/schema/index';
import { conflict } from '../lib/errors';

export const RepoInput = z.object({
  id: z.number().int(),
  fullName: RepoFullName,
  description: z.string().nullable(),
  language: z.string().nullable(),
  defaultBranch: z.string(),
  pushedAt: z.string().nullable(),
  private: z.boolean(),
});

/**
 * "Connect GitHub": the burrow is connected as `login` (the gh account the route just checked). Records the
 * connection, links the login to the person who connected (their own actions on GitHub are signed as them),
 * and marks onboarding's GitHub step done. Signed "Connected GitHub as @login".
 */
export const connectGitHub = defineCommand({
  name: 'github.connect',
  schema: z.object({
    login: z.string().min(1).max(39),
    githubUserId: z.number().int().nullable(),
    /** How the burrow reaches GitHub: the host's gh, or (managed) the connecting person's own sign-in (EA-10). */
    via: z.enum(['gh', 'signin']).default('gh'),
  }),
  requiredKey: () => ({
    keyId: 'burrow.manage',
    attempt: 'connect GitHub',
    where: 'Settings · Connections · GitHub',
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw conflict('Only people connect GitHub.');
    // Connected already as this very sign-in (signing in connected it, RA-DS52, and the page connects too): nothing
    // changes, and nothing is signed twice.
    const [same] = await tx
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.burrowId, ctx.burrow.id))
      .for('update');
    if (same && same.connectedById === ctx.actor.id && same.login === input.login)
      return { login: input.login };
    const values = {
      login: input.login,
      githubUserId: input.githubUserId,
      connectedById: ctx.actor.id,
      connectedAt: ctx.now,
    };
    await tx
      .insert(githubConnections)
      .values({ burrowId: ctx.burrow.id, ...values })
      .onConflictDoUpdate({ target: githubConnections.burrowId, set: values });
    await tx
      .insert(githubIdentities)
      .values({
        burrowId: ctx.burrow.id,
        login: input.login.toLowerCase(),
        principalId: ctx.actor.id,
        githubUserId: input.githubUserId,
        createdAt: ctx.now,
      })
      .onConflictDoNothing();
    const onboarding = { ...ctx.burrow.onboarding, githubConnected: true };
    await tx.update(burrows).set({ onboarding }).where(eq(burrows.id, ctx.burrow.id));
    await ctx.emit({
      type: 'github.connected',
      kind: 'System',
      text: `Connected GitHub as @${input.login}`,
      where: 'Settings · Connections · GitHub',
      payload: { login: input.login, githubUserId: input.githubUserId, via: input.via },
    });
    return { login: input.login };
  },
});

/** Re-reads the burrow's repos from GitHub: description (when it had none), language, default branch, last push. */
export const refreshRepos = defineCommand({
  name: 'github.sync_repos',
  schema: z.object({ repos: z.array(RepoInput), missing: z.array(RepoFullName).default([]) }),
  requiredKey: () => ({
    keyId: 'burrow.manage',
    attempt: 're-read the repos from GitHub',
    where: 'Settings · Connections · GitHub',
  }),
  async apply(tx, ctx, input) {
    const rows = await tx.select().from(repos).where(eq(repos.burrowId, ctx.burrow.id));
    let updated = 0;
    for (const r of input.repos) {
      const row = rows.find((e) => e.fullName.toLowerCase() === r.fullName.toLowerCase());
      if (!row) continue;
      await tx
        .update(repos)
        .set({
          githubRepoId: r.id,
          language: r.language?.slice(0, 40) ?? null,
          defaultBranch: r.defaultBranch || 'main',
          pushedAt: r.pushedAt ? new Date(r.pushedAt) : row.pushedAt,
          ...(r.description && !row.description ? { description: r.description.slice(0, 280) } : {}),
        })
        .where(eq(repos.id, row.id));
      updated++;
    }
    await ctx.emit({
      type: 'github.repos_synced',
      kind: 'System',
      text: null,
      where: 'Settings · Connections · GitHub',
      payload: { updated, missing: input.missing },
    });
    return { updated };
  },
});

/**
 * "Add a repo" by owner/name (older apps' picker): the repo GitHub just returned joins the burrow, switched on. An
 * already added repo is switched on if it was off.
 */
export const addRepo = defineCommand({
  name: 'add_repo',
  schema: z.object({ repo: RepoInput }),
  requiredKey: (input) => ({
    keyId: 'burrow.manage',
    attempt: `add ${input.repo.fullName}`,
    where: input.repo.fullName,
  }),
  async apply(tx, ctx, input) {
    const r = input.repo;
    const rows = await tx.select().from(repos).where(eq(repos.burrowId, ctx.burrow.id));
    const row = rows.find((e) => e.fullName.toLowerCase() === r.fullName.toLowerCase());
    // A repo created on the Whombat by that name (repositories.md RP-01) is a different repository.
    if (row?.source === 'local')
      throw conflict(`${row.fullName} is a repository on this Whombat, not ${r.fullName} on GitHub.`);
    if (row) {
      if (!row.enabled) {
        await tx.update(repos).set({ enabled: true }).where(eq(repos.id, row.id));
        await ctx.emit({
          type: 'repo.enabled',
          kind: 'System',
          text: `Switched on ${row.fullName}`,
          where: row.fullName,
          payload: { repoId: row.id, enabled: true },
        });
      }
      return { repoId: row.id, added: false };
    }
    return { repoId: await insertGitHubRepo(tx, ctx, r, rows), added: true };
  },
});

/** A repo GitHub returned joins the burrow at `position`, switched on (no event: the caller says it); its id. */
export async function insertRepoRow(
  tx: Tx,
  burrowId: string,
  r: z.infer<typeof RepoInput>,
  position: number,
): Promise<string> {
  const id = newId('repo');
  await tx.insert(repos).values({
    id,
    burrowId,
    fullName: r.fullName,
    description: (r.description ?? '').slice(0, 280),
    language: r.language?.slice(0, 40) ?? null,
    defaultBranch: r.defaultBranch || 'main',
    enabled: true,
    pushedAt: r.pushedAt ? new Date(r.pushedAt) : null,
    githubRepoId: r.id,
    position,
  });
  return id;
}

/** A repo GitHub returned joins the burrow after its others (`rows`), signed `repo.added`; its id. */
export async function insertGitHubRepo(
  tx: Tx,
  ctx: ApplyContext,
  r: z.infer<typeof RepoInput>,
  rows: readonly { position: number }[],
  /** What the event says instead of “Added owner/name”. */
  text?: string,
): Promise<string> {
  const position = rows.reduce((m, e) => Math.max(m, e.position), -1) + 1;
  const id = await insertRepoRow(tx, ctx.burrow.id, r, position);
  await ctx.emit({
    type: 'repo.added',
    kind: 'System',
    text: text ?? `Added ${r.fullName}`,
    where: r.fullName,
    payload: { repoId: id, fullName: r.fullName, enabled: true },
  });
  return id;
}
