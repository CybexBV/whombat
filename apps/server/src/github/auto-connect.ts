/**
 * Signing in to GitHub connects (resourceful-agents.md RA-DS52; the web's Repositories card does the same on its page,
 * app AP-543): when the person's own GitHub sign-in completes on a managed Whombat, every burrow of theirs that nobody
 * has connected yet is connected as that sign-in — whatever client they signed in from — so the agent reaches GitHub
 * without anyone pressing a second button (John: “Dusty should automatically have access to the repositories and
 * GitHub”), with every repository the account owns. A burrow connected already keeps its connection. Best effort: a
 * failure is logged and the sign-in stands.
 */
import { and, eq } from 'drizzle-orm';
import { principals } from '../db/schema/index';
import { githubScope } from '../managed/providers/github-adapter';
import type { Services } from '../services';
import { connectGitHub } from './commands';
import { syncOwnedRepos } from './owned-repos';

/** Connects the unconnected burrows of `accountId`'s person as its GitHub sign-in; the burrow ids it connected. */
export async function connectOwnBurrows(services: Services, accountId: string): Promise<string[]> {
  const github = services.github;
  if (!github.adapter || github.mode === 'off') return [];
  const theirs = await services.db
    .select({ id: principals.id, burrowId: principals.burrowId })
    .from(principals)
    .where(and(eq(principals.accountId, accountId), eq(principals.kind, 'person')));
  const connected: string[] = [];
  for (const person of theirs) {
    if (await github.isConnected(person.burrowId)) continue;
    try {
      // Who the sign-in is on GitHub, as the `github.connect` route asks it.
      const conn = await githubScope.run({ accountId }, () => github.connection(true));
      if (!conn.ok) {
        services.log.warn(
          { burrowId: person.burrowId, error: conn.error },
          'GitHub sign-in: could not connect',
        );
        continue;
      }
      const res = await services.pipeline.commit(
        connectGitHub,
        { login: conn.account.login, githubUserId: conn.account.id, via: 'signin' },
        { burrowId: person.burrowId, actorId: person.id },
      );
      if (res.status !== 'ok') continue;
      connected.push(person.burrowId);
      // The account's own repositories come in with it (agent-repos.md AGR-08); the poller tries again.
      await syncOwnedRepos(services, person.burrowId, person.id).catch((err) =>
        services.log.warn(
          { err: String(err), burrowId: person.burrowId },
          'GitHub sign-in: could not bring in the account’s repositories',
        ),
      );
    } catch (err) {
      services.log.warn({ err: String(err), burrowId: person.burrowId }, 'GitHub sign-in: could not connect');
    }
  }
  return connected;
}
