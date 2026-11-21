/**
 * Who signs what GitHub did (docs/decisions/github.md, "GitHub-side actors"; docs/decisions/github-gh.md):
 *
 * - everything Whombat does on GitHub happens as the host's gh account, so GitHub cannot say which agent
 *   pushed: a push belongs to the agent whose runner got a push token for that branch to push exactly the
 *   commit the branch now points at (a live push grant with that sha), ON BEHALF OF whoever the agent was
 *   working for. Any other push is signed by GitHub: GitHub does not say who pushed, and a commit's author
 *   is free text anyone can write (a fork's PR too);
 * - a GitHub login linked to a principal (`github_identities`) is that principal (connecting links the gh
 *   login to the person who connected);
 * - commit emails (a person's email, or an agent's `<handle>@agents.<burrow>.whombat.com`) only say whose a
 *   commit is on the PR's commit list, never who signs;
 * - CI results (check runs) are reported by the burrow's CI agent — the first agent that may "Run CI"
 *   (the operator in the mock: Dusty posts "Checks failed on PR #482.");
 * - everything else is signed by the burrow's GitHub system principal, created on first use.
 */
import { decide, parseAgentCommitEmail } from '@whombat/core';
import { and, desc, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client';
import { burrows, githubIdentities, githubPushGrants, principals } from '../db/schema/index';
import { burrowSystemPrincipal } from '../domain/system-principals';
import { loadAgentRow, loadGrants, loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';

export interface GhActor {
  principalId: string;
  onBehalfOf?: { text?: string; principalId?: string };
  via: 'grant' | 'identity' | 'ci' | 'system';
}

/** `principals.system` of the GitHub mirror's own signer. */
export const SYSTEM_GITHUB = 'github';

export async function principalForLogin(db: Db, burrowId: string, login: string | null | undefined) {
  if (!login) return null;
  const [row] = await db
    .select({ principalId: githubIdentities.principalId })
    .from(githubIdentities)
    .where(and(eq(githubIdentities.burrowId, burrowId), eq(githubIdentities.login, login.toLowerCase())));
  return row?.principalId ?? null;
}

/** An agent's commit email in this burrow, or a person's email. */
export async function principalForEmail(db: Db, burrowId: string, email: string | null | undefined) {
  if (!email) return null;
  const agent = parseAgentCommitEmail(email);
  if (agent) {
    const [row] = await db
      .select({ id: principals.id })
      .from(principals)
      .innerJoin(burrows, eq(burrows.id, principals.burrowId))
      .where(
        and(
          eq(principals.burrowId, burrowId),
          eq(burrows.slug, agent.burrowSlug),
          eq(principals.kind, 'agent'),
          eq(principals.handle, agent.handle),
        ),
      );
    return row?.id ?? null;
  }
  const [person] = await db
    .select({ id: principals.id })
    .from(principals)
    .where(
      and(
        eq(principals.burrowId, burrowId),
        eq(principals.kind, 'person'),
        eq(principals.email, email.trim().toLowerCase()),
      ),
    );
  return person?.id ?? null;
}

/**
 * The live push grant for the commit a branch moved to: the agent Whombat pushed exactly that commit for.
 * Null when Whombat did not push it (someone else, or a runner that did not say what it pushed).
 */
export async function pushGrantForSha(
  db: Db,
  burrowId: string,
  repo: string,
  branch: string,
  sha: string,
  at: Date,
) {
  if (!sha) return null;
  const [grant] = await db
    .select()
    .from(githubPushGrants)
    .where(
      and(
        eq(githubPushGrants.burrowId, burrowId),
        eq(githubPushGrants.repo, repo),
        eq(githubPushGrants.branch, branch),
        eq(githubPushGrants.sha, sha.toLowerCase()),
        gt(githubPushGrants.expiresAt, at),
      ),
    )
    .orderBy(desc(githubPushGrants.issuedAt))
    .limit(1);
  return grant ?? null;
}

/** Who reports CI in a burrow (one-agent.md OA-07): the agent while it may “Run CI”, else nobody (GitHub signs). */
export async function ciReporter(db: Db, burrowId: string): Promise<string | null> {
  const agent = await loadAgentRow(db, burrowId);
  if (!agent) return null;
  const grants = await loadGrants(db, agent.id);
  return decide({ id: agent.id, kind: 'agent' }, grants, 'ci.run').outcome === 'allow' ? agent.id : null;
}

/**
 * The burrow's GitHub system principal: an agent-shaped principal named "GitHub" with no keys and no
 * channels that signs mirrored events nobody in the burrow can be matched to. It is not on the roster and
 * never gets dispatches.
 */
export const systemPrincipal = burrowSystemPrincipal({
  system: SYSTEM_GITHUB,
  name: 'GitHub',
  doing: 'Mirrors pull requests, pushes, checks and reviews from GitHub.',
  job: 'Mirrors GitHub into this Whombat: pull requests, pushes, checks and reviews.',
  line: { type: 'github.system_principal', where: 'GitHub' },
}).ensure;

/** A GitHub user → principal, else the system principal. */
export async function actorForLogin(
  services: Services,
  burrowId: string,
  login: string | null | undefined,
): Promise<GhActor> {
  const id = await principalForLogin(services.db, burrowId, login);
  return id ? { principalId: id, via: 'identity' } : systemActor(services, burrowId);
}

export async function systemActor(services: Services, burrowId: string): Promise<GhActor> {
  return { principalId: await systemPrincipal(services, burrowId), via: 'system' };
}

/**
 * Whether a principal may still sign a mirrored event: the pipeline refuses a former member (EP-02), so what they did on
 * GitHub before they went is signed by GitHub instead (EP-20).
 */
export async function canSign(db: Db, id: string): Promise<boolean> {
  const row = await loadPrincipalRow(db, id);
  return !!row;
}

/** True for system principals (they sign mirrored events; they are not members, not on the roster). */
export async function isSystemPrincipal(db: Db, id: string): Promise<boolean> {
  const [row] = await db.select({ system: principals.system }).from(principals).where(eq(principals.id, id));
  return !!row?.system;
}
