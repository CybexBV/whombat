/**
 * Database migrations (docs/decisions/bp-distribution.md BP-F05, BP-11; docs/decisions/managed-db.md MD-01…).
 * The files are drizzle-kit's (`migrations/<tag>.sql` + `meta/_journal.json`) and the bookkeeping is drizzle's
 * own table (`drizzle.__drizzle_migrations`: sha256 of the file, the journal's `when`), so databases migrated by
 * drizzle's migrator and by this one are interchangeable. The journal starts at `0000_baseline` (one-agent.md OA-20):
 * a database whose history began before it is refused like any other history, with its own reason (OA-S83).
 *
 * Two roles, kept apart (MD-02):
 *
 * - **Startup validation** (`checkSchema`): read-only. Reads the database's history and the compatibility the
 *   migration authority recorded, and says what this binary may do: read and write, only read, or nothing
 *   (with the reason and the way forward). It never creates or changes anything.
 * - **The migration authority** (`runMigrations`): the only code that changes the schema. Every run holds a
 *   transaction-level advisory lock (`MIGRATION_LOCK`) from before it reads what is applied until it commits, so
 *   the server's boot (development), `whombat migrate` and the appliance manager's migration step can never apply
 *   the same migration twice; a second authority waits (with a deadline and a
 *   message naming the holder), then finds nothing left to do. Under the lock it validates like startup does
 *   (a foreign history, a newer schema this build can't read or an unsupported PostgreSQL major are refused),
 *   records each migration's compatibility (`whombat_meta.schema_versions`) so older binaries can judge the
 *   schema later, refuses contract/incompatible migrations without a consistent checkpoint (MD-06), and then
 *   runs registered backfills to completion in checkpointed batches (MD-05).
 *
 * All pending migrations apply in one transaction, as with drizzle: a failing migration leaves the database
 * exactly as it was. Backfills run after that commit, one batch per transaction, resumable.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type postgres from 'postgres';
import { BACKFILLS, type BackfillRegistry } from './backfills';
import type { Sql } from './client';
import {
  type BinarySchema,
  CHECKPOINT_CLASSES,
  CompatManifestError,
  type CompatManifestInput,
  type DatabaseSchemaState,
  evaluateSchema,
  isPreBaseline,
  isPreMove,
  PRE_BASELINE_REFUSAL,
  PRE_MOVE_REFUSAL,
  type RecordedCompat,
  resolveCompat,
  type SchemaCheck,
} from './compat';

export {
  type BinarySchema,
  CompatManifestError,
  type DatabaseSchemaState,
  evaluateSchema,
  SCHEMA_EXIT,
  type SchemaAccess,
  type SchemaCheck,
  type SchemaVerdict,
  schemaExitCode,
} from './compat';

type Queryable = Sql | postgres.TransactionSql;

/**
 * Where the migrations are: `$WHOMBAT_APP_DIR/migrations` in a packaged release (the bundles set
 * `WHOMBAT_APP_DIR` to their release), else next to this file in the checkout.
 */
export function migrationsFolder(env: Record<string, string | undefined> = process.env): string {
  const app = env.WHOMBAT_APP_DIR?.trim();
  return app ? join(app, 'migrations') : resolve(import.meta.dirname, 'migrations');
}

export const MIGRATIONS_FOLDER = migrationsFolder();

/** The compatibility manifest next to the journal (docs/decisions/managed-db.md MD-03). */
export const COMPAT_FILE = 'compat.json';

/** `pg_advisory_xact_lock` key of migrations ("WHMG"); the other Whombat locks are listed in BP-F05. */
export const MIGRATION_LOCK = 0x57484d47;

export interface Migration {
  /** `0017_bp_automations` */
  tag: string;
  /** The journal's `when` (drizzle's `created_at`). */
  when: number;
  /** sha256 of the file, as drizzle records it. */
  hash: string;
  statements: string[];
}

interface Journal {
  entries: { idx: number; when: number; tag: string; breakpoints: boolean }[];
}

/** The migrations of `folder`, in order (read exactly as drizzle's `readMigrationFiles` does). */
export function readMigrations(folder: string = MIGRATIONS_FOLDER): Migration[] {
  let journal: Journal;
  try {
    journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as Journal;
  } catch (err) {
    throw new Error(`Can’t read the migrations in ${folder} (${(err as Error).message})`);
  }
  return journal.entries.map((entry) => {
    const text = readFileSync(join(folder, `${entry.tag}.sql`)).toString();
    return {
      tag: entry.tag,
      when: entry.when,
      hash: createHash('sha256').update(text).digest('hex'),
      statements: text.split('--> statement-breakpoint'),
    };
  });
}

