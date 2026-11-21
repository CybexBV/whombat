/**
 * The schema compatibility model (docs/decisions/managed-db.md MD-01…MD-09, MD-12), pure: compat.json validation,
 * every verdict of `evaluateSchema`, the refusal of a database from before the baseline (one-agent.md OA-S83) and of one
 * still on the chain this one's baseline replaced. The database-backed behaviour is in compat.int.test.ts.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type BinarySchema,
  type CompatEntryInput,
  CompatManifestError,
  type CompatManifestInput,
  type DatabaseSchemaState,
  evaluateSchema,
  isPreBaseline,
  isPreMove,
  MOVE_RELEASE,
  PRE_BASELINE,
  PRE_MOVE,
  type RecordedCompat,
  resolveCompat,
  SCHEMA_EXIT,
  schemaExitCode,
} from './compat';

const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    tag: `${String(i).padStart(4, '0')}_m${i}`,
    hash: `h${i}`,
    when: 1000 + i,
  }));

function manifest(
  n: number,
  extra: Record<string, CompatEntryInput> = {},
  runtime?: CompatManifestInput['runtime'],
): CompatManifestInput {
  const list = ids(n);
  const migrations: Record<string, CompatEntryInput> = {};
  for (const m of list.slice(0, 3)) migrations[m.tag] = { class: 'legacy' };
  Object.assign(migrations, extra);
  return {
    format: 1,
    postgres: { majors: [17] },
    runtime: runtime ?? { readsFrom: list.at(-1)?.tag as string, writesFrom: list.at(-1)?.tag as string },
    migrations,
  };
}

const T = (i: number) => `${String(i).padStart(4, '0')}_m${i}`;

/** Binary with 3 legacy + an expand (v4) + a contract (v5, writers v5, readers v3) + incompatible (v6). */
function binaryUpTo(n: number): BinarySchema {
  const all: Record<string, CompatEntryInput> = {
    [T(3)]: { class: 'expand', readers: T(2), writers: T(2) },
    [T(4)]: { class: 'contract', readers: T(2), writers: T(4) },
    [T(5)]: { class: 'incompatible', readers: T(5), writers: T(5) },
  };
  const extra = Object.fromEntries(Object.entries(all).filter(([tag]) => Number(tag.slice(0, 4)) < n));
  return resolveCompat(manifest(n, extra), ids(n));
}

/** The database a binary of `n` migrations left: drizzle rows and the recorded compatibility. */
function stateOf(binary: BinarySchema, overrides: Partial<DatabaseSchemaState> = {}): DatabaseSchemaState {
  return {
    applied: binary.identities.map((m) => ({ hash: m.hash, createdAt: m.when })),
    recorded: binary.migrations.map(
      (m): RecordedCompat => ({
        version: m.version,
        tag: m.tag,
        hash: binary.identities[m.version - 1]?.hash as string,
        class: m.class,
        readers: m.readers,
        writers: m.writers,
      }),
    ),
    pendingBackfills: [],
    postgresMajor: 17,
    ...overrides,
  };
}

/** This checkout's migrations and compat.json, cut after `tag` (a build whose newest migration is `tag`). */
function shippedUpTo(tag: string): BinarySchema {
  const dir = join(import.meta.dirname, 'migrations');
  const journal = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string; when: number }[];
  };
  const shipped = JSON.parse(readFileSync(join(dir, 'compat.json'), 'utf8')) as CompatManifestInput;
  const n = journal.entries.findIndex((e) => e.tag === tag) + 1;
  expect(n).toBeGreaterThan(0);
  const list = journal.entries.slice(0, n).map((e, i) => ({ tag: e.tag, hash: `h${i}`, when: e.when }));
  const migrations = Object.fromEntries(
    list.map((m) => [m.tag, shipped.migrations[m.tag] as CompatEntryInput]),
  );
  return resolveCompat({ ...shipped, runtime: { readsFrom: tag, writesFrom: tag }, migrations }, list);
}

