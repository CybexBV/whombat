/**
 * SEC2-F7 (independent security review; docs/decisions/bp-distribution.md BP-F18, refined by
 * docs/decisions/managed-db.md): `runMigrations` — what the
 * server's boot, `whombat start` and `whombat migrate` run — refuses a database from another history, or one a
 * newer build migrated past what this build can read, under the migration lock and before applying anything. Only `whombat upgrade`/`doctor`/restore
 * checked this before; an older build started on a newer database ran on a schema it doesn't know. A database from
 * before the baseline (one-agent.md OA-S83) is refused the same way, with its own reason, and never migrated.
 */
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { MOVE_RELEASE, PRE_BASELINE, PRE_MOVE, SCHEMA_EXIT } from './compat';
import {
  appliedMigrations,
  checkSchema,
  MIGRATIONS_FOLDER,
  readMigrations,
  runMigrations,
  SchemaMismatch,
} from './migrate';
import { prepareSchema, StartupRefused } from './startup';

const base = loadConfig().DATABASE_URL;
const tmp = join(process.env.HOME || homedir(), '.cache', 'wb-tmp', 'sec2');
const names: string[] = [];
const dirs: string[] = [];

async function admin(statement: string) {
  const conn = postgres(base, { max: 1, onnotice: () => {} });
  try {
    await conn.unsafe(statement);
  } finally {
    await conn.end({ timeout: 5 });
  }
}

