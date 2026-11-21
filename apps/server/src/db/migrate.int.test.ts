/**
 * The migration lock (docs/decisions/bp-distribution.md BP-F05): two migrators at once apply every migration
 * exactly once; a held lock makes the next one wait and then give up with the holder named; a failing
 * migration changes nothing; drizzle's bookkeeping stays interchangeable with drizzle's own migrator; a history
 * that isn't a prefix of this build's is refused (a backup from before the baseline, or of the chain before it, with its
 * own reason).
 */
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { MOVE_RELEASE, PRE_BASELINE, PRE_MOVE } from './compat';
import {
  appliedMigrations,
  MIGRATION_LOCK,
  MIGRATIONS_FOLDER,
  type Migration,
  MigrationLockTimeout,
  readMigrations,
  runMigrations,
  schemaCompatibility,
} from './migrate';

const base = loadConfig().DATABASE_URL;
const names: string[] = [];
const pools: postgres.Sql[] = [];
const dirs: string[] = [];

async function admin(statement: string) {
  const conn = postgres(base, { max: 1, onnotice: () => {} });
  try {
    await conn.unsafe(statement);
  } finally {
    await conn.end({ timeout: 5 });
  }
}

async function freshDb(): Promise<string> {
  const name = `whombat_test_mig_${randomBytes(5).toString('hex')}`;
  await admin(`create database "${name}"`);
  names.push(name);
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

function pool(url: string, max = 1): postgres.Sql {
  const sql = postgres(url, { max, onnotice: () => {} });
  pools.push(sql);
  return sql;
}

/** A copy of the migrations folder, changed by `edit(journal entries, dir)`. */
function folderWith(edit: (dir: string, journal: { entries: Record<string, unknown>[] }) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'whombat-migrations-'));
  dirs.push(dir);
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const path = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(path, 'utf8'));
  edit(dir, journal);
  writeFileSync(path, JSON.stringify(journal));
  return dir;
}

/** Two small additive migrations after this build's (a later build). */
const MORE = [
  { tag: '9001_mig_note', sql: 'ALTER TABLE "accounts" ADD COLUMN "mig_note" text;' },
  { tag: '9002_mig_index', sql: 'CREATE INDEX "accounts_mig_note_idx" ON "accounts" ("mig_note");' },
];

/** This build's migrations followed by `MORE`, each with its journal and compat.json entry. */
function withMore(): string {
  return folderWith((dir, journal) => {
    const compatPath = join(dir, 'compat.json');
    const compat = JSON.parse(readFileSync(compatPath, 'utf8'));
    const base = all.at(-1)?.tag;
    for (const [i, m] of MORE.entries()) {
      const last = journal.entries.at(-1) as { idx: number; when: number };
      journal.entries.push({
        idx: last.idx + 1,
        version: '7',
        when: last.when + 1000,
        tag: m.tag,
        breakpoints: true,
      });
      writeFileSync(join(dir, `${m.tag}.sql`), m.sql);
      compat.migrations[m.tag] = { class: 'expand', readers: base, writers: base };
      if (i === MORE.length - 1) compat.runtime = { readsFrom: m.tag, writesFrom: m.tag };
    }
    writeFileSync(compatPath, JSON.stringify(compat));
  });
}