describe('resolveCompat: the rules authors follow (MD-03)', () => {
  it('refuses a migration without an entry, a pg-major class, floors after the migration and a bad expand', () => {
    const problems = (m: CompatManifestInput, n = 5) => {
      try {
        resolveCompat(m, ids(n));
        return '';
      } catch (err) {
        expect(err).toBeInstanceOf(CompatManifestError);
        return (err as Error).message;
      }
    };
    expect(problems(manifest(5, { [T(3)]: { class: 'expand', readers: T(2), writers: T(2) } }))).toMatch(
      /0004_m4: no entry/,
    );
    expect(
      problems(manifest(4, { [T(3)]: { class: 'pg-major' as never, readers: T(2), writers: T(2) } }), 4),
    ).toMatch(/PostgreSQL major upgrades are not routine migrations/);
    expect(problems(manifest(4, { [T(3)]: { class: 'contract', readers: T(2), writers: T(5) } }), 4)).toMatch(
      /isn’t a migration of this build/,
    );
    expect(problems(manifest(4, { [T(3)]: { class: 'expand', readers: T(2), writers: T(3) } }), 4)).toMatch(
      /an expand migration keeps the previous schema’s readers and writers/,
    );
    expect(
      problems(manifest(4, { [T(3)]: { class: 'incompatible', readers: T(2), writers: T(3) } }), 4),
    ).toMatch(/an incompatible migration’s readers and writers are itself/);
    expect(problems(manifest(4, { [T(3)]: { class: 'backfill', readers: T(2), writers: T(2) } }), 4)).toMatch(
      /names its backfill/,
    );
    expect(problems(manifest(4), 4)).toMatch(/0003_m3: no entry/);
    expect(
      problems(
        manifest(5, {
          [T(3)]: { class: 'expand', readers: T(2), writers: T(2) },
          [T(4)]: { class: 'legacy' },
        }),
      ),
    ).toMatch(/0004_m4: legacy after a declared migration/);
    expect(
      problems(
        {
          ...manifest(4, { [T(3)]: { class: 'expand', readers: T(2), writers: T(2) } }),
          postgres: { majors: [] },
        },
        4,
      ),
    ).toMatch(/postgres\.majors/);
  });
});

describe('evaluateSchema: what a binary may do on a database', () => {
  it('old binary, newer schema after an expand: reads and writes (rollback after an additive migration)', () => {
    const check = evaluateSchema(stateOf(binaryUpTo(4)), binaryUpTo(3));
    expect(check).toMatchObject({ verdict: 'newer_compatible', access: 'read-write' });
    expect(check.database).toMatchObject({ version: 4, tag: T(3), readers: 3, writers: 3 });
  });

  it('old binary, newer schema after a contract: read-only with the reason', () => {
    const check = evaluateSchema(stateOf(binaryUpTo(5)), binaryUpTo(4));
    expect(check).toMatchObject({ verdict: 'newer_read_only', access: 'read-only' });
    expect(check.reason).toMatch(new RegExp(`since ${T(4)} this version may only read it`));
    expect(schemaExitCode(check)).toBe(SCHEMA_EXIT.readOnly);
    // Two schemas older: also below the reader floor? The contract's readers are v3, so v3 still reads.
    expect(evaluateSchema(stateOf(binaryUpTo(5)), binaryUpTo(3)).access).toBe('read-only');
  });

  it('old binary, newer schema after an incompatible migration: refused', () => {
    const check = evaluateSchema(stateOf(binaryUpTo(6)), binaryUpTo(5));
    expect(check).toMatchObject({ verdict: 'newer_incompatible', access: 'none' });
    expect(check.action).toMatch(new RegExp(`at least ${T(5)}`));
    expect(schemaExitCode(check)).toBe(SCHEMA_EXIT.refused);
  });

  it('a newer migration nobody recorded (a pre-model binary, another tool) is foreign', () => {
    const state = stateOf(binaryUpTo(4));
    state.recorded = state.recorded.filter((r) => r.version !== 4);
    const check = evaluateSchema(state, binaryUpTo(3));
    expect(check.verdict).toBe('foreign');
    expect(check.reason).toMatch(/whose compatibility wasn’t recorded/);
  });

  it('another history is foreign', () => {
    const b = binaryUpTo(4);
    const state = stateOf(b);
    state.applied[1] = { hash: 'other', createdAt: state.applied[1]?.createdAt as number };
    expect(evaluateSchema(state, b)).toMatchObject({ verdict: 'foreign', access: 'none' });
  });

  it('an unfinished backfill of a known migration counts as not migrated for that binary', () => {
    const extra = { [T(3)]: { class: 'backfill' as const, readers: T(2), writers: T(3), backfill: 'fill' } };
    const b = resolveCompat(manifest(4, extra), ids(4));
    const state = stateOf(b, { pendingBackfills: [{ name: 'fill', version: 4 }] });
    const check = evaluateSchema(state, b);
    expect(check).toMatchObject({ verdict: 'migration_required', access: 'none', pending: [] });
    expect(check.reason).toMatch(/unfinished backfill \(fill\)/);
    // The binary before it judges by the floors only: v3 may read and write (writers v4 → no, only read).
    expect(evaluateSchema(state, binaryUpTo(3)).access).toBe('read-only');
  });

  it('a binary that reads an older schema starts read-only on it before migrating', () => {
    const b = resolveCompat(
      manifest(
        4,
        { [T(3)]: { class: 'expand', readers: T(2), writers: T(2) } },
        { readsFrom: T(2), writesFrom: T(3) },
      ),
      ids(4),
    );
    expect(evaluateSchema(stateOf(binaryUpTo(3)), b)).toMatchObject({
      verdict: 'migration_required',
      access: 'read-only',
    });
  });

  it('an unsupported PostgreSQL major is a separate upgrade, never a routine migration', () => {
    const b = binaryUpTo(4);
    const check = evaluateSchema(stateOf(b, { postgresMajor: 16 }), b);
    expect(check).toMatchObject({ verdict: 'postgres_unsupported', access: 'none', target: null });
    expect(check.action).toMatch(/not routine migrations/);
  });
});

