/** Pure compatibility checks between tuples, databases and clients (MA-11, managed-db reader/writer model). */
import type { IntRange } from './primitives.js';
import { type ClientFloor, protocolCode, type ReleaseTuple } from './tuple.js';

const within = (r: IntRange, v: number) => r.min <= v && v <= r.max;

export type UpdateClass = 'none' | 'runtime' | 'host' | 'runtime+host';

/** Which update classes a candidate needs: runtime/provider bundle (no reboot) and/or host/manager (reboot). */
export function updateClass(current: ReleaseTuple, candidate: ReleaseTuple): UpdateClass {
  const key = (c: { storePath: string }) => c.storePath;
  const runtime =
    key(current.runtime) !== key(candidate.runtime) ||
    JSON.stringify(current.providers.map(key).sort()) !== JSON.stringify(candidate.providers.map(key).sort());
  const host = key(current.host) !== key(candidate.host) || key(current.manager) !== key(candidate.manager);
  return runtime && host ? 'runtime+host' : runtime ? 'runtime' : host ? 'host' : 'none';
}

/** What the current runtime may do on the database a candidate leaves behind (a rollback's access). */
export type RollbackAccess = 'read-write' | 'read-only' | 'none';

export interface ActivationCheck {
  ok: boolean;
  /** Quiesce and take a verified checkpoint before migrating (a rollback wouldn't be read-write, or a migration the
   * runtime names needs one). */
  requiresCheckpoint: boolean;
  /** The current (known-good) runtime can still read and write after the candidate's migration. */
  rollbackCompatible: boolean;
  /** `read-write` when rollback-compatible; `read-only` only from the floors (`checkMigratingActivation`, CT-134, and
   * `checkCompatibleActivation`, CT-135). */
  rollbackAccess: RollbackAccess;
  reasons: string[];
}

/**
 * Can `candidate` activate on a device running `current` with the database at `dbSchema`?
 * - the candidate must read the current schema (it starts before migrating) and must not be older than it can
 *   write (`schemaWrites ≥ dbSchema`: never roll the schema back);
 * - the candidate's host ABI range must include the host that will run it;
 * - rollback-compatible when the current runtime reads `candidate.schemaWrites`; otherwise a checkpoint.
 */
export function checkActivation(
  current: ReleaseTuple,
  candidate: ReleaseTuple,
  dbSchema: number,
): ActivationCheck {
  const reasons: string[] = [];
  if (!within(candidate.runtime.schemaReads, dbSchema)) reasons.push('candidate_cannot_read_schema');
  if (candidate.runtime.schemaWrites < dbSchema) reasons.push('schema_downgrade');
  if (!within(candidate.runtime.hostAbi, candidate.host.abi)) reasons.push('host_abi_unsupported');
  const rollbackCompatible = within(current.runtime.schemaReads, candidate.runtime.schemaWrites);
  return {
    ok: reasons.length === 0,
    requiresCheckpoint: !rollbackCompatible,
    rollbackCompatible,
    rollbackAccess: rollbackCompatible ? 'read-write' : 'none',
    reasons,
  };
}

/**
 * What the candidate's own schema check (Whombat `schema-check`, MD-10/MD-12) answered about the live database when it
 * must migrate it (migration required, not refused or read-only).
 */
export interface SchemaMigration {
  /** The schema its migrations produce (`target.version`); the candidate's `schemaWrites`. */
  target: number;
  /** That schema's reader and writer floors: the oldest binary schema that can read / write it. `null` from runtimes
   * that don't report them. */
  readers: number | null;
  writers: number | null;
  /** Pending migrations the runtime says need a verified checkpoint first (contract and incompatible classes). */
  needsCheckpoint: string[];
}

/**
 * `checkActivation` for a candidate whose schema check said the database at `dbSchema` must be migrated first (CT-134).
 * That answer is the proof the candidate migrates from `dbSchema`, so it must read the schema it migrates **to**
 * (`target`, which must be its `schemaWrites`: `schema_target_mismatch` otherwise), not `dbSchema`. The current runtime
 * (schema `current.runtime.schemaWrites`) can read the migrated database when it is at or above the target's reader
 * floor and write it when at or above the writer floor — the floors decide, as they do in that runtime's own check,
 * whatever its tuple's `schemaReads` claims: `read-write` is rollback-compatible, `read-only` a rollback that runs
 * read-only. A checkpoint is required for the migrations the
 * runtime names and whenever a rollback would not be read-write. Without floors (`readers`/`writers` null) the answer
 * is `checkActivation(current, candidate, dbSchema)`, plus a checkpoint for the migrations the runtime names.
 */
