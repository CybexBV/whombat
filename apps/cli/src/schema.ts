/**
 * The two database commands the appliance's update helper runs with the runtime bundle's `bin/whombat`
 * (docs/decisions/managed-db.md MD-10, MA-11; the appliance's `whombat-runtime-schema-init` too):
 *
 * - `whombat schema-check --json --env`: startup validation without starting anything. Read-only: it opens one
 *   read-only transaction, creates nothing and takes no lock. Answers the compatibility check (`SchemaCheck`,
 *   format `whombat.schema-check/1`) and exits with `SCHEMA_EXIT`: 0 read-write, 10 migration required,
 *   11 read-only, 12 refused.
 * - `whombat migrate --json --env [--checkpoint <ref>]`: the migration authority. Under the migration lock; applies
 *   what is pending (contract/incompatible migrations only with `--checkpoint`, MD-06), finishes backfills, and
 *   answers `whombat.migrate/1` with the check afterwards. Exits 0 when this build can then read and write,
 *   11 when only read, 12 refused (nothing applied), 13 checkpoint required (nothing applied), 14 lock timeout.
 *
 * The database comes from the environment (`DATABASE_URL`, or `WHOMBAT_ENV_FILE`; `--env` says so).
 */
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import {
  buildInfo,
  CheckpointRequired,
  CompatManifestError,
  checkSchema,
  createDb,
  looseModeIssue,
  type MigrateResult,
  MigrationLockTimeout,
  runMigrations,
  SCHEMA_EXIT,
  type SchemaCheck,
  SchemaMismatch,
  schemaExitCode,
  versionLine,
} from '@whombat/server/host';
import { CliError } from './errors';

/** The database the commands work on. */
export interface DatabaseTarget {
  url: string;
}

/**
 * `--env` (MD-10): `DATABASE_URL` from the environment, else from `WHOMBAT_ENV_FILE`, read as the server reads it (in
 * production the file must not be readable by group or others). Only the database is taken, no server configuration
 * is loaded: the appliance's update helper runs this as the runtime user with `NODE_ENV=production` and that file
 * alone, without the server's secrets (MR-73).
 */
export function targetFromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseTarget {
  let url = env.DATABASE_URL?.trim();
  const file = env.WHOMBAT_ENV_FILE?.trim();
  if (!url && file) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      throw new CliError(
        `--env: cannot read WHOMBAT_ENV_FILE ${file} (${(err as NodeJS.ErrnoException).code ?? String(err)}).`,
        'check the path and that this user may read it',
      );
    }
    const parsed = parseEnv(text);
    if ((env.NODE_ENV ?? parsed.NODE_ENV) === 'production') {
      const loose = looseModeIssue(file);
      if (loose) throw new CliError(`--env: ${loose}`);
    }
    url = parsed.DATABASE_URL?.trim();
  }
  if (!url)
    throw new CliError(
      '--env: no DATABASE_URL (or WHOMBAT_ENV_FILE) in the environment.',
      'set DATABASE_URL or WHOMBAT_ENV_FILE',
    );
  return { url };
}

export interface CommandOutput {
  code: number;
  /** What to print (JSON when asked, else lines). */
  text: string;
}

function describeCheck(check: SchemaCheck): string {
  const lines = [
    `schema: ${check.verdict} (${check.access})`,
    `this build: ${check.binary.tag ?? 'no migrations'} (${check.binary.version}); database: ${check.database.tag ?? 'empty'} (${check.database.version}), PostgreSQL ${check.database.postgresMajor}`,
    check.reason,
  ];
  if (check.pending.length) lines.push(`pending: ${check.pending.join(', ')}`);
  const t = check.target;
  if (check.pending.length && t)
    lines.push(
      `after migrating: ${t.tag ?? 'no migrations'} (${t.version}); readable from schema ${t.readers}, writable from schema ${t.writers}`,
    );
  if (check.database.pendingBackfills.length)
    lines.push(`unfinished backfills: ${check.database.pendingBackfills.join(', ')}`);
  if (check.action) lines.push(`next: ${check.action}`);
  return lines.join('\n');
}

