/**
 * Restoring repositories on this Whombat (BF-04): matched by name. A new one gets its bare origin from the bundle (every
 * ref, all its history) and is recorded through `repos.create`, under the same rule as creating one (the person). One
 * that is here keeps its refs, or with “Use the backup” takes the bundle's refs on top (nothing is deleted).
 */
import { execFile } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { localOriginPath } from '@whombat/agent-runtime/local-repos';
import type { BackupRepositoriesLine, BackupRepositoryRecord } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { repos } from '../../db/schema/index';
import { createLocalRepo } from '../../github/local-repo-command';
import { hostPaths } from '../../lib/host-paths';
import { gitEnv } from '../collect/repositories';
import type { RecordOutcome, RestoreRun } from './run';

const run_ = promisify(execFile);

export async function restoreRepositories(
  run: RestoreRun,
  record: BackupRepositoriesLine,
): Promise<RecordOutcome> {
  return repository(run, record);
}

async function refsOf(gitDir: string): Promise<string[]> {
  const out = await run_('git', ['for-each-ref', '--format=%(objectname) %(refname)'], {
    env: { ...gitEnv(), GIT_DIR: gitDir },
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.stdout.split('\n').filter(Boolean).sort();
}

async function bundleRefs(bundle: string): Promise<string[]> {
  const out = await run_('git', ['bundle', 'list-heads', bundle], {
    env: gitEnv(),
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.stdout
    .split('\n')
    .filter((l) => l && !l.endsWith(' HEAD'))
    .sort();
}

async function repository(run: RestoreRun, r: BackupRepositoryRecord): Promise<RecordOutcome> {
  const fullName = `local/${r.name}`;
  const [here] = await run.db
    .select()
    .from(repos)
    .where(and(eq(repos.burrowId, run.burrow.id), eq(repos.fullName, fullName)));
  if (here) {
    run.remember(r.id, here.id, 'repository');
    if (run.dry || !here.originPath) return 'unchanged';
    const bundle = run.bundlePath(r.name);
    if (!bundle) return 'unchanged';
    const [mine, theirs] = await Promise.all([refsOf(here.originPath), bundleRefs(bundle)]);
    if (mine.join('\n') === theirs.join('\n')) return 'unchanged';
    return run.different(async () => {
      await run_('git', ['fetch', '--quiet', '--update-head-ok', bundle, '+refs/*:refs/*'], {
        env: { ...gitEnv(), GIT_DIR: here.originPath as string },
        maxBuffer: 16 * 1024 * 1024,
      });
    });
  }
  if (run.restorer.kind !== 'person') return 'skipped';
  if (run.dry) return 'added';
  const bundle = run.bundlePath(r.name);
  if (!bundle) return 'skipped';
  const workspaces = hostPaths(run.services.config).workspaces as string;
  const origin = localOriginPath(workspaces, run.burrow.id, r.name);
  const temp = join(dirname(origin), `.restore-${r.name}-${Date.now()}.git`);
  await mkdir(dirname(origin), { recursive: true });
  try {
    const env = { ...gitEnv(), GIT_DIR: temp };
    await run_(
      'git',
      [
        'init',
        '--bare',
        '--quiet',
        '--shared=group',
        `--initial-branch=${r.defaultBranch}`,
        '--template=',
        temp,
      ],
      { env: gitEnv() },
    );
    await run_('git', ['fetch', '--quiet', bundle, '+refs/*:refs/*'], { env, maxBuffer: 16 * 1024 * 1024 });
    await rename(temp, origin);
  } catch (err) {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
    run.services.log.info(
      { err: String(err), repo: r.name },
      'backup restore: a repository was not brought back',
    );
    run.note('unreadable', 'repositories');
    return 'skipped';
  }
  try {
    const made = await run.tx.transaction(async () =>
      createLocalRepo.apply(run.tx, run.ctx, {
        name: r.name,
        description: r.description.slice(0, 280),
        originPath: origin,
      }),
    );
    const id = (made as { repoId: string }).repoId;
    await run.tx.update(repos).set({ defaultBranch: r.defaultBranch }).where(eq(repos.id, id));
    run.remember(r.id, id, 'repository');
    return 'added';
  } catch (err) {
    await rm(origin, { recursive: true, force: true }).catch(() => {});
    run.services.log.info(
      { err: String(err), repo: r.name },
      'backup restore: a repository was not recorded',
    );
    return 'skipped';
  }
}
