/**
 * The schema compatibility model (docs/decisions/managed-db.md MD-01…MD-12). Pure: no I/O, so it is unit-tested
 * on its own and shared by the migration authority, startup validation, `whombat schema-check`, doctor and
 * upgrade.
 *
 * Schema versions are positions in the migration journal, counted from 1, after the chain's `schemaBase`: this chain's
 * baseline replaced an older chain of 76 migrations, so it is version 77 and versions never go down
 * (docs/decisions/report-trackers.md). A position stays an index into the chain's migrations; versions stored or
 * compared (`schema_versions`, floors, `target`) are base + position. Every migration declares, in
 * `migrations/compat.json`:
 *
 * - its **class**: `expand` (additive: old binaries keep reading and writing), `backfill` (a resumable,
 *   checkpointed data migration run by the migration authority after the schema change commits), `contract`
 *   (removes or tightens something older binaries use), `incompatible` (only this version and newer can read or
 *   write), or `legacy` (migrations written before this model, none since the baseline: treated as `incompatible`);
 * - its **reader** and **writer** floors: the oldest binary schema version that can still safely read, and
 *   safely write, the schema this migration produces. A schema's floors are the maximum over its migrations.
 *
 * The migration authority records each applied migration's class and floors in the database
 * (`whombat_meta.schema_versions`), so a binary that doesn't know a newer migration can still tell whether it
 * may read or write the schema a newer binary left behind: that is what makes rolling back code after an
 * additive migration safe, and rolling back after a contract migration a read-only (or refused) start.
 *
 * A binary declares what it needs of an older schema (`runtime.readsFrom` / `runtime.writesFrom`, normally its
 * own newest migration): a database behind that is `migration_required`. PostgreSQL majors are a separate class
 * (`postgres.majors`): routine migration never crosses one and startup refuses an unsupported server.
 */

export const MIGRATION_CLASSES = ['expand', 'backfill', 'contract', 'incompatible', 'legacy'] as const;
export type MigrationClass = (typeof MIGRATION_CLASSES)[number];

/** Classes whose migration narrows who may write: applied only after a consistent checkpoint (MD-06). */
export const CHECKPOINT_CLASSES: readonly MigrationClass[] = ['contract', 'incompatible'];

/** One entry of `compat.json` as written by the author (tags, not numbers). */
export interface CompatEntryInput {
  class: MigrationClass;
  /** Oldest binary schema (a migration tag) that can read the schema this migration produces. */
  readers?: string;
  /** Oldest binary schema (a migration tag) that can write it. */
  writers?: string;
  /** `backfill` only: the registered backfill (db/backfills.ts) to run to completion after the schema change. */
  backfill?: string;
  note?: string;
}

export interface CompatManifestInput {
  format: 1;
  /** The version before this chain's first migration (absent: 0). */
  schemaBase?: number;
  postgres: { majors: number[] };
  runtime: { readsFrom: string; writesFrom: string };
  migrations: Record<string, CompatEntryInput>;
}

/** A migration's resolved compatibility (versions are journal positions, from 1). */
export interface MigrationCompat {
  version: number;
  tag: string;
  class: MigrationClass;
  readers: number;
  writers: number;
  backfill: string | null;
}

/** What this binary is and declares. */
export interface BinarySchema {
  /** Its newest migration's version: base + position (the base alone: no migrations). */
  version: number;
  /** The version before its chain's first migration (`compat.json`'s `schemaBase`). */
  base: number;
  tag: string | null;
  /** Its migrations, resolved, in order (index i = version base + i + 1). */
  migrations: MigrationCompat[];
  /** Hash and journal `when` of each migration, to recognise its history in a database. */
  identities: { tag: string; hash: string; when: number }[];
  /** The oldest schema it can read / write (normally its own version). */
  readsFrom: number;
  writesFrom: number;
  postgresMajors: number[];
}

export class CompatManifestError extends Error {
  override name = 'CompatManifestError';
}

/**
 * Resolves and validates `compat.json` against the journal's tags (in order). Every migration needs an entry;
 * the floors must name migrations at or before it; the class rules of MD-03 hold.
 */
