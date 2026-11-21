/**
 * Repositories created on the Whombat (docs/decisions/repositories.md RP-01…RP-08, contracts CT-192): Settings →
 * Connections → GitHub → New repository. The route makes the origin first (a shared bare repo under
 * `<WHOMBAT_WORKSPACES>/.origins/<burrow>/<name>.git`, `main` with a README committed as the caller), then records it
 * through the commit pipeline; when the record is refused the origin it just made goes again. Agents then check it out
 * and push to it like a GitHub repo (runtime/context.ts `cloneUrl`, runtime/routes.ts git credentials).
 *
 * Over a session the origin is an external effect ahead of the commit (docs/decisions/command-safety.md CS-01, CS-03):
 * once it exists a dropped session no longer rolls the record back. Only what nothing needs is removed: never an origin
 * a recorded repository or an open approval points to, and an origin left by a process that died before recording it
 * is made again by the next request for that name.
 */

import { execFile } from 'node:child_process';
import { devNull } from 'node:os';
import {
  createLocalOrigin,
  LocalOriginExistsError,
  localOriginPath,
  removeLocalOrigin,
} from '@whombat/agent-runtime/local-repos';
import { api, type RepoCreateInfo } from '@whombat/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { BurrowAccess, RequestAuth } from '../auth/request';
import { CommandStopped, externalEffect, undoneEffect } from '../commit/scope';
import { approvals, repos } from '../db/schema/index';
import { ApiError, conflict, forbidden, notFound } from '../lib/errors';
import { hostPaths } from '../lib/host-paths';
import { toRepo } from '../read/work-views';
import { commitAs } from '../routes/burrows';
import { OutcomeReply, type RouteDef, route } from '../routes/define';
import type { Services } from '../services';
import { createLocalRepo, nameTaken, shortName } from './local-repo-command';

export { createLocalRepo, localFullName, nameTaken, shortName } from './local-repo-command';

/**
 * Whether the caller may create a repository here, and the name and email its first commit is made with (RP-03):
 * the person (a box has no host people reach).
 */
export function localRepoCreateInfo(
  access: BurrowAccess,
  auth: Pick<RequestAuth, 'account'>,
): RepoCreateInfo {
  const principal = access.principal;
  const isPerson = principal.kind === 'person';
  const name = principal.name?.trim() || auth.account?.name?.trim() || '';
  const email = principal.email ?? auth.account?.email ?? null;
  const author = name && email ? { name, email } : null;
  let reason: string | null = null;
  if (!isPerson) reason = 'Only you can create repositories.';
  if (!reason && !author)
    reason = 'Your profile needs a name and an email first: the first commit is made with them.';
  return { allowed: reason === null, reason, author };
}

/** Another repo of the burrow a new one would be mistaken for: same folder name, whatever its owner. */
async function sameName(services: Services, burrowId: string, name: string) {
  const rows = await services.db.select().from(repos).where(eq(repos.burrowId, burrowId));
  return rows.find((r) => shortName(r.fullName).toLowerCase() === name.toLowerCase()) ?? null;
}

/**
 * Whether the bare repository at `path` is exactly what `createLocalOrigin` leaves: one ref, `refs/heads/main`, at a
 * single commit `Create <name>`. Anything else — pushed history, another branch or tag, a repository git can't read —
 * isn't.
 */
async function pristineOrigin(path: string, name: string): Promise<boolean> {
  const git = (args: string[]) =>
    new Promise<string>((resolve, reject) =>
      execFile(
        'git',
        ['-c', `safe.directory=${path}`, '-c', `core.hooksPath=${devNull}`, ...args],
        {
          env: {
            PATH: process.env.PATH ?? '',
            GIT_DIR: path,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: devNull,
            GIT_TERMINAL_PROMPT: '0',
          },
        },
        (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim())),
      ),
    );
  try {
    const refs = (await git(['for-each-ref', '--format=%(refname)'])).split('\n').filter(Boolean);
    if (refs.length !== 1 || refs[0] !== 'refs/heads/main') return false;
    if ((await git(['rev-list', '--count', 'refs/heads/main'])) !== '1') return false;
    return (await git(['log', '-1', '--format=%s', 'refs/heads/main'])) === `Create ${name}`;
  } catch {
    return false;
  }
}

/** Origins this process is making or recording right now (one server process per install, MR-06). */
const creating = new Set<string>();

/**
 * Whether anything needs the origin at `path` (CS-03): a repository recorded with it, or an approval still open for the
 * `repos.create` that would record it (it holds the path in its command). What nothing needs was left by a process that
 * died before recording it.
 */
