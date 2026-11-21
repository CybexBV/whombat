/**
 * GitHub over HTTP (docs/github.md):
 * - `GET  /api/v1/burrows/:burrow/github`          — connected as whom (or the gh error and its fix);
 * - `POST /api/v1/burrows/:burrow/github/connect`  — connect with the person's own GitHub sign-in (the person);
 * - `GET  /api/v1/burrows/:burrow/github/repos`    — repos the gh account can reach (older apps' picker; the person);
 * - `POST /api/v1/burrows/:burrow/repos`           — add a repo by owner/name (older apps; the person);
 * - `POST /api/v1/burrows/:burrow/repos/sync`      — bring in the account's repos and re-read the burrow's (the person);
 * - `GET  /api/v1/burrows/:burrow/github/owners/:owner/avatar` — a GitHub owner's picture for the Automations list.
 */
import { api, type GitHubStatusResponse } from '@whombat/core';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { BurrowAccess } from '../auth/request';
import { watchedRepos } from '../automations/github-items';
import type { Db } from '../db/client';
import {
  automations,
  automationVersions,
  githubConnections,
  githubPollCursors,
  repos,
} from '../db/schema/index';
import { ApiError, conflict, forbidden, notFound } from '../lib/errors';
import { burrowGitHubOwner, GITHUB_SIGN_IN_FIRST, githubScope } from '../managed/providers/github-adapter';
import { providerLogins } from '../managed/providers/service';
import { repoRows, toRepo } from '../read/work-views';
import { commitAs } from '../routes/burrows';
import { type RouteDef, route } from '../routes/define';
import type { Services } from '../services';
import { type GhRepo, GitHubError, GitHubNotConnectedError } from './adapter';
import { addRepo, connectGitHub, refreshRepos } from './commands';
import { localRepoCreateInfo } from './local-repos';
import { syncOwnedRepos } from './owned-repos';

const isPerson = (access: BurrowAccess) => access.principal.kind === 'person';

/** When the burrow last polled GitHub. */
async function lastPolled(services: Services, burrowId: string): Promise<string | null> {
  const [polled] = await services.db
    .select({ at: githubPollCursors.polledAt })
    .from(githubPollCursors)
    .where(and(eq(githubPollCursors.burrowId, burrowId), isNotNull(githubPollCursors.polledAt)))
    .orderBy(desc(githubPollCursors.polledAt))
    .limit(1);
  return polled?.at?.toISOString() ?? null;
}

/** The caller's own GitHub sign-in on this box (managed, PV-06), or null. */
async function ownGitHubSignIn(services: Services, access: BurrowAccess) {
  const accountId = access.principal.accountId;
  return accountId ? providerLogins(services).record('github') : null;
}

/**
 * A managed box's GitHub status (docs/decisions/essentials-agents.md EA-10, contracts CT-181): no host `gh`, so the burrow
 * runs as the person's own GitHub sign-in (one-person.md OP-S09); without one they are told to sign in
 * (`signInNeeded`) and may connect once they have one (`canConnect`). Read from the connection and the sign-in, per
 * caller: never another burrow's cached answer.
 */
async function managedGitHubStatus(services: Services, access: BurrowAccess): Promise<GitHubStatusResponse> {
  const github = services.github;
  const person = isPerson(access);
  const burrowId = access.burrow.id;
  const connected = await github.isConnected(burrowId);
  const [row] = await services.db
    .select({ login: githubConnections.login })
    .from(githubConnections)
    .where(eq(githubConnections.burrowId, burrowId));
  const connector = row ? await burrowGitHubOwner(services, burrowId) : null;
  const mine = await ownGitHubSignIn(services, access);
  let error: string | null = null;
  let fix: string | null = null;
  let note: string | null = null;
  if (connector && !connector.present) {
    // Connected by someone who isn't on this Whombat any more (before one person per Whombat, OP-S08).
    error = `${connector.name} connected GitHub and isn’t on this Whombat any more. Connect it again with your own GitHub sign-in.`;
    fix = 'connect GitHub';
  } else if (connector) {
    if (!(mine ?? (await providerLogins(services).record('github')))) {
      error = 'Your GitHub sign-in is gone, so GitHub work has stopped. Sign in to GitHub again.';
      fix = 'sign in to GitHub';
    } else note = `GitHub runs as ${connector.name}’s own GitHub sign-in.`;
  }
  return {
    mode: github.mode,
    connected,
    login: row && (connected || person) ? row.login : null,
    error,
    fix,
    note,
    canConnect: person && mine !== null,
    polledAt: await lastPolled(services, burrowId),
    // The person would connect (or reconnect) it and has no GitHub sign-in yet.
    signInNeeded: person && mine === null && (!connected || error !== null),
  };
}