export function resolveCompat(
  manifest: CompatManifestInput,
  identities: readonly { tag: string; hash: string; when: number }[],
): BinarySchema {
  const problems: string[] = [];
  if (manifest?.format !== 1) throw new CompatManifestError('compat.json: format must be 1');
  const base = manifest.schemaBase ?? 0;
  if (!Number.isInteger(base) || base < 0)
    throw new CompatManifestError('compat.json: schemaBase is a version (0 or more)');
  const position = new Map(identities.map((m, i) => [m.tag, base + i + 1]));
  const at = (tag: string | undefined, what: string, max: number): number | null => {
    if (tag === undefined) return null;
    const v = position.get(tag);
    if (v === undefined) {
      problems.push(`${what}: ${tag} isn’t a migration of this build`);
      return null;
    }
    if (v > max) problems.push(`${what}: ${tag} is newer than the migration itself`);
    return v;
  };
  const known = new Set(identities.map((m) => m.tag));
  for (const tag of Object.keys(manifest.migrations ?? {}))
    if (!known.has(tag)) problems.push(`${tag}: in compat.json but not in the journal`);
  let seenModern = false;
  const migrations: MigrationCompat[] = identities.map((m, i) => {
    const version = base + i + 1;
    const entry = manifest.migrations?.[m.tag];
    if (!entry) {
      problems.push(`${m.tag}: no entry (every migration declares its class, readers and writers)`);
      return {
        version,
        tag: m.tag,
        class: 'incompatible',
        readers: version,
        writers: version,
        backfill: null,
      };
    }
    if (!MIGRATION_CLASSES.includes(entry.class)) {
      problems.push(
        `${m.tag}: class ${String(entry.class)} isn’t one of ${MIGRATION_CLASSES.join(', ')}${String(entry.class) === 'pg-major' ? ' (PostgreSQL major upgrades are not routine migrations)' : ''}`,
      );
      return {
        version,
        tag: m.tag,
        class: 'incompatible',
        readers: version,
        writers: version,
        backfill: null,
      };
    }
    if (entry.class === 'legacy') {
      if (seenModern) problems.push(`${m.tag}: legacy after a declared migration`);
      if (entry.readers !== undefined || entry.writers !== undefined)
        problems.push(`${m.tag}: legacy migrations declare no floors (they are their own)`);
      return { version, tag: m.tag, class: 'legacy', readers: version, writers: version, backfill: null };
    }
    seenModern = true;
    const readers = at(entry.readers, `${m.tag} readers`, version);
    const writers = at(entry.writers, `${m.tag} writers`, version);
    if (readers === null || writers === null) {
      if (entry.readers === undefined || entry.writers === undefined)
        problems.push(`${m.tag}: readers and writers are required`);
      return { version, tag: m.tag, class: entry.class, readers: version, writers: version, backfill: null };
    }
    if (readers > writers) problems.push(`${m.tag}: readers (${entry.readers}) newer than writers`);
    switch (entry.class) {
      case 'expand':
        if (writers >= version || readers >= version)
          problems.push(
            `${m.tag}: an expand migration keeps the previous schema’s readers and writers (floors before it)`,
          );
        break;
      case 'incompatible':
        if (readers !== version || writers !== version)
          problems.push(`${m.tag}: an incompatible migration’s readers and writers are itself`);
        break;
      case 'backfill':
        if (!entry.backfill) problems.push(`${m.tag}: a backfill migration names its backfill`);
        if (readers >= version) problems.push(`${m.tag}: a backfill keeps the previous schema’s readers`);
        break;
      case 'contract':
        // Its floors name the first schema whose code no longer uses what it removes (MD-04); any value up to
        // itself is legitimate, and applying it always needs a checkpoint.
        break;
    }
    if (entry.class !== 'backfill' && entry.backfill)
      problems.push(`${m.tag}: only backfill migrations name a backfill`);
    return { version, tag: m.tag, class: entry.class, readers, writers, backfill: entry.backfill ?? null };
  });
  const latest = base + identities.length;
  const readsFrom = at(manifest.runtime?.readsFrom, 'runtime.readsFrom', latest) ?? latest;
  const writesFrom = at(manifest.runtime?.writesFrom, 'runtime.writesFrom', latest) ?? latest;
  if (readsFrom > writesFrom) problems.push('runtime: readsFrom newer than writesFrom');
  const majors = manifest.postgres?.majors ?? [];
  if (!majors.length || majors.some((n) => !Number.isInteger(n) || n < 10))
    problems.push('postgres.majors: the PostgreSQL majors this build supports, e.g. [17]');
  if (problems.length) throw new CompatManifestError(`compat.json:\n  ${problems.join('\n  ')}`);
  return {
    version: latest,
    base,
    tag: identities.at(-1)?.tag ?? null,
    migrations,
    identities: identities.map((m) => ({ tag: m.tag, hash: m.hash, when: m.when })),
    readsFrom,
    writesFrom,
    postgresMajors: majors,
  };
}

