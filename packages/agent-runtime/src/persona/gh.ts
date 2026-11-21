/**
 * gh through Whombat in a turn's preface (docs/decisions/agent-gh.md AGH-14, AGH-23; resourceful-agents.md RA-DS72): one
 * line naming the repositories the agent's gh reaches, that the agent's keys decide what changes, and that git's GitHub
 * fetches go through the same service while a push is Whombat's. Nothing for a turn without gh (`DispatchContext.gh` null
 * or absent — the runner clears it for a turn it can't give the stand-in, so the prompt never promises a gh the shell
 * lacks). What isn't there (gh's token, extensions, --web) the stand-in says itself. While code work goes to T3 Code
 * (`code.ts`), gh is for GitHub itself and the line says nothing of cloning or pushing.
 */
import type { DispatchContext } from '@whombat/core/contracts';
import { codeGoesToT3 } from './code';

/** At most this many repositories are named; the rest are counted (AGH-DR10). */
export const GH_LISTED_MAX = 20;

/** Whether the turn's gh goes through Whombat (AGH-12). */
export function ghThroughWhombat(context: Pick<DispatchContext, 'gh'>): boolean {
  return Boolean(context.gh);
}

/** The repositories by name (at most `GH_LISTED_MAX`), and any other the burrow's sign-in reaches (agent-repos.md AGR-01). */
function reposPhrase(repos: readonly string[]): string {
  const any = 'any repository this Whombat’s GitHub sign-in works on (-R owner/name)';
  if (!repos.length) return any;
  const more = repos.length - GH_LISTED_MAX;
  return `${repos.slice(0, GH_LISTED_MAX).join(', ')}${more > 0 ? ` and ${more} more` : ''}, or ${any}`;
}

export function ghLines(context: Pick<DispatchContext, 'gh' | 'connections'>): string[] {
  if (!context.gh) return [];
  if (codeGoesToT3(context))
    return [
      `gh works in your shell for ${reposPhrase(context.gh.repos)}, through Whombat as that sign-in, for GitHub itself only: making repositories, their descriptions and settings, issues and pull requests (reads freely, changes as your keys say). Code goes to T3 Code.`,
    ];
  return [
    `gh works in your shell for ${reposPhrase(context.gh.repos)}, through Whombat as that sign-in: reads freely, changes as your keys say; gh pr create, merge and review go the Whombat way. git clone, fetch and pull of their https://github.com/ URLs work too; Whombat pushes what you commit in a run’s checkout.`,
  ];
}
