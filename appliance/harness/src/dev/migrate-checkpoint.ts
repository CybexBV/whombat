/**
 * The dev stack's migration with a checkpoint (IN-424; Whombat MD-02, MD-06; BK-17). `dev/up` is the migration
 * authority: it runs `whombat migrate --json --env` before the runtime starts. A `contract` (or `incompatible`)
 * migration is refused with exit 13 until it is given a consistent checkpoint (`--checkpoint <ref>`). On a box the
 * manager takes that one (a verified `migration` checkpoint under its drain). Here the runtime is stopped at that
 * point, so nothing writes: when the stack runs its backup service with a destination, the stack takes one backup
 * (the `manual` reason) and migrates again with its id, which Whombat records with each such migration. Without a
 * backup service the migration fails as before, now saying what would let it go through.
 *
 * The backup is taken by the stack's backup CLI with the service's own config and state (one destination, chain,
 * run lock), but without the runtime admin socket (`allowNoRuntime`, an offline checkpoint): the service's
 * `POST /v1/checkpoints` drains the runtime through that socket first, and a stopped runtime never answers (the
 * checkpoint fails after the quiesce timeout). It is read back from the destination (snapshot and manifest) like
 * every checkpoint, not the full verification of the manager's `migration` checkpoint (that route is the manager's,
 * under a drain of a running runtime).
 */
type Log = (line: string) => void;

/** `whombat migrate`'s exit when a migration needs a checkpoint first (Whombat SCHEMA_EXIT.checkpointRequired). */
export const CHECKPOINT_REQUIRED_EXIT = 13;

/** A checkpoint id the box's update helper would pass to `whombat migrate --checkpoint` (helper `ValidCheckpointID`). */
export function validCheckpointId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) && !id.includes('..');
}

/** What one `whombat migrate --json --env` run gave. */
export interface MigrateRun {
  code: number | null;
  stdout: string;
}

/** The `whombat.migrate/1` answer in a run's output (its last JSON line), or null. */
function migrateAnswer(stdout: string): { error?: { kind?: string; migrations?: unknown } } | null {
  const line = stdout
    .trim()
    .split('\n')
    .reverse()
    .find((l) => l.trim().startsWith('{'));
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Whether the run stopped because a migration needs a checkpoint first (exit 13, or its answer's
 * `error.kind: checkpoint_required`): the migrations that need it (empty when the answer doesn't list them), or null.
 */
export function checkpointRequired(run: MigrateRun): { migrations: string[] } | null {
  if (run.code === 0) return null;
  const error = migrateAnswer(run.stdout)?.error;
  if (run.code !== CHECKPOINT_REQUIRED_EXIT && error?.kind !== 'checkpoint_required') return null;
  const m = error?.migrations;
  return { migrations: Array.isArray(m) ? m.filter((x): x is string => typeof x === 'string') : [] };
}

/** A checkpoint the stack took. */
export interface TakenCheckpoint {
  id: string;
  snapshotId?: string;
  seq?: number;
  durationMs?: number;
}

/** The stack's backup service, as far as the migration needs it. */
export interface StackBackup {
  /** Why no checkpoint can be taken now (no backup service, no destination), or null when one can. */
  missing(): Promise<string | null>;
  /** One checkpoint, with the runtime stopped. */
  take(): Promise<TakenCheckpoint>;
}

export interface MigrateRuntimeOptions {
  /** The checkpoint the runtime bridge passes (the helper migrated with it), if any. */
  given: string | null;
  migrate: (checkpoint: string | null) => Promise<MigrateRun>;
  backup: StackBackup;
  log: Log;
  /** Where the migration's output is (`see … (dev/logs runtime-migrate)`). */
  hint: string;
}

function failed(run: MigrateRun, hint: string, extra = ''): Error {
  return new Error(
    `whombat migrate failed (exit ${run.code}): ${run.stdout.trim().slice(-400)}; ${extra}${hint}`,
  );
}

function names(migrations: string[]): string {
  if (!migrations.length) return 'a migration';
  return `${migrations.length > 1 ? 'migrations' : 'migration'} ${migrations.join(', ')}`;
}

/**
 * Migrates; when a migration needs a checkpoint and none was given, takes one through the stack's backup service and
 * migrates again with its id. Returns the checkpoint the migration ran with (not persisted anywhere).
 */
export async function migrateRuntime(o: MigrateRuntimeOptions): Promise<{ checkpoint: string | null }> {
  const first = await o.migrate(o.given);
  if (first.code === 0) return { checkpoint: o.given };
  const need = checkpointRequired(first);
  if (!need || o.given) throw failed(first, o.hint);
  const missing = await o.backup.missing();
  if (missing)
    throw failed(
      first,
      o.hint,
      `${names(need.migrations)} needs a backup first (MD-06), which dev/up takes through the backup service, but ${missing}: start the stack with it (restic installed, not --without backup); `,
    );
  o.log(
    `runtime: ${names(need.migrations)} needs a backup first (MD-06); the runtime is stopped, so the backup service takes one now`,
  );
  const ck = await o.backup.take();
  if (!validCheckpointId(ck.id))
    throw new Error(`backup: the checkpoint id ${JSON.stringify(ck.id)} is not one migrate can record`);
  const how = [
    ck.snapshotId ? `snapshot ${ck.snapshotId.slice(0, 8)}` : '',
    ck.durationMs !== undefined ? `${(ck.durationMs / 1000).toFixed(1)} s` : '',
  ].filter(Boolean);
  o.log(
    `runtime: backup ${ck.id} taken${how.length ? ` (${how.join(', ')})` : ''}; migrating with it (whombat migrate --checkpoint ${ck.id})`,
  );
  const second = await o.migrate(ck.id);
  if (second.code !== 0) throw failed(second, o.hint, `with checkpoint ${ck.id}: `);
  return { checkpoint: ck.id };
}

/**
 * The stack's backup config for an offline checkpoint: the same config with no runtime admin socket and
 * `allowNoRuntime` (the backup service's setting for a stopped runtime), so the checkpoint doesn't wait for a drain.
 */
export function offlineBackupConfig(config: string): string {
  const c = JSON.parse(config) as Record<string, unknown>;
  return `${JSON.stringify({ ...c, runtimeSocket: '', allowNoRuntime: true }, null, 2)}\n`;
}

/** `whombat-backup run -json`'s answer: `{id, seq, snapshotId, manifestSha256, durationMs, quiesce}`. */
export function parseBackupRun(stdout: string): TakenCheckpoint {
  const start = stdout.indexOf('{');
  let v: Record<string, unknown> = {};
  try {
    v = start < 0 ? {} : JSON.parse(stdout.slice(start));
  } catch {
    // reported below
  }
  if (typeof v.id !== 'string' || !v.id)
    throw new Error(`backup: whombat-backup run printed no checkpoint id: ${stdout.trim().slice(-300)}`);
  return {
    id: v.id,
    ...(typeof v.snapshotId === 'string' ? { snapshotId: v.snapshotId } : {}),
    ...(typeof v.seq === 'number' ? { seq: v.seq } : {}),
    ...(typeof v.durationMs === 'number' ? { durationMs: v.durationMs } : {}),
  };
}