/** A row of drizzle's bookkeeping: what the database applied, oldest first. */
export interface AppliedRow {
  hash: string;
  createdAt: number;
}

/** A row of `whombat_meta.schema_versions`: the compatibility the migration authority recorded. */
export interface RecordedCompat {
  version: number;
  tag: string;
  hash: string;
  class: string;
  readers: number;
  writers: number;
}

/** What a database is, read without changing it. */
export interface DatabaseSchemaState {
  applied: AppliedRow[];
  recorded: RecordedCompat[];
  /** Backfills registered and not done (name and the migration that registered them). */
  pendingBackfills: { name: string; version: number }[];
  postgresMajor: number;
}

export type SchemaVerdict =
  /** Exactly this binary's schema: read and write. */
  | 'current'
  /** Behind this binary (pending migrations or backfills): the migration authority must run first. */
  | 'migration_required'
  /** A newer binary migrated it; its recorded floors let this one read and write. */
  | 'newer_compatible'
  /** A newer binary migrated it; this one may read but not write (maintenance/read-only). */
  | 'newer_read_only'
  /** A newer binary migrated it past what this one can read. */
  | 'newer_incompatible'
  /** Another history (a different file at a known position, or a newer migration with no recorded floors). */
  | 'foreign'
  /** The PostgreSQL server's major isn't one this build supports (a separate upgrade, MD-09). */
  | 'postgres_unsupported';

export type SchemaAccess = 'read-write' | 'read-only' | 'none';

/**
 * The schema a database is at once this binary's migration authority has run (MD-12): for `migration_required` this
 * binary's own schema, for `current` and the `newer_*` verdicts the database's (nothing to apply). Its floors are
 * computed as `database.readers`/`writers` are — the maximum over its migrations, this build's declarations for what
 * it knows and the recorded ones beyond — so an older binary of schema `s` can read it when `s ≥ readers` and write
 * it when `s ≥ writers`, exactly as that binary's own check will judge it after the migration. The appliance manager
 * decides with it whether a migrating candidate needs a checkpoint and what a rollback would leave (MA-11).
 */
export interface SchemaTarget {
  /** Journal position. */
  version: number;
  tag: string | null;
  /** The oldest binary schema that can read it. */
  readers: number;
  /** The oldest binary schema that can write it. */
  writers: number;
}

/** The machine-readable answer of startup validation and `whombat schema-check --json`. */
export interface SchemaCheck {
  format: 'whombat.schema-check/1';
  verdict: SchemaVerdict;
  /** What this binary may do on this database now. */
  access: SchemaAccess;
  binary: {
    version: number;
    tag: string | null;
    readsFrom: number;
    writesFrom: number;
    postgresMajors: number[];
  };
  database: {
    version: number;
    tag: string | null;
    /** Floors of the database's schema (max over its migrations); null when unknown. */
    readers: number | null;
    writers: number | null;
    postgresMajor: number;
    pendingBackfills: string[];
  };
  /** Migrations this binary would apply. */
  pending: string[];
  /** Of those, the ones that need a consistent checkpoint first (MD-06). */
  needsCheckpoint: string[];
  /** The schema the database is at after this binary's migration authority (MD-12); null for `foreign` and
   * `postgres_unsupported` (nothing this binary would run on). Added after `whombat.schema-check/1` was first
   * published: readers of the format treat it as optional. */
  target: SchemaTarget | null;
  /** One sentence: why. */
  reason: string;
  /** The exact way forward (empty when nothing is needed). */
  action: string;
}