describe('the target schema and its floors (MD-12): what a rollback after migrating would find', () => {
  it('an expand pending: the target keeps the floors of the schema before it, so the old binary writes it', () => {
    const check = evaluateSchema(stateOf(binaryUpTo(3)), binaryUpTo(4));
    expect(check).toMatchObject({ verdict: 'migration_required', needsCheckpoint: [] });
    expect(check.target).toEqual({ version: 4, tag: T(3), readers: 3, writers: 3 });
    // The binary of schema 3 on the migrated database: its own check agrees with the floors.
    const after = evaluateSchema(stateOf(binaryUpTo(4)), binaryUpTo(3));
    expect(after.access).toBe('read-write');
    expect(after.database).toMatchObject({ readers: check.target?.readers, writers: check.target?.writers });
  });

  it('a contract pending: writers are the contract itself, the old binary may only read; it needs a checkpoint', () => {
    const check = evaluateSchema(stateOf(binaryUpTo(4)), binaryUpTo(5));
    expect(check.needsCheckpoint).toEqual([T(4)]);
    expect(check.target).toEqual({ version: 5, tag: T(4), readers: 3, writers: 5 });
    expect(evaluateSchema(stateOf(binaryUpTo(5)), binaryUpTo(4)).access).toBe('read-only');
  });

  it('several pending: the maximum over them, as the database will record it', () => {
    const check = evaluateSchema(stateOf(binaryUpTo(3)), binaryUpTo(6));
    expect(check.pending).toEqual([T(3), T(4), T(5)]);
    expect(check.target).toEqual({ version: 6, tag: T(5), readers: 6, writers: 6 });
  });

  it('an empty database: the target is this binary’s schema', () => {
    const b = binaryUpTo(4);
    const check = evaluateSchema({ applied: [], recorded: [], pendingBackfills: [], postgresMajor: 17 }, b);
    expect(check.target).toEqual({ version: 4, tag: T(3), readers: 3, writers: 3 });
  });

  it('current and newer schemas: nothing to apply, the target is the database; foreign: none', () => {
    expect(evaluateSchema(stateOf(binaryUpTo(4)), binaryUpTo(4)).target).toEqual({
      version: 4,
      tag: T(3),
      readers: 3,
      writers: 3,
    });
    expect(evaluateSchema(stateOf(binaryUpTo(5)), binaryUpTo(4)).target).toEqual({
      version: 5,
      tag: T(4),
      readers: 3,
      writers: 5,
    });
    const b = binaryUpTo(4);
    const state = stateOf(b);
    state.applied[1] = { hash: 'other', createdAt: state.applied[1]?.createdAt as number };
    expect(evaluateSchema(state, b).target).toBeNull();
  });

  it('the shipped compat.json: one baseline after the chain it replaced, its own floors; a new database takes it without a checkpoint', () => {
    const shipped = shippedUpTo('0000_baseline');
    expect(shipped.base).toBe(76);
    expect(shipped.migrations).toEqual([
      expect.objectContaining({
        version: 77,
        tag: '0000_baseline',
        class: 'incompatible',
        readers: 77,
        writers: 77,
      }),
    ]);
    const check = evaluateSchema(
      { applied: [], recorded: [], pendingBackfills: [], postgresMajor: 17 },
      shipped,
    );
    expect(check).toMatchObject({
      verdict: 'migration_required',
      pending: ['0000_baseline'],
      needsCheckpoint: [],
    });
    expect(check.target).toEqual({ version: 77, tag: '0000_baseline', readers: 77, writers: 77 });
  });
});

