/**
 * GitHub repositories for agents by default (docs/decisions/agent-repos.md AGR-01…AGR-07): the account's own repositories
 * are all there once a person connected GitHub (`owned-repos.ts`), and an agent that names another one the connection
 * reaches — `gh -R`, a `git clone` of its URL, `start_run`, `open_pull_request` — has it added, signed by the agent, and
 * goes on (John, 2026-10-05: “It should simply connect to the repo, without any issues.”). Writes stay where they were:
 * pushes, pull requests, merges and gh writes go by the agent's keys.
 */
import { RepoFullName } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { repos } from '../db/schema/index';
import { forbidden } from '../lib/errors';
import { githubScope } from '../managed/providers/github-adapter';
import type { Services } from '../services';
import { type GhRepo, type GhRepoSpec, GitHubError } from './adapter';
import { insertGitHubRepo, RepoInput } from './commands';

/** How long the lookup on GitHub may take before the agent's command goes on without it (AGR-06). */
export const LOOKUP_MS = 10_000;
/** How long making a copy for a run may take, and how long its default branch is waited for after (AGR-07). */
export const COPY_MS = 30_000;
const COPY_WAIT_MS = 20_000;
const COPY_POLL_MS = 1_000;

/** An agent's repository the connection just found on GitHub joins the burrow (AGR-01); one it has already is left as it is. */
export const addRepoForAgent = defineCommand({
  name: 'github.add_repo_for_agent',
  schema: RepoInput.extend({
    /** The repository this one was made from for the agent's run (AGR-07). */
    copiedFrom: RepoFullName.optional(),
    /** The agent made it with `gh repo create` (agent-gh.md AGH-19): its visibility. */
    created: z.enum(['public', 'private', 'internal']).optional(),
  }),
  async apply(tx, ctx, { copiedFrom, created, ...r }) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only agents add a repository this way.');
    const rows = await tx.select().from(repos).where(eq(repos.burrowId, ctx.burrow.id));
    const row = rows.find((e) => e.fullName.toLowerCase() === r.fullName.toLowerCase());
    if (row) return { fullName: row.fullName, enabled: row.enabled && row.source === 'github' };
    const text = created
      ? `Created the ${created} repository ${r.fullName} on GitHub`
      : copiedFrom
        ? `Made ${r.fullName} from ${copiedFrom}`
        : undefined;
    await insertGitHubRepo(tx, ctx, r, rows, text);
    return { fullName: r.fullName, enabled: true };
  },
});

/** A GitHub call that may take at most `ms`; past that it fails like any other (AGR-06). */
async function within<T>(ms: number, call: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      call(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('GitHub didn’t answer in time')), ms);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const notFound = (err: unknown) => err instanceof GitHubError && err.status === 404;

/**
 * The repository `name` for `agentId`'s work (AGR-01, AGR-02): its canonical name when the burrow has it, or when the
 * burrow's GitHub connection reaches it on GitHub (then it is added, signed by the agent); null otherwise — not
 * connected, not on GitHub as the connection sees it, someone else's public repository, kept on this Whombat — and the
 * caller's own refusal says why.
 *
 * With `copy` (a run, which pushes its branch): someone else's public repository is the connection's own copy instead —
 * one already there by the same name, or one made now from the template or as a fork (AGR-07) — and that copy's name is
 * the answer.
 */
export async function ensureAgentRepo(
  services: Services,
  req: { burrowId: string; agentId: string; repo: string; copy?: boolean },
): Promise<string | null> {
  if (!RepoFullName.safeParse(req.repo).success || req.repo.toLowerCase().startsWith('local/')) return null;
  const want = req.repo.toLowerCase();
  const rows = await services.db
    .select({ fullName: repos.fullName, enabled: repos.enabled, source: repos.source })
    .from(repos)
    .where(eq(repos.burrowId, req.burrowId));
  const row = rows.find((r) => r.fullName.toLowerCase() === want);
  if (row) return row.enabled && row.source === 'github' ? row.fullName : null;
  const github = services.github;
  if (!github.adapter || !(await github.isConnected(req.burrowId))) return null;
  const adapter = github.adapter;
  // As the person who connected the burrow.
  const asConnection = <T>(ms: number, call: () => Promise<T>) =>
    within(ms, () => githubScope.run({ burrowId: req.burrowId }, call));
  const add = async (found: GhRepo, copiedFrom?: string) => {
    const res = await services.pipeline.commit(
      addRepoForAgent,
      { ...found, ...(copiedFrom ? { copiedFrom } : {}) },
      { burrowId: req.burrowId, actorId: req.agentId },
    );
    return res.status === 'ok' && res.result.enabled ? res.result.fullName : null;
  };
  try {
    // A sign-in that doesn't answer in time is a lookup that didn't find it (AGR-06).
    const found = await asConnection(LOOKUP_MS, () => adapter.getRepo(req.repo));
    // The person's own: one the connection can push to, or a private one it reads. Anyone's public repository isn't added
    // (and polled) for a look at it — git clones it without a sign-in anyway (AGR-04).
    if (found.canPush !== false || found.private) return await add(found);
    if (!req.copy) return null;
    return await copyFor(services, req, found, asConnection, add);
  } catch (err) {
    if (!notFound(err))
      services.log.warn({ err: String(err), repo: req.repo }, 'could not look up a repository for an agent');
    return null;
  }
}