/**
 * The first migration of the history the baseline replaced (docs/decisions/one-agent.md OA-20, OA-S83): `0000_init`,
 * as drizzle's bookkeeping recorded it (its file's hash, the journal's `when`) and as the migration authority recorded
 * its tag. A database whose history starts with it was made before the baseline (0000_init … 0138, 139 migrations)
 * and is refused, never migrated: nothing converts its data.
 */
export const PRE_BASELINE = {
  tag: '0000_init',
  hash: '2e589edd7ac6ea639851b5a10004e2c24933b5b145de45ba4d45225aa5286163',
  when: 1790162187492,
} as const;

/** Whether a history (drizzle's rows, and what the authority recorded) is from before the baseline. */
export function isPreBaseline(
  applied: readonly AppliedRow[],
  recorded: readonly RecordedCompat[] = [],
): boolean {
  const first = applied[0];
  if (!first) return false;
  return (
    first.hash === PRE_BASELINE.hash ||
    first.createdAt === PRE_BASELINE.when ||
    recorded.find((r) => r.version === 1)?.tag === PRE_BASELINE.tag
  );
}

/** Why a database from before the baseline is refused, and what to do instead (OA-S83). */
export const PRE_BASELINE_REFUSAL = {
  reason: (migrations: number) =>
    `the database was made before Whombat’s baseline: its ${migrations} migrations start with ${PRE_BASELINE.tag}, which one baseline replaced, and older databases aren’t converted`,
  action:
    'start this Whombat on a new, empty database (an appliance: a fresh install; development: a new DATABASE_URL) and leave the old one as it is (docs/decisions/one-agent.md OA-21)',
};

/**
 * The first migration of the chain this one's baseline replaced (`0000_baseline` of schema 1 … 76), as drizzle's
 * bookkeeping recorded it. Release 0.268.0 moved every database it ran on to this chain; a database still on the old
 * one never ran it, so this build refuses it and names that release (docs/upgrade.md).
 */
export const PRE_MOVE = {
  tag: '0000_baseline',
  hash: '83d3b2a4d42db257a1b4809355a3b107593cfa11907bb48448c565bc46dd31d9',
  when: 1792763095461,
} as const;

/** The release that moves a database of the older chain onto this one. */
export const MOVE_RELEASE = '0.268.0';

/** Whether a history is the chain before this one's baseline (refused: `PRE_MOVE_REFUSAL`). */
export function isPreMove(applied: readonly AppliedRow[]): boolean {
  const first = applied[0];
  return !!first && (first.hash === PRE_MOVE.hash || first.createdAt === PRE_MOVE.when);
}

/** Why a database of the older chain is refused, and what to do instead. */
export const PRE_MOVE_REFUSAL = {
  reason: (migrations: number) =>
    `the database is on the schema Whombat used before ${MOVE_RELEASE} (${migrations} migrations), and this version only runs on a database ${MOVE_RELEASE} has moved across`,
  action: `update this Whombat to ${MOVE_RELEASE} first and let it start once, which moves the database across, then update to this version; a backup made before ${MOVE_RELEASE} is restored with ${MOVE_RELEASE} first (docs/upgrade.md)`,
};

/** Legacy-compatible check: is the database's history a prefix of this binary's? */
function firstMismatch(applied: readonly AppliedRow[], binary: BinarySchema): number | null {
  const n = Math.min(applied.length, binary.identities.length);
  for (let i = 0; i < n; i++) {
    const row = applied[i] as AppliedRow;
    const m = binary.identities[i] as { hash: string; when: number };
    if (row.createdAt !== m.when || row.hash !== m.hash) return i;
  }
  return null;
}

/**
 * Decides what `binary` may do on a database in `state`. Never throws: every outcome is a verdict with a
 * reason and the way forward.
 */