async function originNeeded(services: Services, burrowId: string, path: string): Promise<boolean> {
  const [recorded] = await services.db
    .select({ id: repos.id })
    .from(repos)
    .where(eq(repos.originPath, path))
    .limit(1);
  if (recorded) return true;
  const [held] = await services.db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.burrowId, burrowId),
        inArray(approvals.state, ['pending', 'approved']),
        sql`${approvals.command}->>'name' = 'repos.create'`,
        sql`${approvals.command}->'input'->>'originPath' = ${path}`,
      ),
    )
    .limit(1);
  return held !== undefined;
}

/**
 * Makes the origin as an external effect of the request (CS-01). An origin already there that nothing needs is removed
 * and made again; one something needs refuses the name.
 */
async function makeOrigin(services: Services, o: Parameters<typeof createLocalOrigin>[0]): Promise<string> {
  const make = () =>
    // Its own failures leave nothing behind (the temporary repository goes), so they prove it didn't act.
    externalEffect('git.origin', async () => (await createLocalOrigin(o)).path, { refused: () => true });
  try {
    return await make();
  } catch (err) {
    if (!(err instanceof LocalOriginExistsError)) throw err;
    if (await originNeeded(services, o.burrowId, err.path)) throw err;
    // Only an origin exactly as a create leaves it (CS-03): one with history or other refs may be work that the
    // database no longer knows about (a restore from an older backup, repairs by hand), and is kept.
    if (!(await pristineOrigin(err.path, o.name))) throw err;
    services.log.warn({ name: o.name }, 'repos.create: made again an origin nothing recorded');
    await removeLocalOrigin(o.workspaces, o.burrowId, o.name);
    return make();
  }
}

/**
 * Records a repository whose origin the route just made: switched on, `main`, first in nothing (the end of the list).
 * Signed “Created Whombat_Website on this Whombat”.
 */
export const localRepoRoutes: RouteDef[] = [
  route(api.repos.create, async (ctx) => {
    const { access, services, body } = ctx;
    const info = localRepoCreateInfo(access, ctx.auth);
    if (!info.allowed || !info.author) throw forbidden(info.reason ?? 'Only you can create repositories.');
    const name = body.name;
    const taken = await sameName(services, access.burrow.id, name);
    if (taken)
      throw nameTaken(
        taken.source === 'local'
          ? `This Whombat already has a repository called ${name}.`
          : `${taken.fullName} is already on this Whombat; pick another name so agents can tell them apart.`,
      );
    const workspaces = hostPaths(services.config).workspaces;
    if (!workspaces) throw conflict('This Whombat has no place to keep repositories.');
    const target = localOriginPath(workspaces, access.burrow.id, name);
    if (creating.has(target))
      throw nameTaken(`A repository called ${name} is being created on this Whombat. Pick another name.`);
    creating.add(target);
    try {
      let originPath: string;
      try {
        originPath = await makeOrigin(services, {
          workspaces,
          burrowId: access.burrow.id,
          name,
          description: body.description,
          author: info.author,
          now: services.clock(),
        });
      } catch (err) {
        // Cancelled or past its deadline before the origin was made: nothing happened.
        if (err instanceof CommandStopped) throw err;
        if (err instanceof LocalOriginExistsError)
          throw nameTaken(`A repository called ${name} is already kept on this Whombat. Pick another name.`);
        services.log.warn({ err: String(err), name }, 'repos.create: could not make the origin');
        throw new ApiError('conflict', 'Whombat couldn’t create the repository on this machine. Try again.');
      }
      let repoId: string;
      try {
        ({ repoId } = await commitAs(ctx, createLocalRepo, {
          name,
          description: body.description ?? '',
          originPath,
        }));
      } catch (err) {
        // Asked a person: the approval's command holds the origin's path, so it stays (CS-03).
        if (err instanceof OutcomeReply && err.status === 202) throw err;
        // Not recorded (refused): nothing may be left behind on the disk — unless something records it after all.
        if (!(await originNeeded(services, access.burrow.id, originPath).catch(() => true))) {
          await removeLocalOrigin(workspaces, access.burrow.id, name)
            .then(() => undoneEffect('git.origin'))
            .catch(() => {});
        }
        throw err;
      }
      const [row] = await services.db.select().from(repos).where(eq(repos.id, repoId));
      if (!row) throw notFound('Repository');
      return { repo: toRepo(row) };
    } finally {
      creating.delete(target);
    }
  }),
];
