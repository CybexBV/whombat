import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import postgres from 'postgres';
import { loadConfig } from '../config';
import { createDb, type Database, type Sql } from '../db/client';
import { MIGRATIONS_FOLDER, runMigrations } from '../db/migrate';

export interface TestDb {
  name: string;
  url: string;
  sql: Sql;
  db: Database;
}

/**
 * Connections each test file's pool holds for its whole life (the server's own pool is 10). Three is enough for most
 * files; the few that run a runner, git hooks or the automations engine's session lock beside the server ask for
 * `BUSY_POOL_SIZE` (test-speed.md TS-01).
 */
export const TEST_POOL_SIZE = 3;
/** For a file whose server works on several connections at once: two engines' locks, a runner and a push hook. */
export const BUSY_POOL_SIZE = 5;

/**
 * How long a test file waits for free Postgres connections before giving up (below `hookTimeout`).
 * The dev Postgres is shared by every suite on the machine (`max_connections` 100): a file waits here
 * for its slots instead of failing a query mid-test with "too many clients". Several suites at once
 * queue behind each other, so this is generous.
 */
const ADMISSION_TIMEOUT_MS = 170_000;

/** SQLSTATEs that mean "no connection slot right now": too_many_connections, cannot_connect_now. */
const NO_SLOT = new Set(['53300', '57P03']);

function isNoSlot(err: unknown): boolean {
  return NO_SLOT.has((err as { code?: string } | undefined)?.code ?? '');
}

/** Retries `attempt` with jittered backoff while Postgres has no free connection slot, until `deadline`. */
async function whileNoSlot<T>(what: string, deadline: number, attempt: () => Promise<T>): Promise<T> {
  for (let delay = 50; ; delay = Math.min(delay * 2, 1000)) {
    try {
      return await attempt();
    } catch (err) {
      if (!isNoSlot(err) || Date.now() + delay > deadline) {
        throw new Error(`test db: ${what} failed`, { cause: err });
      }
      await sleep(delay / 2 + Math.random() * delay);
    }
  }
}

/** Runs one statement on a short-lived admin connection to the base database. */
async function adminQuery(baseUrl: string, statement: string, deadline = Date.now() + ADMISSION_TIMEOUT_MS) {
  await whileNoSlot(statement, deadline, async () => {
    const admin = postgres(baseUrl, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(statement);
    } finally {
      await admin.end({ timeout: 5 });
    }
  });
}

/**
 * A pool with every connection opened up front (all or none, so files waiting for slots cannot deadlock
 * each other). Afterwards the pool never connects again, so no query of the file can hit the limit.
 * One plain query per connection: with no connection open yet, postgres.js starts a connection for each.
 * (Not `sql.reserve()`: when a reserving connection fails to open, postgres.js 3.4 can hand the next
 * connection to the already-rejected reservation and leave the live one waiting forever.) A pool with
 * a failed connection is thrown away and the next attempt starts fresh.
 */
async function openPool(url: string, size: number, deadline: number) {
  return whileNoSlot('opening the pool', deadline, async () => {
    const pool = createDb(url, { max: size });
    const held = await Promise.allSettled(Array.from({ length: size }, () => pool.sql`select 1`));
    const failed = held.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) {
      await pool.sql.end({ timeout: 1 });
      throw failed.reason;
    }
    return pool;
  });
}

/* The template (docs/decisions/polling.md PL-03) ------------------------------------------------------------------- */

/** Migrated templates are `whombat_tpl_<hash>`; one being built is `whombat_tplb_<hash>_<random>` until it is renamed. */
const TEMPLATE_PREFIX = 'whombat_tpl_';
const BUILDING_PREFIX = 'whombat_tplb_';
/** Session advisory lock on the base database ("WHTP"): one template build at a time across every suite on the server. */
const TEMPLATE_LOCK = 0x57485450;
/** Templates of other migrations (other branches, older checkouts) are dropped once built longer ago than this. */
const STALE_TEMPLATE_MS = 60 * 60_000;

/**
 * What a migrated database is made of: the migrations (journal, SQL files, compatibility manifest) and the code that
 * applies them and records their bookkeeping. Equal hashes give equal databases, so the template is reused across runs.
 */
export function migrationsHash(folder: string = MIGRATIONS_FOLDER): string {
  const hash = createHash('sha256');
  const add = (label: string, path: string) => {
    hash.update(`${label}\u0000`);
    if (existsSync(path)) hash.update(readFileSync(path));
    hash.update('\u0000');
  };
  add('database resource', import.meta.filename);
  add('journal', join(folder, 'meta', '_journal.json'));
  add('compat', join(folder, 'compat.json'));
  for (const file of readdirSync(folder)
    .filter((f) => f.endsWith('.sql'))
    .sort())
    add(file, join(folder, file));
  for (const code of ['migrate.ts', 'compat.ts', 'backfills.ts'])
    add(code, join(import.meta.dirname, '..', 'db', code));
  return hash.digest('hex').slice(0, 16);
}