/** `whombat schema-check`. */
export async function schemaCheckCommand(target: DatabaseTarget, json: boolean): Promise<CommandOutput> {
  let check: SchemaCheck;
  try {
    const { sql } = createDb(target.url, { max: 1 });
    try {
      check = await checkSchema(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  } catch (err) {
    const message = (err as Error).message;
    return {
      code: SCHEMA_EXIT.error,
      text: json
        ? JSON.stringify({ format: 'whombat.schema-check/1', error: { kind: errorKind(err), message } })
        : `Can’t check the database schema: ${message}`,
    };
  }
  return { code: schemaExitCode(check), text: json ? JSON.stringify(check) : describeCheck(check) };
}

function errorKind(err: unknown): string {
  if (err instanceof MigrationLockTimeout) return 'lock_timeout';
  if (err instanceof SchemaMismatch) return 'schema_mismatch';
  if (err instanceof CheckpointRequired) return 'checkpoint_required';
  if (err instanceof CompatManifestError) return 'compat_manifest';
  return 'failed';
}

function errorCode(err: unknown): number {
  if (err instanceof MigrationLockTimeout) return SCHEMA_EXIT.lockTimeout;
  if (err instanceof SchemaMismatch) return SCHEMA_EXIT.refused;
  if (err instanceof CheckpointRequired) return SCHEMA_EXIT.checkpointRequired;
  return SCHEMA_EXIT.error;
}

export interface MigrateCommandOptions {
  json: boolean;
  checkpoint?: string;
  /** Progress lines (not in --json mode, where only the answer is printed). */
  log?: (line: string) => void;
}

/** `whombat migrate`: the migration authority. */
export async function migrateCommand(
  target: DatabaseTarget,
  options: MigrateCommandOptions,
): Promise<CommandOutput> {
  let result: MigrateResult;
  try {
    const { sql } = createDb(target.url, { max: 1 });
    try {
      result = await runMigrations(sql, {
        checkpoint: options.checkpoint,
        appliedBy: `whombat ${versionLine(buildInfo())}`,
        onWait: options.json ? undefined : options.log,
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  } catch (err) {
    const message = (err as Error).message;
    const check = err instanceof SchemaMismatch ? err.check : undefined;
    const migrations = err instanceof CheckpointRequired ? err.migrations : undefined;
    return {
      code: errorCode(err),
      text: options.json
        ? JSON.stringify({
            format: 'whombat.migrate/1',
            ok: false,
            applied: [],
            error: { kind: errorKind(err), message, ...(migrations ? { migrations } : {}) },
            ...(check ? { check } : {}),
          })
        : message,
    };
  }
  const code =
    result.check.access === 'read-write'
      ? SCHEMA_EXIT.ok
      : result.check.access === 'read-only'
        ? SCHEMA_EXIT.readOnly
        : schemaExitCode(result.check);
  if (options.json)
    return {
      code,
      text: JSON.stringify({
        format: 'whombat.migrate/1',
        ok: code === SCHEMA_EXIT.ok,
        applied: result.applied,
        backfilled: result.backfilled,
        latest: result.latest,
        check: result.check,
      }),
    };
  const head = result.applied.length
    ? `Applied ${result.applied.length} migration${result.applied.length > 1 ? 's' : ''}: ${result.applied.join(', ')}.`
    : `The database is up to date (${result.latest ?? 'no migrations'}).`;
  const tail = [
    ...(result.backfilled.length ? [`Backfills finished: ${result.backfilled.join(', ')}.`] : []),
    ...(result.check.access === 'read-write' ? [] : [describeCheck(result.check)]),
  ];
  return { code, text: [head, ...tail].join('\n') };
}