/** The newest migration of this build (`0017_bp_automations`): the schema version it expects. */
export function schemaVersion(folder: string = MIGRATIONS_FOLDER): string | null {
  try {
    const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as Journal;
    return journal.entries.at(-1)?.tag ?? null;
  } catch {
    return null;
  }
}

/**
 * This build's schema as the compatibility model sees it: its migrations with their declared class and
 * floors, what it needs of an older schema and the PostgreSQL majors it supports. Throws
 * `CompatManifestError` when `compat.json` is missing or breaks the rules of MD-03.
 */
export function binarySchema(
  folder: string = MIGRATIONS_FOLDER,
  migrations?: readonly Migration[],
): BinarySchema {
  const file = join(folder, COMPAT_FILE);
  if (!existsSync(file))
    throw new CompatManifestError(
      `${file} is missing: every build declares its migrations’ compatibility (docs/decisions/managed-db.md)`,
    );
  let manifest: CompatManifestInput;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8')) as CompatManifestInput;
  } catch (err) {
    throw new CompatManifestError(`${file} isn’t valid JSON (${(err as Error).message})`);
  }
  return resolveCompat(manifest, migrations ?? readMigrations(folder));
}

/** A row of `drizzle.__drizzle_migrations`. */
export interface AppliedMigration {
  hash: string;
  createdAt: number;
}

/** What the database has applied, oldest first (empty for a new database). */
export async function appliedMigrations(sql: Queryable): Promise<AppliedMigration[]> {
  const [exists] = await sql<{ t: string | null }[]>`select to_regclass('drizzle.__drizzle_migrations') as t`;
  if (!exists?.t) return [];
  const rows = await sql<{ hash: string; created_at: string }[]>`
    select hash, created_at from drizzle.__drizzle_migrations order by created_at, id`;
  return rows.map((r) => ({ hash: r.hash, createdAt: Number(r.created_at) }));
}

/**
 * Everything the compatibility model needs to know about a database, read without changing it: the applied
 * history, the compatibility recorded by the migration authority, unfinished backfills, the server's major.
 */
export async function readSchemaState(sql: Queryable): Promise<DatabaseSchemaState> {
  const applied = await appliedMigrations(sql);
  const [meta] = await sql<{ v: string | null; b: string | null; n: number }[]>`
    select to_regclass('whombat_meta.schema_versions') as v, to_regclass('whombat_meta.backfills') as b,
           current_setting('server_version_num')::int as n`;
  const recorded: RecordedCompat[] = meta?.v
    ? (
        await sql<RecordedCompat[]>`
          select version, tag, hash, class, readers, writers from whombat_meta.schema_versions order by version`
      ).map((r) => ({ ...r }))
    : [];
  const pendingBackfills = meta?.b
    ? await sql<{ name: string; version: number }[]>`
        select name, version from whombat_meta.backfills where state <> 'done' order by version, name`
    : [];
  return {
    applied,
    recorded,
    pendingBackfills: pendingBackfills.map((r) => ({ name: r.name, version: r.version })),
    postgresMajor: Math.floor((meta?.n ?? 0) / 10_000),
  };
}

export interface CheckOptions {
  /** Default: this build's migrations folder. */
  folder?: string;
}

/**
 * Startup validation (MD-02): what this build may do on the database, in one read-only transaction. Changes
 * nothing, takes no lock, creates no table.
 */
export async function checkSchema(sql: Sql, options: CheckOptions = {}): Promise<SchemaCheck> {
  const binary = binarySchema(options.folder ?? MIGRATIONS_FOLDER);
  const state = (await sql.begin('isolation level repeatable read read only', (tx) =>
    readSchemaState(tx),
  )) as DatabaseSchemaState;
  return evaluateSchema(state, binary);
}

export type SchemaCompatibility =
  | { ok: true; applied: number; pending: string[] }
  | { ok: false; applied: number; reason: string };

/**
 * Whether `applied` is a prefix of `migrations` (same files, same order). What a restore needs of a backup: it
 * rebuilds the backup's schema by replaying exactly those migrations, so it must have every one of them. The
 * runtime compatibility of a live database is `checkSchema`/`evaluateSchema`, which also accepts a newer schema
 * within this build's reader/writer range.
 */
