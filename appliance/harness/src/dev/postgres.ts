/**
 * The harness's own Postgres container (`whombat-mgd-pg`, 127.0.0.1:55490, MA-14). The harness only ever starts,
 * stops or removes containers named `whombat-mgd-*`; shared containers are never touched.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PG_CONTAINER, PG_IMAGE, PG_PASSWORD, PG_USER, PG_VOLUME, ports, STATE_HOME } from '../lib/paths.ts';
import { must, run, sleep, waitFor } from '../lib/proc.ts';

/**
 * A host that leases its temporary containers names the command that starts one in `WB_MGD_PG_RUN` (for example
 * `agent-resource docker-run --memory 4g`). It is called instead of `docker run` with `--publish`, `--env`, the image
 * and Postgres's arguments, and prints the container's id or name on its last line. Whoever leased the container owns
 * its name and its volume, so the harness keeps the name it was given in `<WB_MGD_HOME>/pg-container`, stops the
 * container on `dev/down`, and on `--purge` removes the container and forgets it (the lease removes the volume).
 */
const PG_RUN = (process.env.WB_MGD_PG_RUN ?? '').trim();
const LEASED_FILE = join(STATE_HOME, 'pg-container');

function leased(): string | null {
  return existsSync(LEASED_FILE) ? readFileSync(LEASED_FILE, 'utf8').trim() || null : null;
}

/** The environment's Postgres container: the one a lease command started for it, else `WB_MGD_PG_CONTAINER`. */
export function pgContainer(): string {
  return leased() ?? PG_CONTAINER;
}

function guard(name: string): void {
  if (!name.startsWith('whombat-mgd-'))
    throw new Error(`refusing to manage container ${name} (not whombat-mgd-*)`);
}

export async function containerState(name = pgContainer()): Promise<'running' | 'exited' | 'missing'> {
  const r = await run('docker', ['inspect', '-f', '{{.State.Status}}', name], { cwd: '/' });
  if (r.code !== 0) return 'missing';
  return r.stdout.trim() === 'running' ? 'running' : 'exited';
}

export async function ensurePostgres(log: (l: string) => void): Promise<void> {
  guard(PG_CONTAINER);
  const state = await containerState();
  const settings = ['-c', 'max_connections=400', '-c', 'fsync=off', '-c', 'synchronous_commit=off'];
  if (state === 'missing' && PG_RUN) {
    const [cmd = '', ...first] = PG_RUN.split(/\s+/);
    log(`postgres: starting a leased container on 127.0.0.1:${ports.postgres} (${PG_RUN})`);
    const r = await must(
      cmd,
      [
        ...first,
        '--publish',
        `127.0.0.1:${ports.postgres}:5432`,
        '--env',
        `POSTGRES_USER=${PG_USER}`,
        '--env',
        `POSTGRES_PASSWORD=${PG_PASSWORD}`,
        '--env',
        'POSTGRES_DB=whombat',
        PG_IMAGE,
        ...settings,
      ],
      { cwd: '/' },
    );
    const name = r.stdout.trim().split('\n').at(-1)?.trim() ?? '';
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(name))
      throw new Error(`postgres: ${PG_RUN} printed no container name (${r.stdout.trim().slice(-200)})`);
    mkdirSync(STATE_HOME, { recursive: true });
    writeFileSync(LEASED_FILE, `${name}\n`);
  } else if (state === 'missing') {
    log(`postgres: creating container ${PG_CONTAINER} on 127.0.0.1:${ports.postgres}`);
    await must(
      'docker',
      [
        'run',
        '-d',
        '--name',
        PG_CONTAINER,
        '--label',
        'whombat-mgd=1',
        '-p',
        `127.0.0.1:${ports.postgres}:5432`,
        '-e',
        `POSTGRES_USER=${PG_USER}`,
        '-e',
        `POSTGRES_PASSWORD=${PG_PASSWORD}`,
        '-e',
        'POSTGRES_DB=whombat',
        '-v',
        `${PG_VOLUME}:/var/lib/postgresql/data`,
        PG_IMAGE,
        ...settings,
      ],
      { cwd: '/' },
    );
  } else if (state === 'exited') {
    log(`postgres: starting ${pgContainer()}`);
    await must('docker', ['start', pgContainer()], { cwd: '/' });
  }
  await waitFor(
    'postgres',
    async () =>
      (
        await run('docker', ['exec', pgContainer(), 'pg_isready', '-U', PG_USER, '-d', 'whombat'], {
          cwd: '/',
        })
      ).code === 0,
    { timeoutMs: 60_000, hint: `docker logs ${pgContainer()}` },
  );
  // pg_isready answers during the init restart; give it one more successful probe.
  await sleep(500);
  await waitFor('postgres (query)', async () => (await psql('select 1', 'whombat')).code === 0, {
    timeoutMs: 30_000,
  });
}

export function psql(sql: string, db = 'whombat') {
  return run(
    'docker',
    ['exec', '-i', pgContainer(), 'psql', '-v', 'ON_ERROR_STOP=1', '-U', PG_USER, '-d', db, '-tAc', sql],
    {
      cwd: '/',
    },
  );
}

export async function ensureDatabase(name: string): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`bad database name ${name}`);
  const r = await psql(`select 1 from pg_database where datname = '${name}'`);
  if (r.stdout.trim() !== '1')
    await must('docker', ['exec', pgContainer(), 'createdb', '-U', PG_USER, name], { cwd: '/' });
}

export async function dropDatabase(name: string): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`bad database name ${name}`);
  await psql(`drop database if exists ${name} with (force)`);
}

export async function stopPostgres(remove: boolean): Promise<void> {
  guard(PG_CONTAINER);
  const name = pgContainer();
  const mine = leased() === null;
  if ((await containerState()) !== 'missing') {
    await run('docker', ['stop', name], { cwd: '/' });
    if (remove) {
      await run('docker', ['rm', name], { cwd: '/' });
      // A leased container's volume is its lease's to remove.
      if (mine) await run('docker', ['volume', 'rm', PG_VOLUME], { cwd: '/' });
    }
  }
  if (remove) rmSync(LEASED_FILE, { force: true });
}
