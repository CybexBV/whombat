/**
 * `@whombat/server/host`: what the runtime bundle's `whombat` CLI (apps/cli: `schema-check`, `migrate`, `version`) and
 * its build (scripts/package) take from the server, in one place. They run these in their own process; they never
 * reach into other modules.
 */
export { looseModeIssue } from './config';
export { createDb } from './db/client';
export {
  binarySchema,
  CheckpointRequired,
  CompatManifestError,
  checkSchema,
  type MigrateResult,
  MigrationLockTimeout,
  readMigrations,
  runMigrations,
  SCHEMA_EXIT,
  type SchemaCheck,
  SchemaMismatch,
  schemaExitCode,
  schemaVersion,
} from './db/migrate';
export { buildInfo, versionLine } from './version';
