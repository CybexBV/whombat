/**
 * What the server does with the database before it serves anything (docs/decisions/managed-db.md MD-02, MD-07).
 *
 * - Production (the appliance): the boot only validates. The appliance manager is the one migration authority
 *   (`whombat migrate --json`, run before it starts the new runtime); a database that still needs migrating stops the
 *   boot with `migration_required` (exit 10).
 * - Development and tests (no manager, hermes-engine.md HE-49): the boot migrates, under the advisory lock, with a
 *   development checkpoint, so `pnpm dev` keeps migrating on its own.
 *
 * Either way the answer is the compatibility check's `access`: `read-write` (normal), `read-only` (a newer
 * binary contracted the schema past this one's writer floor: serve reads, refuse writes, run no workers) or a
 * refusal with the reason, the way forward and an exit code (`SCHEMA_EXIT`).
 */
import type { Config } from '../config';
import type { Sql } from './client';
import { SCHEMA_EXIT, type SchemaCheck, schemaExitCode } from './compat';
import {
  CheckpointRequired,
  checkSchema,
  type MigrateOptions,
  readMigrations,
  runMigrations,
  SchemaMismatch,
  schemaMismatchMessage,
} from './migrate';

export type MigrationAuthority = 'boot' | 'external';

/** Who migrates for this process: the appliance manager in production, the boot elsewhere (no manager there). */
export function migrationAuthority(config: Pick<Config, 'NODE_ENV'>): MigrationAuthority {
  return config.NODE_ENV === 'production' ? 'external' : 'boot';
}

/** The boot can't run on this database: say why and exit with `exitCode`. */
export class StartupRefused extends Error {
  override name = 'StartupRefused';
  constructor(
    message: string,
    readonly exitCode: number,
    readonly check?: SchemaCheck,
  ) {
    super(message);
  }
}

export interface SchemaStartup {
  access: 'read-write' | 'read-only';
  check: SchemaCheck;
  /** Migrations this boot applied (development only). */
  applied: string[];
}

export interface PrepareOptions {
  authority: MigrationAuthority;
  /** Outside production the boot may apply contract migrations with a development checkpoint. */
  development?: boolean;
  onWait?: (line: string) => void;
  /** Tests: another migrations folder. */
  folder?: string;
  backfills?: MigrateOptions['backfills'];
}

/**
 * Migrates (development) or only validates (production), then decides how the server may use the database.
 * Throws `StartupRefused` when it can't.
 */
export async function prepareSchema(sql: Sql, options: PrepareOptions): Promise<SchemaStartup> {
  let check: SchemaCheck;
  let applied: string[] = [];
  const migrations = readMigrations(options.folder);
  if (options.authority === 'boot') {
    try {
      const result = await runMigrations(sql, {
        folder: options.folder,
        onWait: options.onWait,
        backfills: options.backfills,
        ...(options.development ? { checkpoint: 'development boot (NODE_ENV is not production)' } : {}),
      });
      check = result.check;
      applied = result.applied;
    } catch (err) {
      if (err instanceof SchemaMismatch)
        throw new StartupRefused(err.message, SCHEMA_EXIT.refused, err.check);
      if (err instanceof CheckpointRequired)
        throw new StartupRefused(err.message, SCHEMA_EXIT.checkpointRequired);
      throw err;
    }
  } else check = await checkSchema(sql, { folder: options.folder });

  if (check.verdict === 'migration_required')
    throw new StartupRefused(
      `The database needs migrating before this version of Whombat can start: ${check.reason}. ${capital(check.action)}.`,
      SCHEMA_EXIT.migrationRequired,
      check,
    );
  if (check.access === 'none')
    throw new StartupRefused(
      schemaMismatchMessage(check.reason, migrations, check.action),
      schemaExitCode(check),
      check,
    );
  return { access: check.access, check, applied };
}

function capital(s: string): string {
  return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s;
}