export function evaluateSchema(state: DatabaseSchemaState, binary: BinarySchema): SchemaCheck {
  const chainBase = binary.base;
  // Positions in the chain: how many of its migrations the database applied; versions are base + position.
  const dPos = state.applied.length;
  const d = dPos === 0 ? 0 : chainBase + dPos;
  const b = binary.version;
  const tagOf = (v: number): string | null =>
    v === 0
      ? null
      : v > chainBase && v <= b
        ? (binary.identities[v - chainBase - 1]?.tag ?? null)
        : (state.recorded.find((r) => r.version === v)?.tag ?? null);
  const base = {
    format: 'whombat.schema-check/1' as const,
    binary: {
      version: b,
      tag: binary.tag,
      readsFrom: binary.readsFrom,
      writesFrom: binary.writesFrom,
      postgresMajors: binary.postgresMajors,
    },
    pending: [] as string[],
    needsCheckpoint: [] as string[],
    target: null as SchemaTarget | null,
  };
  const database = (readers: number | null, writers: number | null) => ({
    version: d,
    tag: tagOf(d),
    readers,
    writers,
    postgresMajor: state.postgresMajor,
    pendingBackfills: state.pendingBackfills.map((p) => p.name),
  });
  const name = (v: number | null) => (v ? (tagOf(v) ?? `schema ${v}`) : 'no schema');

  if (!binary.postgresMajors.includes(state.postgresMajor))
    return {
      ...base,
      verdict: 'postgres_unsupported',
      access: 'none',
      database: database(null, null),
      reason: `the database server is PostgreSQL ${state.postgresMajor}; this build supports ${binary.postgresMajors.join(', ')}`,
      action:
        'PostgreSQL major upgrades are not routine migrations: back up, move the data to a supported PostgreSQL major (docs/upgrade.md), then start again',
    };

  const mismatch = firstMismatch(state.applied, binary);
  if (mismatch === 0 && isPreMove(state.applied))
    return {
      ...base,
      verdict: 'foreign',
      access: 'none',
      // Its own chain numbered from 0: the version it is at there.
      database: {
        ...database(null, null),
        version: dPos,
        tag: state.recorded.find((r) => r.version === dPos)?.tag ?? null,
      },
      reason: PRE_MOVE_REFUSAL.reason(dPos),
      action: PRE_MOVE_REFUSAL.action,
    };
  if (mismatch === 0 && isPreBaseline(state.applied, state.recorded))
    return {
      ...base,
      verdict: 'foreign',
      access: 'none',
      database: database(null, null),
      reason: PRE_BASELINE_REFUSAL.reason(dPos),
      action: PRE_BASELINE_REFUSAL.action,
    };
  if (mismatch !== null)
    return {
      ...base,
      verdict: 'foreign',
      access: 'none',
      database: database(null, null),
      reason: `migration ${mismatch + 1} of the database isn’t this build’s ${binary.identities[mismatch]?.tag} (a database from another version history)`,
      action:
        'run the Whombat that last migrated this database (whombat version there), or restore a backup made for this version (docs/upgrade.md)',
    };

  // Floors of the database's schema: this build's declarations for what it knows, the recorded ones beyond.
  let readers = 0;
  let writers = 0;
  for (let p = 1; p <= dPos; p++) {
    const v = chainBase + p;
    const known = v <= b ? binary.migrations[p - 1] : undefined;
    const rec = known ? null : state.recorded.find((r) => r.version === v);
    if (!known && !rec)
      return {
        ...base,
        verdict: 'foreign',
        access: 'none',
        database: database(null, null),
        reason: `the database has migration ${v}, which this build doesn’t know and whose compatibility wasn’t recorded (migrated by a Whombat from before the compatibility model, or another tool)`,
        action:
          'run the Whombat that last migrated this database, or restore a backup made for this version (docs/upgrade.md)',
      };
    readers = Math.max(readers, known ? known.readers : (rec as RecordedCompat).readers);
    writers = Math.max(writers, known ? known.writers : (rec as RecordedCompat).writers);
  }

  if (d > b) {
    const canRead = b >= readers;
    const canWrite = b >= writers;
    const newest = name(d);
    // Nothing to apply: the database stays at its own schema.
    const newer = { ...base, target: { version: d, tag: tagOf(d), readers, writers } };
    if (canRead && canWrite)
      return {
        ...newer,
        verdict: 'newer_compatible',
        access: 'read-write',
        database: database(readers, writers),
        reason: `a newer Whombat migrated the database to ${newest}; its migrations since ${name(b)} keep this version able to read and write`,
        action: '',
      };
    if (canRead)
      return {
        ...newer,
        verdict: 'newer_read_only',
        access: 'read-only',
        database: database(readers, writers),
        reason: `a newer Whombat migrated the database to ${newest}; since ${name(writers)} this version may only read it`,
        action: `run a Whombat whose schema is at least ${name(writers)} (the one that migrated it) to write again; this version starts read-only`,
      };
    return {
      ...newer,
      verdict: 'newer_incompatible',
      access: 'none',
      database: database(readers, writers),
      reason: `a newer Whombat migrated the database to ${newest}, which this version (${name(b)}) can’t read`,
      action: `run a Whombat whose schema is at least ${name(readers)}, or restore a backup made for this version (docs/upgrade.md)`,
    };
  }

  // d <= b: what this binary would apply, and whether its code can use the schema as it is.
  const pending = binary.migrations.slice(dPos);
  const needsCheckpoint =
    dPos === 0 ? [] : pending.filter((m) => CHECKPOINT_CLASSES.includes(m.class)).map((m) => m.tag);
  // A known migration whose backfill hasn't finished counts as not there yet for this binary's own needs.
  const unfinished = state.pendingBackfills.filter((p) => p.version <= b).map((p) => p.version);
  const effective = unfinished.length ? Math.min(d, Math.min(...unfinished) - 1) : d;
  // The schema the migration authority leaves: this binary's. Its migrations up to d are the database's (the
  // history check above), so its own declarations are the floors the database will carry (MD-12).
  let targetReaders = readers;
  let targetWriters = writers;
  for (const m of pending) {
    targetReaders = Math.max(targetReaders, m.readers);
    targetWriters = Math.max(targetWriters, m.writers);
  }
  const withPending = {
    ...base,
    pending: pending.map((m) => m.tag),
    needsCheckpoint,
    target: { version: b, tag: binary.tag, readers: targetReaders, writers: targetWriters },
  };
  if (effective === b)
    return {
      ...withPending,
      verdict: 'current',
      access: 'read-write',
      database: database(readers, writers),
      reason: `the database is at this build’s schema ${name(b)}`,
      action: '',
    };
  const access: SchemaAccess =
    effective >= binary.writesFrom ? 'read-write' : effective >= binary.readsFrom ? 'read-only' : 'none';
  const what = [
    pending.length
      ? `${pending.length} migration${pending.length > 1 ? 's' : ''} (${pending.map((m) => m.tag).join(', ')})`
      : '',
    unfinished.length
      ? `unfinished backfill${unfinished.length > 1 ? 's' : ''} (${state.pendingBackfills.map((p) => p.name).join(', ')})`
      : '',
  ]
    .filter(Boolean)
    .join(' and ');
  return {
    ...withPending,
    verdict: 'migration_required',
    access,
    database: database(readers, writers),
    reason: `the database (${name(d)}) is behind this build (${name(b)}): ${what} to apply`,
    action: needsCheckpoint.length
      ? `quiesce writes and take a consistent checkpoint (backup), then run the migration authority with it: whombat migrate --checkpoint <backup> (${needsCheckpoint.join(', ')} narrow who may write)`
      : 'run the migration authority: whombat migrate (the appliance manager’s migration step; in development the server’s boot)',
  };
}

/** Exit codes of `whombat schema-check` and `whombat migrate --json` (MD-10). */
export const SCHEMA_EXIT = {
  ok: 0,
  error: 1,
  migrationRequired: 10,
  readOnly: 11,
  refused: 12,
  checkpointRequired: 13,
  lockTimeout: 14,
} as const;

export function schemaExitCode(check: SchemaCheck): number {
  if (check.verdict === 'migration_required') return SCHEMA_EXIT.migrationRequired;
  if (check.access === 'read-write') return SCHEMA_EXIT.ok;
  if (check.access === 'read-only') return SCHEMA_EXIT.readOnly;
  return SCHEMA_EXIT.refused;
}