/** The burrow's GitHub status as its caller may see it. */
export async function githubStatus(services: Services, access: BurrowAccess): Promise<GitHubStatusResponse> {
  if (services.github.mode !== 'off') return managedGitHubStatus(services, access);
  return {
    mode: 'off',
    connected: false,
    login: null,
    error: null,
    fix: null,
    note: null,
    canConnect: false,
    polledAt: await lastPolled(services, access.burrow.id),
    signInNeeded: false,
  };
}

/** Connecting uses the person's own GitHub sign-in, once they have one (PV-06, EA-10). */
async function mayConnect(services: Services, access: BurrowAccess): Promise<void> {
  if (!isPerson(access)) throw forbidden('Only the person connects GitHub.');
  if (!(await ownGitHubSignIn(services, access)))
    throw new ApiError('conflict', GITHUB_SIGN_IN_FIRST, { details: { fix: 'sign in to GitHub' } });
}

/** A GitHub failure as a 409 the web can show (with the fix for a gh that is not logged in). */
function refused(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof GitHubNotConnectedError)
    return new ApiError('conflict', err.message, { details: { fix: err.fix } });
  return new ApiError('conflict', err instanceof Error ? err.message : String(err));
}

async function requireConnected(services: Services, burrowId: string): Promise<void> {
  services.github.require();
  if (!(await services.github.isConnected(burrowId))) throw conflict('Connect GitHub first.');
}

/**
 * Whether the burrow shows this GitHub owner's picture (automation-list.md AL-S05): the owner (any case) has one of the
 * burrow's GitHub repos, or a repo an automation of the burrow watches (live or draft, not deleted). Any other owner is
 * a 404, so the Whombat never fetches pictures for whoever asks.
 */
async function ownerShown(db: Db, burrowId: string, owner: string): Promise<boolean> {
  const login = owner.toLowerCase();
  const [repo] = await db
    .select({ id: repos.id })
    .from(repos)
    .where(
      and(
        eq(repos.burrowId, burrowId),
        // A repo created on the Whombat (`local/…`) is nobody's on GitHub (RP-05).
        eq(repos.source, 'github'),
        sql`lower(split_part(${repos.fullName}, '/', 1)) = ${login}`,
      ),
    )
    .limit(1);
  if (repo) return true;
  const rows = await db
    .select({ live: automationVersions.definition, draft: automations.draftJson })
    .from(automations)
    .leftJoin(
      automationVersions,
      and(
        eq(automationVersions.automationId, automations.id),
        eq(automationVersions.n, automations.currentVersion),
      ),
    )
    .where(and(eq(automations.burrowId, burrowId), isNull(automations.deletedAt)));
  const ownerOf = (full: string) =>
    full.indexOf('/') > 0 ? full.slice(0, full.indexOf('/')).toLowerCase() : null;
  return rows.some((r) =>
    [...watchedRepos(r.live), ...watchedRepos(r.draft)].some((full) => ownerOf(full) === login),
  );
}