export function schemaCompatibility(
  applied: readonly AppliedMigration[],
  migrations: readonly Migration[],
): SchemaCompatibility {
  // A backup from before the baseline (one-agent.md OA-S83), or of the chain before this one's: refused with its own
  // reason, whatever its length.
  if (isPreBaseline(applied) && applied[0]?.hash !== migrations[0]?.hash)
    return { ok: false, applied: applied.length, reason: PRE_BASELINE_REFUSAL.reason(applied.length) };
  if (isPreMove(applied) && applied[0]?.hash !== migrations[0]?.hash)
    return {
      ok: false,
      applied: applied.length,
      reason: `${PRE_MOVE_REFUSAL.reason(applied.length)}: ${PRE_MOVE_REFUSAL.action}`,
    };
  if (applied.length > migrations.length)
    return {
      ok: false,
      applied: applied.length,
      reason: `the database has ${applied.length} migrations applied and this build knows ${migrations.length}: the database is newer than this build`,
    };
  for (const [i, row] of applied.entries()) {
    const m = migrations[i] as Migration;
    if (row.createdAt !== m.when || row.hash !== m.hash)
      return {
        ok: false,
        applied: applied.length,
        reason: `migration ${i + 1} of the database isn’t this build’s ${m.tag} (a database from another version history)`,
      };
  }
  return { ok: true, applied: applied.length, pending: migrations.slice(applied.length).map((m) => m.tag) };
}

/** Another migrator held the lock for longer than the deadline. */
export class MigrationLockTimeout extends Error {
  override name = 'MigrationLockTimeout';
}

/**
 * This build can't run on the database (docs/decisions/managed-db.md MD-02): another history, a newer schema
 * past its reader floor, or an unsupported PostgreSQL major. Nothing was applied. `check` is the full answer.
 */
export class SchemaMismatch extends Error {
  override name = 'SchemaMismatch';
  constructor(
    message: string,
    readonly check?: SchemaCheck,
  ) {
    super(message);
  }
}

/**
 * Pending migrations narrow who may write (contract/incompatible) and no checkpoint was given (MD-06). Nothing
 * was applied.
 */
export class CheckpointRequired extends Error {
  override name = 'CheckpointRequired';
  constructor(
    message: string,
    readonly migrations: string[],
  ) {
    super(message);
  }
}

/** The refusal's text: what the database has, what this build is, what to do. */
export function schemaMismatchMessage(
  reason: string,
  migrations: readonly Migration[],
  action?: string,
): string {
  const latest = migrations.at(-1)?.tag ?? 'no migrations';
  const next = action
    ? `${action.charAt(0).toUpperCase()}${action.slice(1)}.`
    : 'Run the Whombat that last migrated it (whombat version there), or restore a backup made for this version (docs/upgrade.md).';
  const count = `${migrations.length} migration${migrations.length === 1 ? '' : 's'}`;
  return `This version of Whombat (schema ${latest}, ${count}) can’t run on this database: ${reason}. ${next}`;
}

export interface MigrateOptions {
  /** Default: this build's migrations folder. */
  folder?: string;
  /** Apply only the first `upTo` migrations (a restore rebuilds the schema of its backup first). */
  upTo?: number;
  /** How long to wait for another migrator (default 5 minutes). */
  timeoutMs?: number;
  /** Told about every 10 s while another migrator holds the lock, and about backfill progress. */
  onWait?: (line: string) => void;
  /**
   * The consistent checkpoint taken after quiescing writes (a backup's path or id): required to apply
   * contract/incompatible migrations to a database that has any (MD-06); recorded with them.
   */
  checkpoint?: string;
  /** Run unfinished backfills after the schema change (default true; a restore defers them, MD-05). */
  runBackfills?: boolean;
  /** Backfills by name (default: this build's, db/backfills.ts). */
  backfills?: BackfillRegistry;
  /** Recorded as who applied the migrations (a version line). */
  appliedBy?: string;
}

export interface MigrateResult {
  /** Tags applied by this run. */
  applied: string[];
  /** The newest migration now applied (the database's, when it is newer than this build). */
  latest: string | null;
  /** Backfills this run finished. */
  backfilled: string[];
  /** Startup validation's answer after the run. */
  check: SchemaCheck;
}

interface LockHolder {
  pid: number;
  application: string;
  since: string | null;
}

async function lockHolder(sql: Queryable): Promise<LockHolder | null> {
  // `xact_start` is a Date from a plain postgres.js pool and a string from one drizzle wrapped (createDb).
  const [row] = await sql<{ pid: number; application_name: string; xact_start: Date | string | null }[]>`
    select a.pid, a.application_name, a.xact_start
    from pg_locks l join pg_stat_activity a on a.pid = l.pid
    where l.locktype = 'advisory' and l.granted and l.classid = 0 and l.objid = ${MIGRATION_LOCK} and l.objsubid = 1
    limit 1`;
  if (!row) return null;
  const since = row.xact_start ? new Date(row.xact_start).toISOString() : null;
  return { pid: row.pid, application: row.application_name, since };
}