function databaseUrl(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Whether a database exists. */
async function databaseExists(admin: postgres.Sql, name: string): Promise<boolean> {
  const rows = await admin`select 1 from pg_database where datname = ${name}`;
  return rows.length > 0;
}

/** Templates of other migrations built more than an hour ago, and builds that never finished (we hold the lock). */
async function dropStaleTemplates(admin: postgres.Sql, keep: string): Promise<void> {
  const rows = await admin<{ name: string; note: string | null }[]>`
    select datname as name, shobj_description(oid, 'pg_database') as note from pg_database
    where datname like ${`${TEMPLATE_PREFIX}%`} or datname like ${`${BUILDING_PREFIX}%`}`;
  for (const { name, note } of rows) {
    if (name === keep) continue;
    const builtAt = Number(/^built (\d+)$/.exec(note ?? '')?.[1] ?? 0);
    if (name.startsWith(TEMPLATE_PREFIX) && Date.now() - builtAt < STALE_TEMPLATE_MS) continue;
    await admin.unsafe(`drop database if exists "${name}" with (force)`).catch(() => {});
  }
}

/**
 * The migrated template this checkout's test databases are copied from, built if it isn't there: once per migrations
 * hash, under an advisory lock so parallel files (and other suites on the shared server) never build it twice. It is
 * built under a temporary name and renamed when complete, so a crashed build is never used; nobody may connect to it
 * (`create database … template` needs it untouched).
 */
async function ensureTemplate(baseUrl: string, deadline: number): Promise<string> {
  const hash = migrationsHash();
  const name = `${TEMPLATE_PREFIX}${hash}`;
  return whileNoSlot('preparing the template database', deadline, async () => {
    const admin = postgres(baseUrl, { max: 1, onnotice: () => {} });
    try {
      if (await databaseExists(admin, name)) return name;
      for (;;) {
        const [lock] = await admin<{ ok: boolean }[]>`select pg_try_advisory_lock(${TEMPLATE_LOCK}) as ok`;
        if (lock?.ok) break;
        if (Date.now() > deadline) throw new Error('test db: another suite holds the template lock');
        await sleep(100);
      }
      try {
        if (await databaseExists(admin, name)) return name;
        await dropStaleTemplates(admin, name);
        const building = `${BUILDING_PREFIX}${hash}_${randomBytes(3).toString('hex')}`;
        await admin.unsafe(`create database "${building}"`);
        try {
          const { sql } = createDb(databaseUrl(baseUrl, building), { max: 1 });
          try {
            await runMigrations(sql);
          } finally {
            await sql.end({ timeout: 5 });
          }
          await admin.unsafe(`alter database "${building}" rename to "${name}"`);
        } catch (err) {
          await admin.unsafe(`drop database if exists "${building}" with (force)`).catch(() => {});
          throw err;
        }
        await admin.unsafe(`alter database "${name}" with allow_connections false`);
        await admin.unsafe(`comment on database "${name}" is 'built ${Date.now()}'`);
        return name;
      } finally {
        await admin`select pg_advisory_unlock(${TEMPLATE_LOCK})`.catch(() => {});
      }
    } finally {
      await admin.end({ timeout: 5 });
    }
  });
}

/** SQLSTATE of a template another run dropped meanwhile (invalid_catalog_name): built again. */
const NO_TEMPLATE = '3D000';

/**
 * Create a throwaway database `whombat_test_<random>` next to DATABASE_URL, migrated: a copy of the template database
 * of this checkout's migrations (PL-03; built once per migrations hash, reused across runs).
 */
export async function createTestDb(
  poolSize = TEST_POOL_SIZE,
): Promise<TestDb & { drop: () => Promise<void> }> {
  const baseUrl = loadConfig().DATABASE_URL;
  const name = `whombat_test_${randomBytes(6).toString('hex')}`;
  const deadline = Date.now() + ADMISSION_TIMEOUT_MS;
  for (let attempt = 0; ; attempt++) {
    const template = await ensureTemplate(baseUrl, deadline);
    try {
      await adminQuery(baseUrl, `create database "${name}" template "${template}"`, deadline);
      break;
    } catch (err) {
      const code = ((err as Error).cause as { code?: string } | undefined)?.code;
      if (code !== NO_TEMPLATE || attempt >= 2) throw err;
    }
  }

  const url = databaseUrl(baseUrl, name);
  const dropDb = () => adminQuery(baseUrl, `drop database if exists "${name}" with (force)`);
  let pool: ReturnType<typeof createDb>;
  try {
    pool = await openPool(url, poolSize, deadline);
  } catch (err) {
    await dropDb();
    throw err;
  }
  const { sql, db } = pool;
  const drop = async () => {
    await sql.end({ timeout: 5 });
    await dropDb();
  };
  return { name, url, sql, db, drop };
}
