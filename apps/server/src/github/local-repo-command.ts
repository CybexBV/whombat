/**
 * The record of a repository created on the Whombat (docs/decisions/repositories.md RP-01…RP-08, contracts CT-192):
 * `repos.create`, apart from its route (`local-repos.ts`) so that commands elsewhere — a backup file's restore
 * (backup-file.md BF-D12) — can record one without the HTTP layer.
 */
import { LOCAL_REPO_OWNER, LocalRepoName, newId } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { repos } from '../db/schema/index';
import { ApiError, conflict } from '../lib/errors';

/** `local/<name>`: a local repo's full name. */
export const localFullName = (name: string) => `${LOCAL_REPO_OWNER}/${name}`;

/** The part after `owner/`, the folder a checkout of the repo gets. */
export const shortName = (fullName: string) => fullName.slice(fullName.indexOf('/') + 1);

export const nameTaken = (message: string) =>
  new ApiError('validation_failed', message, { fields: { name: [message] } });

export const createLocalRepo = defineCommand({
  name: 'repos.create',
  schema: z.object({
    name: LocalRepoName,
    description: z.string().max(280).default(''),
    originPath: z.string().min(1),
  }),
  requiredKey: (input) => ({
    keyId: 'burrow.manage',
    attempt: `create ${input.name}`,
    where: localFullName(input.name),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw conflict('Only people create repositories.');
    const fullName = localFullName(input.name);
    const rows = await tx.select().from(repos).where(eq(repos.burrowId, ctx.burrow.id));
    if (rows.some((r) => shortName(r.fullName).toLowerCase() === input.name.toLowerCase()))
      throw nameTaken(`This Whombat already has a repository called ${input.name}.`);
    const id = newId('repo');
    await tx.insert(repos).values({
      id,
      burrowId: ctx.burrow.id,
      fullName,
      description: input.description.slice(0, 280),
      language: null,
      defaultBranch: 'main',
      enabled: true,
      pushedAt: ctx.now,
      githubRepoId: null,
      position: rows.reduce((m, e) => Math.max(m, e.position), -1) + 1,
      source: 'local',
      originPath: input.originPath,
      createdAt: ctx.now,
    });
    await ctx.emit({
      type: 'repo.created',
      kind: 'System',
      text: `Created ${input.name} on this Whombat`,
      where: fullName,
      payload: { repoId: id, fullName, enabled: true },
    });
    return { repoId: id };
  },
});