function describeHolder(holder: LockHolder | null): string {
  if (!holder) return 'another migration';
  const app = holder.application ? `, ${holder.application}` : '';
  const since = holder.since ? `, since ${holder.since}` : '';
  return `another migration (Postgres backend pid ${holder.pid}${app}${since})`;
}

/** The migration authority's own bookkeeping (not a migration: like drizzle's table, it predates them). */
async function ensureBookkeeping(tx: postgres.TransactionSql): Promise<void> {
  await tx.unsafe('create schema if not exists "drizzle"');
  await tx.unsafe(
    'create table if not exists "drizzle"."__drizzle_migrations" (id serial primary key, hash text not null, created_at bigint)',
  );
  await tx.unsafe('create schema if not exists "whombat_meta"');
  await tx.unsafe(`create table if not exists "whombat_meta"."schema_versions" (
    version integer primary key,
    tag text not null,
    hash text not null,
    class text not null,
    readers integer not null,
    writers integer not null,
    backfill text,
    checkpoint text,
    applied_by text,
    recorded_at timestamptz not null default now()
  )`);
  await tx.unsafe(`create table if not exists "whombat_meta"."backfills" (
    name text primary key,
    version integer not null,
    state text not null default 'pending' check (state in ('pending', 'done')),
    cursor text,
    processed bigint not null default 0,
    batches integer not null default 0,
    registered_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    finished_at timestamptz
  )`);
}

const fatal = new Set(['foreign', 'newer_incompatible', 'postgres_unsupported']);

/**
 * The migration authority: applies the pending migrations under `MIGRATION_LOCK`, then finishes unfinished
 * backfills. Waits for another migrator up to `timeoutMs`, then throws `MigrationLockTimeout` naming it.
 * Throws `SchemaMismatch` (foreign history, unreadable newer schema, unsupported PostgreSQL), `CheckpointRequired`
 * or `CompatManifestError` without applying anything. A newer schema this build can read is left alone.
 */
