/**
 * Repositories on this Whombat (`repositories.jsonl`, BF-05): each bare origin as a git bundle of all its refs
 * (`git bundle create --all`), made in the job's scratch directory and written as `repositories/<name>.bundle`.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type BackupRepositoriesLine, BackupRepositoryName } from '@whombat/core';
import { and, asc, eq } from 'drizzle-orm';
import { repos } from '../../db/schema/index';
import { iso } from '../../lib/time';
import type { CategoryOut, CollectOut, CollectScope } from './scope';

const run = promisify(execFile);
const rec = (v: BackupRepositoriesLine) =>
  v as BackupRepositoriesLine & { type: string } & Record<string, unknown>;

/** Git without the host's or the user's configuration (a bundle is made the same everywhere). */
export function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** The short name of a local repository (`local/<name>` → `<name>`). */
export function localName(fullName: string): string {
  const i = fullName.indexOf('/');
  return i === -1 ? fullName : fullName.slice(i + 1);
}

export async function collectRepositories(
  scope: CollectScope,
  out: CategoryOut,
  all: CollectOut,
): Promise<void> {
  const { db, burrow, services } = scope;
  const rows = await db
    .select()
    .from(repos)
    .where(and(eq(repos.burrowId, burrow.id), eq(repos.source, 'local')))
    .orderBy(asc(repos.position), asc(repos.fullName));
  for (const r of rows) {
    const name = localName(r.fullName);
    if (!r.originPath || !BackupRepositoryName.safeParse(name).success) continue;
    const env = { ...gitEnv(), GIT_DIR: r.originPath };
    let refs = 0;
    try {
      const listed = await run('git', ['for-each-ref', '--format=%(refname)'], {
        env,
        maxBuffer: 16 * 1024 * 1024,
      });
      refs = listed.stdout.split('\n').filter(Boolean).length;
    } catch (err) {
      services.log.warn(
        { err: String(err), repo: r.fullName },
        'backup file: a repository could not be read',
      );
      continue;
    }
    // An empty repository has nothing to bundle (git refuses an empty bundle): it is left out.
    if (refs === 0) continue;
    const path = join(scope.scratch, `repo-${r.id}.bundle`);
    try {
      await run('git', ['bundle', 'create', '--quiet', path, '--all'], { env, maxBuffer: 16 * 1024 * 1024 });
    } catch (err) {
      services.log.warn(
        { err: String(err), repo: r.fullName },
        'backup file: a repository could not be bundled',
      );
      continue;
    }
    const size = (await stat(path)).size;
    const sha256 = await sha256File(path);
    all.bundles.set(name, { size, path });
    out.bytes += size;
    out.ref(r.id);
    await out.record(
      rec({
        type: 'repository',
        id: r.id,
        name,
        fullName: r.fullName,
        defaultBranch: r.defaultBranch || 'main',
        description: (r.description ?? '').slice(0, 1000),
        bundle: { sha256, size },
        refs,
        createdAt: r.createdAt ? iso(r.createdAt) : null,
      }),
    );
  }
}
