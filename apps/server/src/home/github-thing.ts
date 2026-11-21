/**
 * GitHub as a connection on Home and in the sidebar's Connections (accounts.md): connected for this Whombat, it is a
 * thing like Google is, by its name, with the account and how many repositories are on. It opens GitHub's page on the
 * Connections tab. Read from the database only: no call to GitHub for a list that is read often.
 */
import { type ThingSummary, thingId } from '@whombat/core';
import { and, count, eq } from 'drizzle-orm';
import { githubConnections, repos } from '../db/schema/index';
import type { Services } from '../services';
import { mailThingHref } from './mail-glance';

/** The thing's id: one GitHub connection per Whombat. */
export const GITHUB_THING_ID = thingId('connection', 'github');

/** GitHub as a thing, or null while it isn't connected here. */
export async function githubThing(services: Services, burrowId: string): Promise<ThingSummary | null> {
  if (services.github.mode === 'off' || !(await services.github.isConnected(burrowId))) return null;
  const [[row], [on]] = await Promise.all([
    services.db
      .select({ login: githubConnections.login })
      .from(githubConnections)
      .where(eq(githubConnections.burrowId, burrowId)),
    services.db
      .select({ n: count() })
      .from(repos)
      .where(and(eq(repos.burrowId, burrowId), eq(repos.enabled, true))),
  ]);
  const n = on?.n ?? 0;
  const repositories = n === 1 ? '1 repository on' : `${n} repositories on`;
  return {
    id: GITHUB_THING_ID,
    kind: 'connection',
    catalogId: 'github',
    name: 'GitHub',
    icon: 'github',
    status: 'ok',
    line: (row?.login ? `@${row.login} · ${repositories}` : repositories).slice(0, 160),
    facts: [],
    href: mailThingHref('github'),
  };
}
