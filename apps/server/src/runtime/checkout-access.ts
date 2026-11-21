/**
 * Whether an agent can get a checkout of a repository on this Whombat (resourceful-agents.md RA-DS53), in the words a
 * person acts on when it can't: the repository isn't one agents may use here (not added, or switched off), or — on an
 * appliance — nobody's GitHub sign-in can fetch it (RA-DS50, RA-DS51: the same sentences the run turn's checkout gets).
 * `start_run` asks before it starts a run that could only fail, so the agent tells the person at once.
 *
 * Only what is known for sure refuses: a runner that doesn't answer a sign-in read is no reason to refuse.
 */
import { and, eq } from 'drizzle-orm';
import { repos } from '../db/schema/index';
import { ApiError } from '../lib/errors';
import { managedGitToken, NO_GITHUB_CONNECTION } from '../managed/providers/github';
import { loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';

/** The sign-in refusals that say for sure no checkout can be made (`managedGitToken`'s codes). */
const SIGN_IN_CODES = new Set([
  'provider.not_configured',
  'provider.owner_required',
  'provider.owner_departed',
  'provider.not_signed_in',
]);

/**
 * A repository agents can't see here: one the GitHub connection doesn't reach (one it reaches is added by now,
 * agent-repos.md AGR-01). GitHub to connect first on an appliance where nobody did; its repositories come with it (AGR-08).
 */
export function repoNotVisibleText(repo: string, githubConnected: boolean): string {
  return githubConnected
    ? `${repo} isn’t a repository this Whombat’s GitHub sign-in reaches. Check its name.`
    : `Nobody has connected GitHub on this Whombat yet. Connect it once in Settings → Connections → GitHub, and ${repo} comes with its account’s repositories.`;
}

/** Why `agentId` can't get a checkout of `repo` in its burrow, in a person's words; null when nothing is known against it. */
export async function checkoutBlocker(
  services: Services,
  input: { burrowId: string; agentId: string; repo: string },
): Promise<string | null> {
  const github = services.github;
  const [row] = await services.db
    .select()
    .from(repos)
    .where(and(eq(repos.burrowId, input.burrowId), eq(repos.fullName, input.repo)));
  if (!row?.enabled) {
    const connected =
      !github.adapter || input.repo.startsWith('local/') || (await github.isConnected(input.burrowId));
    return repoNotVisibleText(input.repo, connected);
  }
  const agent = await loadPrincipalRow(services.db, input.agentId);
  if (agent?.kind !== 'agent') return null;
  // Kept on this Whombat (RP-04): its origin is here, no GitHub involved.
  if (row.source === 'local') return null;
  // GitHub switched off on this Whombat says so itself.
  if (!github.adapter) return null;
  if (!(await github.connectedRepo(input.burrowId, row.fullName))) return NO_GITHUB_CONNECTION;
  try {
    await managedGitToken(services, input.agentId, input.burrowId);
    return null;
  } catch (err) {
    const code = err instanceof ApiError ? (err.extra.details as { code?: string } | undefined)?.code : null;
    if (err instanceof ApiError && code && SIGN_IN_CODES.has(code)) return err.message;
    // The runner didn't answer a sign-in read (or anything else): not known against it.
    services.log.warn({ err: String(err), repo: row.fullName }, 'could not check the run’s checkout ahead');
    return null;
  }
}

/** `start_run`'s refusal (RA-DS53): no run, why, and what to tell the person who asked. */
export function startRunRefusalText(repo: string, blocker: string): string {
  return `No run started: you can’t get a checkout of ${repo} here, so a run on it could only fail. ${blocker} Tell the person who asked exactly that, and start the run once they say it’s done.`;
}