async function freshDb(): Promise<postgres.Sql> {
  const name = `whombat_sec2_mig_${randomBytes(5).toString('hex')}`;
  names.push(name);
  await admin(`create database "${name}"`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  return postgres(url.toString(), { max: 1, onnotice: () => {} });
}

/** A copy of this build's migrations with `edit` applied to the journal and files. */
function variant(edit: (folder: string, journal: { entries: Record<string, unknown>[] }) => void): string {
  mkdirSync(tmp, { recursive: true });
  const folder = mkdtempSync(join(tmp, 'mig-'));
  dirs.push(folder);
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  edit(folder, journal);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

afterAll(async () => {
  for (const n of names) await admin(`drop database if exists "${n}" with (force)`);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('SEC2-F7: a build refuses a database it doesn’t know', () => {
  it('an older build’s runMigrations refuses a newer database, naming the versions, and applies nothing', async () => {
    const sql = await freshDb();
    try {
      // The NEWER build: this build's migrations plus one more.
      const newer = variant((folder, journal) => {
        const last = journal.entries.at(-1) as { idx: number; when: number };
        journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag: '9999_newer' });
        writeFileSync(join(folder, '9999_newer.sql'), 'ALTER TABLE "accounts" ADD COLUMN "sec2_newer" text;');
        // Declared incompatible: older builds may neither read nor write what it produces
        // (docs/decisions/managed-db.md; a compatible newer schema is accepted, compat.int.test.ts).
        const compatPath = join(folder, 'compat.json');
        const compat = JSON.parse(readFileSync(compatPath, 'utf8'));
        compat.migrations['9999_newer'] = {
          class: 'incompatible',
          readers: '9999_newer',
          writers: '9999_newer',
        };
        compat.runtime = { readsFrom: '9999_newer', writesFrom: '9999_newer' };
        writeFileSync(compatPath, JSON.stringify(compat));
      });
      await runMigrations(sql, { folder: newer });
      const before = await appliedMigrations(sql);

      // The OLDER build (this checkout's folder) now boots against it.
      const older = readMigrations(MIGRATIONS_FOLDER);
      const err = await runMigrations(sql).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SchemaMismatch);
      const message = (err as Error).message;
      expect(message).toContain(`schema ${older.at(-1)?.tag}, ${older.length} migration`);
      expect(message).toContain(
        `a newer Whombat migrated the database to 9999_newer, which this version (${older.at(-1)?.tag}) can’t read`,
      );
      expect((err as SchemaMismatch).check?.verdict).toBe('newer_incompatible');
      expect(await appliedMigrations(sql)).toEqual(before);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('a database from another history is refused too; this build’s own database migrates as before', async () => {
    const sql = await freshDb();
    try {
      // Another history: the same journal, but one migration's file differs (another branch).
      const other = variant((folder, journal) => {
        const first = journal.entries[0] as { tag: string };
        writeFileSync(
          join(folder, `${first.tag}.sql`),
          `${readFileSync(join(folder, `${first.tag}.sql`), 'utf8')}\n-- another branch\n`,
        );
      });
      await runMigrations(sql, { folder: other, upTo: 1 });
      const err = await runMigrations(sql).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SchemaMismatch);
      expect((err as Error).message).toMatch(
        /migration 1 of the database isn’t this build’s .* another version history/,
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
    const own = await freshDb();
    try {
      const all = readMigrations(MIGRATIONS_FOLDER);
      expect((await runMigrations(own)).applied).toEqual(all.map((m) => m.tag));
      expect(await runMigrations(own)).toMatchObject({
        applied: [],
        latest: all.at(-1)?.tag,
        check: { verdict: 'current' },
      });
    } finally {
      await own.end({ timeout: 5 });
    }
  });

  it('a database from before the baseline is refused with its own reason, at every door, and nothing changes', async () => {
    const sql = await freshDb();
    try {
      // As 0000_init … 0138 left it: drizzle's 139 rows, the recorded compatibility, a table with data.
      await sql.unsafe(`
        create schema drizzle;
        create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
        create schema whombat_meta;
        create table whombat_meta.schema_versions (version integer primary key, tag text not null, hash text not null,
          class text not null, readers integer not null, writers integer not null, backfill text, checkpoint text,
          applied_by text, recorded_at timestamptz not null default now());
        create table principals (id text primary key, channel_ids text[] not null default '{}');
        insert into principals (id) values ('prn_dusty');`);
      for (let v = 1; v <= 139; v++) {
        const hash = v === 1 ? PRE_BASELINE.hash : `old${v}`;
        await sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${hash}, ${PRE_BASELINE.when + v - 1})`;
        await sql`insert into whombat_meta.schema_versions (version, tag, hash, class, readers, writers)
                  values (${v}, ${v === 1 ? PRE_BASELINE.tag : `old_${v}`}, ${hash}, 'legacy', ${v}, ${v})`;
      }
      const before = await appliedMigrations(sql);

      const check = await checkSchema(sql);
      expect(check).toMatchObject({ verdict: 'foreign', access: 'none' });
      const err = await runMigrations(sql).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SchemaMismatch);
      expect((err as Error).message).toMatch(
        /made before Whombat’s baseline: its 139 migrations start with 0000_init/,
      );
      expect((err as Error).message).toMatch(/Start this Whombat on a new, empty database/);
      for (const authority of ['boot', 'external'] as const) {
        const refused = await prepareSchema(sql, { authority }).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(StartupRefused);
        expect((refused as StartupRefused).exitCode).toBe(SCHEMA_EXIT.refused);
      }

      expect(await appliedMigrations(sql)).toEqual(before);
      const [tables] =
        await sql`select to_regclass('public.burrows') as burrows, count(*)::int as n from principals`;
      expect(tables).toEqual({ burrows: null, n: 1 });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
  it('a database of the chain before this one’s baseline is refused at every door, naming the release that moves it', async () => {
    const sql = await freshDb();
    try {
      // As that chain's 76 migrations left it: drizzle's rows, the recorded compatibility, a table with data.
      await sql.unsafe(`
        create schema drizzle;
        create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
        create schema whombat_meta;
        create table whombat_meta.schema_versions (version integer primary key, tag text not null, hash text not null,
          class text not null, readers integer not null, writers integer not null, backfill text, checkpoint text,
          applied_by text, recorded_at timestamptz not null default now());
        create table principals (id text primary key, channel_ids text[] not null default '{}');
        insert into principals (id) values ('prn_dusty');`);
      for (let v = 1; v <= 76; v++) {
        const hash = v === 1 ? PRE_MOVE.hash : `older${v}`;
        await sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${hash}, ${PRE_MOVE.when + v - 1})`;
        await sql`insert into whombat_meta.schema_versions (version, tag, hash, class, readers, writers)
                  values (${v}, ${v === 1 ? PRE_MOVE.tag : `older_${v}`}, ${hash}, 'expand', 1, 1)`;
      }
      const before = await appliedMigrations(sql);

      const check = await checkSchema(sql);
      expect(check).toMatchObject({ verdict: 'foreign', access: 'none', database: { version: 76 } });
      const err = await runMigrations(sql).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SchemaMismatch);
      expect((err as Error).message).toContain(`before ${MOVE_RELEASE}`);
      expect((err as Error).message).toContain(`Update this Whombat to ${MOVE_RELEASE} first`);
      for (const authority of ['boot', 'external'] as const) {
        const refused = await prepareSchema(sql, { authority }).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(StartupRefused);
        expect((refused as StartupRefused).exitCode).toBe(SCHEMA_EXIT.refused);
        expect((refused as Error).message).toContain(MOVE_RELEASE);
      }

      expect(await appliedMigrations(sql)).toEqual(before);
      const [tables] =
        await sql`select to_regclass('public.burrows') as burrows, count(*)::int as n from principals`;
      expect(tables).toEqual({ burrows: null, n: 1 });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('a database that release moved across is current, at version 77', async () => {
    const sql = await freshDb();
    try {
      await runMigrations(sql);
      const check = await checkSchema(sql);
      expect(check).toMatchObject({ verdict: 'current', access: 'read-write' });
      // The baseline is version 77; later migrations count on from it.
      const recorded = await sql<{ version: number; tag: string }[]>`
        select version, tag from whombat_meta.schema_versions order by version`;
      expect(recorded[0]).toEqual({ version: 77, tag: '0000_baseline' });
      expect(check).toMatchObject({ database: { version: 76 + recorded.length } });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