export function checkMigratingActivation(
  current: ReleaseTuple,
  candidate: ReleaseTuple,
  dbSchema: number,
  migration: SchemaMigration,
): ActivationCheck {
  const { target, readers, writers, needsCheckpoint } = migration;
  if (readers === null || writers === null) {
    const c = checkActivation(current, candidate, dbSchema);
    return { ...c, requiresCheckpoint: c.requiresCheckpoint || needsCheckpoint.length > 0 };
  }
  const reasons: string[] = [];
  if (!within(candidate.runtime.schemaReads, target)) reasons.push('candidate_cannot_read_schema');
  if (candidate.runtime.schemaWrites < dbSchema) reasons.push('schema_downgrade');
  if (target !== candidate.runtime.schemaWrites) reasons.push('schema_target_mismatch');
  if (!within(candidate.runtime.hostAbi, candidate.host.abi)) reasons.push('host_abi_unsupported');
  const own = current.runtime.schemaWrites;
  const rollbackAccess: RollbackAccess =
    own >= writers ? 'read-write' : own >= readers ? 'read-only' : 'none';
  const rollbackCompatible = rollbackAccess === 'read-write';
  return {
    ok: reasons.length === 0,
    requiresCheckpoint: !rollbackCompatible || needsCheckpoint.length > 0,
    rollbackCompatible,
    rollbackAccess,
    reasons,
  };
}

/**
 * The live schema's floors as the candidate's own schema check reports them with exit 0 (Whombat MD-12): the oldest
 * binary schema that can read the database (`readers`) and write it (`writers`).
 */
export interface SchemaFloors {
  readers: number;
  writers: number;
}

const accessAt = (own: number, f: SchemaFloors): RollbackAccess =>
  own >= f.writers ? 'read-write' : own >= f.readers ? 'read-only' : 'none';

/**
 * `checkActivation` for a candidate whose own schema check answered exit 0 (nothing to migrate) **and** reported the
 * live schema's floors (CT-135, UP-B2). Let `own` be the candidate's schema (`candidate.runtime.schemaWrites`):
 * - `own ≥ dbSchema`: `checkActivation`'s candidate checks (its `schemaReads` must include `dbSchema`);
 * - `own < dbSchema` (an older runtime on a newer database, e.g. a custody rollback after an `expand`): the floors
 *   decide, as they do in the candidate's own check — `own ≥ writers` activates, `readers ≤ own < writers` is
 *   `candidate_read_only`, `own < readers` is `candidate_cannot_read_schema`; there is no `schema_downgrade` (nothing
 *   migrates down: the newer schema stays and is written compatibly) and no `schemaReads` check;
 * - always `host_abi_unsupported` as in `checkActivation`.
 * `rollbackAccess` is the installed runtime's own schema (`current.runtime.schemaWrites`) against the same floors;
 * `rollbackCompatible` = `read-write`; `requiresCheckpoint` is false (nothing migrates on exit 0). The forward check
 * (a custody rollback needs the TUF-signed `allowDowngradeFrom`) is separate and unchanged.
 */
export function checkCompatibleActivation(
  current: ReleaseTuple,
  candidate: ReleaseTuple,
  dbSchema: number,
  floors: SchemaFloors,
): ActivationCheck {
  const reasons: string[] = [];
  const own = candidate.runtime.schemaWrites;
  if (own >= dbSchema) {
    if (!within(candidate.runtime.schemaReads, dbSchema)) reasons.push('candidate_cannot_read_schema');
  } else {
    const access = accessAt(own, floors);
    if (access === 'read-only') reasons.push('candidate_read_only');
    if (access === 'none') reasons.push('candidate_cannot_read_schema');
  }
  if (!within(candidate.runtime.hostAbi, candidate.host.abi)) reasons.push('host_abi_unsupported');
  const rollbackAccess = accessAt(current.runtime.schemaWrites, floors);
  return {
    ok: reasons.length === 0,
    requiresCheckpoint: false,
    rollbackCompatible: rollbackAccess === 'read-write',
    rollbackAccess,
    reasons,
  };
}

/** Does the tuple's runtime serve a client that speaks `version`? */
export function servesClient(tuple: ReleaseTuple, version: { major: number; minor: number }): boolean {
  const r = tuple.runtime.protocol;
  // Same major, any minor: minors are additive and negotiated down.
  return Math.floor(r.min / 1000) <= version.major && version.major <= Math.floor(r.max / 1000);
}

/** Session protocol majors a runtime range covers (one since contracts 1.0, HE-52). */
export function protocolMajors(range: IntRange): number[] {
  const out: number[] = [];
  for (let m = Math.floor(range.min / 1000); m <= Math.floor(range.max / 1000); m++) out.push(m);
  return out;
}

/** Does a client range and a runtime range share a major? */
export function protocolOverlap(client: IntRange, runtime: IntRange): boolean {
  const majors = new Set(protocolMajors(runtime));
  return protocolMajors(client).some((m) => majors.has(m));
}

export { protocolCode };

/**
 * The build a client must at least run, when it is below the floor (CT-53); null when it may connect. A platform
 * without a floor (`0`, or no floor at all) is always served. A client that sends no `buildNumber` counts as build 0,
 * so it is refused wherever a floor is set. Unknown platforms have no floor.
 */
export function clientBelowFloor(
  floor: ClientFloor | null | undefined,
  client: { platform: string; buildNumber?: number | null | undefined },
): number | null {
  if (!floor || !Object.hasOwn(floor, client.platform)) return null;
  const min = floor[client.platform as keyof ClientFloor];
  return (client.buildNumber ?? 0) < min ? min : null;
}