describe('a database from before the baseline (one-agent.md OA-S83)', () => {
  /** What a database migrated by 0000_init … 0138 looks like: 139 rows, the first one 0000_init's. */
  const old = (
    recordedTag: string | null,
    first: { hash: string; createdAt: number } = { hash: PRE_BASELINE.hash, createdAt: PRE_BASELINE.when },
  ): DatabaseSchemaState => ({
    applied: [
      first,
      ...Array.from({ length: 138 }, (_, i) => ({ hash: `old${i}`, createdAt: PRE_BASELINE.when + i + 1 })),
    ],
    recorded: recordedTag
      ? [{ version: 1, tag: recordedTag, hash: first.hash, class: 'legacy', readers: 1, writers: 1 }]
      : [],
    pendingBackfills: [],
    postgresMajor: 17,
  });

  it('is refused with its own reason and the way forward, never migrated', () => {
    const shipped = shippedUpTo('0000_baseline');
    for (const state of [old('0000_init'), old(null), old('0000_init', { hash: 'edited', createdAt: 1 })]) {
      expect(isPreBaseline(state.applied, state.recorded)).toBe(true);
      const check = evaluateSchema(state, shipped);
      expect(check).toMatchObject({ verdict: 'foreign', access: 'none', pending: [], target: null });
      expect(check.reason).toMatch(/before Whombat’s baseline: its 139 migrations start with 0000_init/);
      expect(check.action).toMatch(/new, empty database/);
      expect(schemaExitCode(check)).toBe(SCHEMA_EXIT.refused);
    }
  });

  it('another history that isn’t the old one keeps the general answer', () => {
    const b = binaryUpTo(4);
    const state = stateOf(b);
    state.applied[0] = { hash: 'other', createdAt: 5 };
    expect(isPreBaseline(state.applied, state.recorded)).toBe(false);
    expect(evaluateSchema(state, b).reason).toMatch(/migration 1 of the database isn’t this build’s/);
  });
});

describe('a database of the chain this one’s baseline replaced', () => {
  /** A database on the older chain at its last version (76): the first row its `0000_baseline`'s. */
  const older = (positions = 76): DatabaseSchemaState => ({
    applied: [
      { hash: PRE_MOVE.hash, createdAt: PRE_MOVE.when },
      ...Array.from({ length: positions - 1 }, (_, i) => ({
        hash: `older${i}`,
        createdAt: PRE_MOVE.when + i + 1,
      })),
    ],
    recorded: Array.from({ length: positions }, (_, i) => ({
      version: i + 1,
      tag: i === 0 ? PRE_MOVE.tag : `older_${i + 1}`,
      hash: i === 0 ? PRE_MOVE.hash : `older${i - 1}`,
      class: 'expand',
      readers: 1,
      writers: 1,
    })),
    pendingBackfills: [],
    postgresMajor: 17,
  });

  it('is refused, naming the release that moves it across, never migrated', () => {
    const shipped = shippedUpTo('0000_baseline');
    expect(shipped.version).toBe(77);
    for (const positions of [76, 40, 1]) {
      const state = older(positions);
      expect(isPreMove(state.applied)).toBe(true);
      const check = evaluateSchema(state, shipped);
      expect(check).toMatchObject({ verdict: 'foreign', access: 'none', pending: [], target: null });
      expect(check.database.version).toBe(positions);
      expect(check.reason).toContain(MOVE_RELEASE);
      expect(check.action).toContain(`${MOVE_RELEASE} first`);
      expect(schemaExitCode(check)).toBe(SCHEMA_EXIT.refused);
    }
  });

  it('one that release moved across is current', () => {
    const shipped = shippedUpTo('0000_baseline');
    const moved: DatabaseSchemaState = {
      applied: [{ hash: 'h0', createdAt: shipped.identities[0]?.when as number }],
      recorded: [
        { version: 77, tag: '0000_baseline', hash: 'h0', class: 'incompatible', readers: 77, writers: 77 },
      ],
      pendingBackfills: [],
      postgresMajor: 17,
    };
    expect(isPreMove(moved.applied)).toBe(false);
    expect(evaluateSchema(moved, shipped)).toMatchObject({
      verdict: 'current',
      access: 'read-write',
      database: { version: 77, tag: '0000_baseline' },
    });
  });

  it('isn’t this checkout’s baseline', () => {
    const text = readFileSync(join(import.meta.dirname, 'migrations', '0000_baseline.sql'));
    const hash = createHash('sha256').update(text).digest('hex');
    expect(hash).not.toBe(PRE_MOVE.hash);
  });
});