/**
 * The connection's own copy of someone else's public repository, for a run (AGR-07): `<login>/<name>` when it is already
 * there and pushable (a copy made before), else made — from the template, private; else a fork — and its default branch
 * waited for a little, so the run's checkout finds it.
 */
async function copyFor(
  services: Services,
  req: { burrowId: string; agentId: string },
  source: GhRepo,
  asConnection: <T>(ms: number, call: () => Promise<T>) => Promise<T>,
  add: (found: GhRepo, copiedFrom?: string) => Promise<string | null>,
): Promise<string | null> {
  const adapter = services.github.require();
  const login = await services.github.connectionLoginFor(req.burrowId);
  if (!login) return null;
  const name = source.fullName.split('/')[1] as string;
  const target = `${login}/${name}`;
  const existing = await asConnection(LOOKUP_MS, () => adapter.getRepo(target)).catch((err) => {
    if (notFound(err)) return null;
    throw err;
  });
  if (existing) return existing.canPush === false ? null : add(existing, source.fullName);
  const made = await asConnection(COPY_MS, () =>
    adapter.copyRepo(source.fullName, { owner: login, name, template: source.template === true }),
  );
  services.log.info(
    { source: source.fullName, copy: made.fullName },
    'made a copy of a repository for an agent’s run',
  );
  const added = await add({ ...made, canPush: true }, source.fullName);
  // Once the copy is the burrow's, so it is looked at as its connection.
  if (added)
    await branchSettled(services, added, made.defaultBranch || source.defaultBranch || 'main', asConnection);
  return added;
}

/**
 * GitHub fills a new repository in the background: a run's checkout waits a little for its default branch (AGR-07,
 * AGH-19).
 */
async function branchSettled(
  services: Services,
  repo: string,
  branch: string,
  asConnection: <T>(ms: number, call: () => Promise<T>) => Promise<T>,
): Promise<void> {
  const adapter = services.github.require();
  for (let waited = 0; waited < COPY_WAIT_MS; waited += COPY_POLL_MS) {
    if (await asConnection(LOOKUP_MS, () => adapter.branchExists(repo, branch)).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, COPY_POLL_MS));
  }
}

/**
 * A new GitHub repository an agent asked for with `gh repo create` (agent-gh.md AGH-19), made as the burrow's GitHub
 * connection — in its own account (`owner` = the connection's login) or one of its organizations — and added for agents
 * straight away, signed by the agent (“Created the public repository … on GitHub”). The key was decided before. GitHub's refusal (a name already taken, an organization it can't create in) is thrown as it said.
 */
export async function createAgentRepo(
  services: Services,
  req: { burrowId: string; agentId: string; login: string; owner: string; spec: GhRepoSpec },
): Promise<string> {
  const adapter = services.github.require();
  const asConnection = <T>(ms: number, call: () => Promise<T>) =>
    within(ms, () => githubScope.run({ burrowId: req.burrowId }, call));
  const made = await asConnection(COPY_MS, () =>
    adapter.createRepo({
      ...req.spec,
      owner: req.owner,
      ownAccount: req.owner.toLowerCase() === req.login.toLowerCase(),
    }),
  );
  services.log.info(
    { repo: made.fullName, visibility: req.spec.visibility },
    'created a repository for an agent',
  );
  const res = await services.pipeline.commit(
    addRepoForAgent,
    { ...made, created: req.spec.visibility },
    { burrowId: req.burrowId, actorId: req.agentId },
  );
  const added = res.status === 'ok' && res.result.enabled ? res.result.fullName : made.fullName;
  // Only a repository with files has a branch to wait for: one from a template, or with a README.
  if (req.spec.template || req.spec.addReadme)
    await branchSettled(services, added, made.defaultBranch || 'main', asConnection);
  return added;
}