afterAll(async () => {
  for (const p of pools) await p.end({ timeout: 5 }).catch(() => {});
  for (const n of names) await admin(`drop database if exists "${n}" with (force)`);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const all = readMigrations();

describe('runMigrations', () => {
  it('two migrators at once: every migration applied exactly once', async () => {
    const url = await freshDb();
    const [a, b] = await Promise.all([runMigrations(pool(url)), runMigrations(pool(url))]);
    const applied = [...a.applied, ...b.applied];
    expect(applied.sort()).toEqual(all.map((m) => m.tag).sort());
    // One of them did all the work, the other found nothing left.
    expect([a.applied.length, b.applied.length].sort((x, y) => x - y)).toEqual([0, all.length]);
    expect(a.latest).toBe(all.at(-1)?.tag);
    expect(b.latest).toBe(all.at(-1)?.tag);
    const rows = await appliedMigrations(pool(url));
    expect(rows).toHaveLength(all.length);
    expect(schemaCompatibility(rows, all)).toEqual({ ok: true, applied: all.length, pending: [] });
  });

  it('waits for a held lock, tells who holds it, then gives up with a clear message', async () => {
    const url = await freshDb();
    const holder = pool(url);
    const release = (() => {
      let done: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        done = resolve;
      });
      return { gate, done };
    })();
    const held = holder.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK})`;
      await release.gate;
    });
    await new Promise((r) => setTimeout(r, 200));
    const waits: string[] = [];
    const err = await runMigrations(pool(url), { timeoutMs: 800, onWait: (l) => waits.push(l) }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MigrationLockTimeout);
    expect((err as Error).message).toMatch(/locked by another migration \(Postgres backend pid \d+/);
    expect(waits[0]).toMatch(/^waiting for another migration \(Postgres backend pid \d+/);
    expect(await appliedMigrations(pool(url))).toEqual([]);

    // Once the holder commits, the waiting migrator goes ahead.
    const waiting = runMigrations(pool(url), { timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 300));
    release.done();
    await held;
    expect((await waiting).applied).toHaveLength(all.length);
  });

  it('a failing migration leaves the database as it was', async () => {
    const url = await freshDb();
    const sql = pool(url);
    await runMigrations(sql);
    expect(await appliedMigrations(sql)).toHaveLength(all.length);
    const broken = folderWith((dir, journal) => {
      writeFileSync(
        join(dir, '9999_broken.sql'),
        'CREATE TABLE "fine" (id int);--> statement-breakpoint\nSELEC 1;',
      );
      journal.entries.push({
        idx: 9999,
        version: '7',
        when: 9_999_999_999_999,
        tag: '9999_broken',
        breakpoints: true,
      });
      const compatPath = join(dir, 'compat.json');
      const compat = JSON.parse(readFileSync(compatPath, 'utf8'));
      const latest = all.at(-1)?.tag;
      compat.migrations['9999_broken'] = { class: 'expand', readers: latest, writers: latest };
      writeFileSync(compatPath, JSON.stringify(compat));
    });
    await expect(runMigrations(sql, { folder: broken })).rejects.toThrow(/syntax error/);
    expect(await appliedMigrations(sql)).toHaveLength(all.length);
    const [t] = await sql`select to_regclass('public.fine') as t, to_regclass('public.burrows') as b`;
    expect(t).toEqual({ t: null, b: 'burrows' });
  });

  it('keeps drizzle’s bookkeeping: drizzle’s migrator and this one take over from each other', async () => {
    const url = await freshDb();
    const sql = pool(url, 2);
    const more = withMore();
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
    const result = await runMigrations(sql, { folder: more });
    expect(result.applied).toEqual(MORE.map((m) => m.tag));
    const rows = await appliedMigrations(sql);
    expect(rows.map((r) => r.hash)).toEqual(readMigrations(more).map((m) => m.hash));
    // And drizzle's migrator sees nothing left to do.
    await migrate(drizzle(sql), { migrationsFolder: more });
    expect(await appliedMigrations(sql)).toHaveLength(all.length + MORE.length);
  });
});

describe('schemaCompatibility', () => {
  const later = (tag: string, i: number): Migration => ({
    tag,
    when: (all.at(-1)?.when ?? 0) + 1000 * (i + 1),
    hash: tag.repeat(8),
    statements: [],
  });
  const build = [...all, later('9001_a', 0), later('9002_b', 1)];
  const rows = build.map((m) => ({ hash: m.hash, createdAt: m.when }));
  it('accepts a prefix and lists what is pending', () => {
    expect(schemaCompatibility(rows.slice(0, all.length), build)).toEqual({
      ok: true,
      applied: all.length,
      pending: ['9001_a', '9002_b'],
    });
  });
  it('refuses a database newer than the build', () => {
    const result = schemaCompatibility([...rows, { hash: 'x', createdAt: 1 }], build);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/the database is newer than this build/);
  });
  it('refuses another history', () => {
    const other = rows.map((r, i) => (i === 2 ? { ...r, hash: 'f'.repeat(64) } : r));
    const result = schemaCompatibility(other, build);
    expect(!result.ok && result.reason).toMatch(/migration 3 of the database isn’t this build’s/);
  });
  it('refuses a backup from before the baseline with its own reason (one-agent.md OA-S83)', () => {
    const old = [
      { hash: PRE_BASELINE.hash, createdAt: PRE_BASELINE.when },
      ...Array.from({ length: 138 }, (_, i) => ({ hash: `old${i}`, createdAt: PRE_BASELINE.when + i + 1 })),
    ];
    const result = schemaCompatibility(old, build);
    expect(!result.ok && result.reason).toMatch(
      /before Whombat’s baseline: its 139 migrations start with 0000_init/,
    );
  });
  it('refuses a backup of the chain before this one’s baseline, naming the release that restores it', () => {
    const older = [
      { hash: PRE_MOVE.hash, createdAt: PRE_MOVE.when },
      ...Array.from({ length: 75 }, (_, i) => ({ hash: `older${i}`, createdAt: PRE_MOVE.when + i + 1 })),
    ];
    const result = schemaCompatibility(older, build);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain(`restored with ${MOVE_RELEASE} first`);
  });
});