export async function runMigrations(sql: Sql, options: MigrateOptions = {}): Promise<MigrateResult> {
  const folder = options.folder ?? MIGRATIONS_FOLDER;
  const all = readMigrations(folder);
  const binary = binarySchema(folder, all);
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const applied = (await sql.begin(async (tx) => {
    const deadline = Date.now() + timeoutMs;
    let nextNote = Date.now();
    for (;;) {
      const [row] = await tx<{ ok: boolean }[]>`select pg_try_advisory_xact_lock(${MIGRATION_LOCK}) as ok`;
      if (row?.ok) break;
      const holder = await lockHolder(tx);
      if (Date.now() >= deadline)
        throw new MigrationLockTimeout(
          `The database migrations are locked by ${describeHolder(holder)}; waited ${Math.round(timeoutMs / 1000)} s. Another Whombat (or an upgrade) is migrating this database: let it finish, or stop it, then try again.`,
        );
      if (Date.now() >= nextNote) {
        options.onWait?.(`waiting for ${describeHolder(holder)} to finish`);
        nextNote = Date.now() + 10_000;
      }
      await sleep(250);
    }
    await ensureBookkeeping(tx);
    // Under the lock, before anything is applied: the same judgement startup makes.
    const state = await readSchemaState(tx);
    const target = options.upTo === undefined ? all.length : Math.min(options.upTo, all.length);
    const check = evaluateSchema(state, binary);
    if (fatal.has(check.verdict))
      throw new SchemaMismatch(schemaMismatchMessage(check.reason, all, check.action), check);
    // Positions: how many of the chain's migrations the database applied.
    const d = state.applied.length;
    // Keep the database self-describing: the compatibility of what it applied before this model recorded it.
    for (const m of binary.migrations.slice(0, Math.min(d, binary.migrations.length)))
      await tx`
        insert into whombat_meta.schema_versions (version, tag, hash, class, readers, writers, backfill)
        values (${m.version}, ${m.tag}, ${all[m.version - binary.base - 1]?.hash as string}, ${m.class}, ${m.readers}, ${m.writers}, ${m.backfill})
        on conflict (version) do nothing`;
    const todo = binary.migrations.slice(d, Math.max(d, target));
    const narrowing =
      d === 0 ? [] : todo.filter((m) => CHECKPOINT_CLASSES.includes(m.class)).map((m) => m.tag);
    if (narrowing.length && !options.checkpoint?.trim())
      throw new CheckpointRequired(
        `Migration${narrowing.length > 1 ? 's' : ''} ${narrowing.join(', ')} narrow${narrowing.length > 1 ? '' : 's'} which Whombat versions may write this database, so ${narrowing.length > 1 ? 'they need' : 'it needs'} a consistent checkpoint first: stop writes and external effects (stop Whombat, or let the appliance reach a safe boundary), take a backup and verify it, then migrate with it (whombat migrate --checkpoint <backup>; docs/decisions/managed-db.md MD-06). Nothing was applied.`,
        narrowing,
      );
    for (const b of todo.filter((m) => m.backfill))
      if (!(options.backfills ?? BACKFILLS)[b.backfill as string])
        throw new CompatManifestError(
          `${b.tag}: backfill ${b.backfill} isn’t registered in this build (db/backfills.ts)`,
        );
    const tags: string[] = [];
    for (const m of todo) {
      const file = all[m.version - binary.base - 1] as Migration;
      for (const statement of file.statements) if (statement.trim()) await tx.unsafe(statement);
      await tx`insert into drizzle.__drizzle_migrations (hash, created_at) values (${file.hash}, ${file.when})`;
      const checkpoint = CHECKPOINT_CLASSES.includes(m.class) ? (options.checkpoint?.trim() ?? null) : null;
      await tx`
        insert into whombat_meta.schema_versions
          (version, tag, hash, class, readers, writers, backfill, checkpoint, applied_by)
        values (${m.version}, ${m.tag}, ${file.hash}, ${m.class}, ${m.readers}, ${m.writers}, ${m.backfill},
                ${checkpoint}, ${options.appliedBy ?? null})
        on conflict (version) do update set tag = excluded.tag, hash = excluded.hash, class = excluded.class,
          readers = excluded.readers, writers = excluded.writers, backfill = excluded.backfill,
          checkpoint = excluded.checkpoint, applied_by = excluded.applied_by, recorded_at = now()`;
      if (m.backfill)
        await tx`insert into whombat_meta.backfills (name, version) values (${m.backfill}, ${m.version})
                 on conflict (name) do nothing`;
      tags.push(m.tag);
    }
    return tags;
  })) as string[];
  const backfilled =
    options.runBackfills === false
      ? []
      : await runBackfills(sql, binary, options.backfills ?? BACKFILLS, options.onWait);
  const check = await checkSchema(sql, { folder });
  return { applied, latest: check.database.tag, backfilled, check };
}

/**
 * Finishes the unfinished backfills this build knows (MD-05), oldest migration first: one batch per
 * transaction, which locks the backfill's row, runs the batch after the stored cursor and stores the next
 * cursor — so an interrupted run resumes where the last committed batch ended, and two authorities never
 * process the same batch. Resolves with the names it finished.
 */
export async function runBackfills(
  sql: Sql,
  binary: BinarySchema,
  registry: BackfillRegistry = BACKFILLS,
  onProgress?: (line: string) => void,
): Promise<string[]> {
  const [meta] = await sql<{ b: string | null }[]>`select to_regclass('whombat_meta.backfills') as b`;
  if (!meta?.b) return [];
  const pending = await sql<{ name: string; version: number }[]>`
    select name, version from whombat_meta.backfills
    where state <> 'done' and version <= ${binary.version} order by version, name`;
  const finished: string[] = [];
  for (const { name } of pending) {
    const backfill = registry[name];
    if (!backfill)
      throw new CompatManifestError(`backfill ${name} isn’t registered in this build (db/backfills.ts)`);
    for (;;) {
      const state = (await sql.begin(async (tx) => {
        const [row] = await tx<{ state: string; cursor: string | null; processed: string }[]>`
          select state, cursor, processed from whombat_meta.backfills where name = ${name} for update`;
        if (!row || row.state === 'done') return 'done';
        const batch = await backfill.batch(tx, row.cursor);
        await tx`
          update whombat_meta.backfills set
            cursor = ${batch.cursor}, processed = processed + ${batch.processed}, batches = batches + 1,
            state = ${batch.done ? 'done' : 'pending'}, updated_at = now(),
            finished_at = ${batch.done ? tx`now()` : null}
          where name = ${name}`;
        return batch.done ? 'finished' : 'more';
      })) as 'done' | 'finished' | 'more';
      if (state === 'finished') {
        finished.push(name);
        onProgress?.(`backfill ${name} finished`);
      }
      if (state !== 'more') break;
    }
  }
  return finished;
}