const githubRouteList: RouteDef[] = [
  route(api.github.status, async ({ access, services }) => githubStatus(services, access)),

  route(api.github.connect, async (ctx) => {
    const { access, services } = ctx;
    const github = services.github;
    github.require();
    await mayConnect(services, access);
    const conn = await github.connection(true);
    if (!conn.ok) throw github.notConnected(conn);
    await commitAs(ctx, connectGitHub, {
      login: conn.account.login,
      githubUserId: conn.account.id,
      via: 'signin',
    });
    // Every repository the account owns comes in with the connection (agent-repos.md AGR-08); the poller tries again.
    await syncOwnedRepos(services, access.burrow.id, access.principal.id).catch((err) =>
      services.log.warn({ err: String(err) }, 'github: could not bring in the account’s repositories'),
    );
    return githubStatus(services, access);
  }),

  route(api.github.repos, async ({ access, query, services }) => {
    if (!isPerson(access)) throw forbidden('Only the person picks repos.');
    await requireConnected(services, access.burrow.id);
    let list: { repos: GhRepo[]; hasMore: boolean };
    try {
      list = await services.github.require().listRepos(query.limit);
    } catch (err) {
      throw refused(err);
    }
    const rows = await repoRows(services.db, access.burrow.id);
    return {
      repos: list.repos.map((r) => {
        const row = rows.find((e) => e.fullName.toLowerCase() === r.fullName.toLowerCase());
        return {
          fullName: r.fullName,
          description: (r.description ?? '').slice(0, 280),
          language: r.language?.slice(0, 40) ?? null,
          pushedAt: r.pushedAt,
          private: r.private,
          added: !!row,
          enabled: row?.enabled ?? false,
        };
      }),
      hasMore: list.hasMore,
    };
  }),

  route(api.github.avatar, async ({ access, params, services }) => {
    if (!(await ownerShown(services.db, access.burrow.id, params.owner))) throw notFound('GitHub owner');
    // Null when it couldn't be fetched (offline, none, too large): the client draws the GitHub mark (AL-S08).
    return { owner: params.owner, image: await services.github.avatars.image(params.owner) };
  }),

  route(api.repos.add, async (ctx) => {
    const { access, body, services } = ctx;
    if (!isPerson(access)) throw forbidden('Only the person adds repos.');
    await requireConnected(services, access.burrow.id);
    let repo: GhRepo;
    try {
      repo = await services.github.require().getRepo(body.fullName);
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) {
        const login = await services.github.connectionLogin();
        throw notFound(`${body.fullName} on GitHub${login ? ` (as @${login})` : ''}`);
      }
      throw refused(err);
    }
    // Every repository is on now (agent-repos.md AGR-11): an older app's “add switched off” adds it switched on.
    await commitAs(ctx, addRepo, { repo });
    // Read at once rather than on the next tick (docs/decisions/polling.md PL-01).
    services.github.poller.wake(access.burrow.id, repo.fullName);
    const [row] = await services.db
      .select()
      .from(repos)
      .where(and(eq(repos.burrowId, access.burrow.id), eq(repos.fullName, repo.fullName)));
    if (!row) throw notFound('Repository');
    return { repo: toRepo(row) };
  }),

  route(api.repos.sync, async (ctx) => {
    const { access, services } = ctx;
    if (!isPerson(access)) throw forbidden('Only the person syncs repos.');
    await requireConnected(services, access.burrow.id);
    const adapter = services.github.require();
    try {
      await syncOwnedRepos(services, access.burrow.id, access.principal.id);
    } catch (err) {
      throw refused(err);
    }
    const found: GhRepo[] = [];
    const missing: string[] = [];
    for (const row of await repoRows(services.db, access.burrow.id)) {
      // Repos created on the Whombat aren't on GitHub (repositories.md RP-05).
      if (row.source === 'local') continue;
      try {
        found.push(await adapter.getRepo(row.fullName));
      } catch (err) {
        if (err instanceof GitHubError && err.status === 404) missing.push(row.fullName);
        else throw refused(err);
      }
    }
    await commitAs(ctx, refreshRepos, { repos: found, missing });
    // Bring the burrow's PRs, checks and reviews up to date too.
    services.github.poller
      .pollNow({ burrowId: access.burrow.id })
      .catch((err) => services.log.warn({ err: String(err) }, 'github poll after sync failed'));
    const rows = await repoRows(services.db, access.burrow.id);
    return {
      repos: rows.map(toRepo),
      githubConnected: await services.github.isConnected(access.burrow.id),
      create: localRepoCreateInfo(access, ctx.auth),
    };
  }),
];

/**
 * Every GitHub route runs in a GitHub scope (managed mode, PV-06): connecting acts as the person's own GitHub sign-in,
 * everything else as whoever connected the burrow's GitHub. Self-hosted: no effect.
 */
export const githubRoutes: RouteDef[] = githubRouteList.map((def) => ({
  ...def,
  handler: (ctx: Parameters<RouteDef['handler']>[0]) =>
    githubScope.run(
      def.endpoint.id === 'github.connect'
        ? { accountId: ctx.auth?.account?.id ?? '' }
        : { burrowId: ctx.access?.burrow?.id ?? '' },
      () => def.handler(ctx),
    ),
})) as RouteDef[];
