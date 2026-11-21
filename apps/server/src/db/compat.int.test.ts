/**
 * The schema compatibility model against a real Postgres (docs/decisions/managed-db.md MD-01…MD-09): real
 * binaries' migrations (this build's = the "old" binary) and newer binaries made from them by adding the
 * migrations of an expand → backfill → contract sequence and an incompatible one, over the seeded test world
 * (people, agents, channels, messages). Old binaries run their real server code on the newer schemas.
 */
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { api } from '@whombat/core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, isReadOnlyViolation } from '../app';
import { sendMessage } from '../commands/messages';
import { loadConfig } from '../config';
import { errorAnswer } from '../managed/dispatcher';
import { loadSeedWorld } from '../seed/load';
import { IDS, TEST_BURROW_ID, testWorld } from '../seed/test-world';
import { createServices } from '../services';
import { inProcessApi } from '../test/api';
import { sessionFor } from '../test/tokens';
import type { Backfill, BackfillRegistry } from './backfills';
import { createDb } from './client';
import type { CompatEntryInput } from './compat';
import {
  appliedMigrations,
  CheckpointRequired,
  checkSchema,
  MIGRATIONS_FOLDER,
  readMigrations,
  runMigrations,
  SchemaMismatch,
} from './migrate';
import { prepareSchema, StartupRefused } from './startup';

const base = loadConfig().DATABASE_URL;
const scratch = join(process.env.HOME || homedir(), '.cache', 'wb-tmp', 'compat-int');
mkdirSync(scratch, { recursive: true });
const names: string[] = [];
const pools: postgres.Sql[] = [];
const dirs: string[] = [];
const OLD = readMigrations();
const OLD_TAG = OLD.at(-1)?.tag as string;

async function admin(statement: string) {
  const conn = postgres(base, { max: 1, onnotice: () => {} });
  try {
    await conn.unsafe(statement);
  } finally {
    await conn.end({ timeout: 5 });
  }
}

function pool(url: string, max = 2): postgres.Sql {
  const sql = createDb(url, { max }).sql;
  pools.push(sql);
  return sql;
}

function configFor(url: string) {
  const files = mkdtempSync(join(scratch, 'files-'));
  dirs.push(files);
  return loadConfig({ DATABASE_URL: url, NODE_ENV: 'test', LOG_LEVEL: 'silent', WHOMBAT_FILES_DIR: files });
}

/** A database migrated by this build and loaded with the seeded test world. */
async function seededDb(): Promise<string> {
  const name = `whombat_test_compat_${randomBytes(5).toString('hex')}`;
  await admin(`create database "${name}"`);
  names.push(name);
  const url = new URL(base);
  url.pathname = `/${name}`;
  const sql = pool(url.toString());
  await runMigrations(sql);
  await loadSeedWorld(createServices({ config: configFor(url.toString()), sql }), testWorld());
  return url.toString();
}

interface Step {
  tag: string;
  sql: string;
  compat: CompatEntryInput;
}

/** A newer binary's migrations: this build's plus `steps` (journal and compat.json). */
function newerBinary(steps: Step[]): string {
  const dir = mkdtempSync(join(scratch, 'mig-'));
  dirs.push(dir);
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Record<string, unknown>[] };
  const compatPath = join(dir, 'compat.json');
  const compat = JSON.parse(readFileSync(compatPath, 'utf8'));
  for (const step of steps) {
    const last = journal.entries.at(-1) as { idx: number; when: number };
    journal.entries.push({
      idx: last.idx + 1,
      version: '7',
      when: last.when + 1000,
      tag: step.tag,
      breakpoints: true,
    });
    writeFileSync(join(dir, `${step.tag}.sql`), step.sql);
    compat.migrations[step.tag] = step.compat;
  }
  compat.runtime = { readsFrom: steps.at(-1)?.tag, writesFrom: steps.at(-1)?.tag };
  writeFileSync(journalPath, JSON.stringify(journal));
  writeFileSync(compatPath, JSON.stringify(compat));
  return dir;
}

// The expand → backfill → contract sequence of a new required column, and an incompatible rename.
const EXPAND: Step = {
  tag: '9001_compat_note',
  sql: 'ALTER TABLE "messages" ADD COLUMN "compat_note" text;',
  compat: { class: 'expand', readers: OLD_TAG, writers: OLD_TAG },
};
const BACKFILL: Step = {
  tag: '9002_compat_note_fill',
  sql: 'CREATE INDEX "messages_compat_note_missing" ON "messages" ("id") WHERE "compat_note" IS NULL;',
  compat: { class: 'backfill', readers: OLD_TAG, writers: OLD_TAG, backfill: 'compat_note_fill' },
};
const CONTRACT: Step = {
  tag: '9003_compat_note_required',
  // Old writers were allowed until now, so rows they wrote since the backfill are filled here, under the
  // checkpoint's quiesced writes, before the constraint that old writers can't satisfy.
  sql: `UPDATE "messages" SET "compat_note" = 'filled:' || "id" WHERE "compat_note" IS NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "compat_note" SET NOT NULL;`,
  compat: { class: 'contract', readers: OLD_TAG, writers: '9003_compat_note_required' },
};
const INCOMPATIBLE: Step = {
  tag: '9004_message_body',
  sql: 'ALTER TABLE "messages" RENAME COLUMN "text" TO "body";',
  compat: { class: 'incompatible', readers: '9004_message_body', writers: '9004_message_body' },
};

/** The backfill, in batches of 3 messages by id; `failAt` throws on that call (a crash mid-backfill). */
function noteFill(record: { cursors: (string | null)[]; failAt?: number }): BackfillRegistry {
  const fill: Backfill = {
    async batch(tx, cursor) {
      record.cursors.push(cursor);
      if (record.failAt !== undefined && record.cursors.length === record.failAt)
        throw new Error('the backfill process died');
      const rows = await tx<{ id: string }[]>`
        select id from messages where ${cursor === null ? tx`true` : tx`id > ${cursor}`} order by id limit 3`;
      if (!rows.length) return { cursor, processed: 0, done: true };
      const ids = rows.map((r) => r.id);
      const updated = await tx`
        update messages set compat_note = 'filled:' || id where id in ${tx(ids)} and compat_note is null`;
      return { cursor: ids.at(-1) as string, processed: updated.count, done: rows.length < 3 };
    },
  };
  return { compat_note_fill: fill };
}

/** This build's server (the old binary) on `url`, as its boot would run it: read-write or read-only. */
async function oldServer(url: string, access: 'read-write' | 'read-only') {
  const sql = createDb(url, { max: 2, readOnly: access === 'read-only' }).sql;
  pools.push(sql);
  const services = createServices({ config: configFor(url), sql, schemaAccess: access });
  const app = await buildApp({ services, logger: false });
  await app.ready();
  return { services, app };
}

const messagesPath = (conversationId: string) =>
  `/api/v1${api.messages.list.path.replace(':burrow', 'burrow-hq').replace(':conversationId', conversationId)}`;

afterAll(async () => {
  for (const p of pools) await p.end({ timeout: 5 }).catch(() => {});
  for (const n of names) await admin(`drop database if exists "${n}" with (force)`);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('an old binary on a newer schema', () => {
  it('after an expand migration: validates read-write, boots, reads and writes through its real code', async () => {
    const url = await seededDb();
    const authority = pool(url);
    const newer = newerBinary([EXPAND]);
    const migrated = await runMigrations(authority, { folder: newer });
    expect(migrated.applied).toEqual([EXPAND.tag]);
    expect(migrated.check.verdict).toBe('current');

    // Managed startup (validation only) and self-hosted startup (the boot is a migration authority) agree.
    const managed = await prepareSchema(pool(url), { authority: 'external' });
    expect(managed).toMatchObject({ access: 'read-write', check: { verdict: 'newer_compatible' } });
    const selfHosted = await prepareSchema(pool(url), { authority: 'boot' });
    expect(selfHosted).toMatchObject({ access: 'read-write', applied: [] });
    expect(await appliedMigrations(authority)).toHaveLength(OLD.length + 1);

    const { services, app } = await oldServer(url, 'read-write');
    try {
      const sent = await services.pipeline.commit(
        sendMessage,
        { conversationId: IDS.general, text: 'Written by the old binary on the expanded schema' },
        { burrowId: TEST_BURROW_ID, actorId: IDS.mara },
      );
      expect(sent.status).toBe('ok');
      const { cookie } = await sessionFor(services, IDS.mara);
      const caller = inProcessApi(() => services);
      const res = await caller.inject({ method: 'GET', url: messagesPath(IDS.general), headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Written by the old binary on the expanded schema');
      const post = await caller.inject({
        method: 'POST',
        url: messagesPath(IDS.general),
        headers: { cookie, 'content-type': 'application/json' },
        payload: { text: 'And through a session' },
      });
      expect(post.statusCode).toBeLessThan(300);
      // The old binary doesn't know the new column: its rows leave it empty, which the expand allows.
      const [row] = await authority<{ n: number }[]>`
        select count(*)::int as n from messages where compat_note is null`;
      expect(row?.n).toBeGreaterThan(0);
    } finally {
      await app.close();
      services.typing.close();
    }
  });

  it('after a contract migration: refuses writes with a clear reason, keeps serving reads', async () => {
    const url = await seededDb();
    const authority = pool(url);
    const newer = newerBinary([EXPAND, BACKFILL, CONTRACT]);
    const before = await appliedMigrations(authority);
    const refused = await runMigrations(authority, {
      folder: newer,
      backfills: noteFill({ cursors: [] }),
    }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CheckpointRequired);
    expect((refused as CheckpointRequired).migrations).toEqual([CONTRACT.tag]);
    expect((refused as Error).message).toMatch(/consistent checkpoint first/);
    expect(await appliedMigrations(authority)).toEqual(before);

    const done = await runMigrations(authority, {
      folder: newer,
      backfills: noteFill({ cursors: [] }),
      checkpoint: 'backup-before-9003',
    });
    expect(done.applied).toEqual([EXPAND.tag, BACKFILL.tag, CONTRACT.tag]);
    expect(done.backfilled).toEqual(['compat_note_fill']);
    const [recorded] = await authority<{ checkpoint: string | null; class: string }[]>`
      select checkpoint, class from whombat_meta.schema_versions where tag = ${CONTRACT.tag}`;
    expect(recorded).toEqual({ checkpoint: 'backup-before-9003', class: 'contract' });

    // The old binary, unprotected, really can't write any more (it doesn't fill the required column)…
    const { services: unguarded, app: unguardedApp } = await oldServer(url, 'read-write');
    const broken = await unguarded.pipeline
      .commit(
        sendMessage,
        { conversationId: IDS.general, text: 'lost' },
        { burrowId: TEST_BURROW_ID, actorId: IDS.mara },
      )
      .catch((e: unknown) => e);
    expect(
      String((broken as { code?: string }).code ?? (broken as { cause?: { code?: string } }).cause?.code),
    ).toBe('23502');
    const { cookie } = await sessionFor(unguarded, IDS.mara);
    await unguardedApp.close();
    unguarded.typing.close();

    // …so its startup says read-only, and the server started that way refuses writes up front.
    const check = await checkSchema(pool(url));
    expect(check).toMatchObject({ verdict: 'newer_read_only', access: 'read-only' });
    const startup = await prepareSchema(pool(url), { authority: 'external' });
    expect(startup.access).toBe('read-only');
    const { services, app } = await oldServer(url, 'read-only');
    try {
      const caller = inProcessApi(() => services);
      const read = await caller.inject({
        method: 'GET',
        url: messagesPath(IDS.general),
        headers: { cookie },
      });
      expect(read.statusCode).toBe(200);
      // A session's write reaches the read-only pool, refused; the session answers `unavailable`.
      const write = await caller
        .inject({
          method: 'POST',
          url: messagesPath(IDS.general),
          headers: { cookie, 'content-type': 'application/json' },
          payload: { text: 'refused' },
        })
        .catch((e: unknown) => e);
      expect(errorAnswer(write, services)).toMatchObject({ type: 'error', code: 'unavailable' });
      // The loopback listener refuses the runner's writes up front, with the reason.
      const claim = await app.inject({
        method: 'POST',
        url: '/internal/runner/claim',
        headers: { authorization: 'Bearer dev-runner-token', 'content-type': 'application/json' },
        payload: { runnerId: 'rnr_compat', providers: ['claude'], waitMs: 0 },
      });
      expect(claim.statusCode).toBe(503);
      expect(claim.json()).toMatchObject({ error: { code: 'read_only' } });
      // Postgres itself refuses anything that gets past the app (the read-only pool).
      const direct = await services.pipeline
        .commit(
          sendMessage,
          { conversationId: IDS.general, text: 'x' },
          { burrowId: TEST_BURROW_ID, actorId: IDS.mara },
        )
        .catch((e: unknown) => e);
      expect(isReadOnlyViolation(direct)).toBe(true);
    } finally {
      await app.close();
      services.typing.close();
    }
  });

  it('after an incompatible migration: refused at startup and by its migration authority, nothing changed', async () => {
    const url = await seededDb();
    const authority = pool(url);
    const newer = newerBinary([EXPAND, BACKFILL, CONTRACT, INCOMPATIBLE]);
    await runMigrations(authority, { folder: newer, backfills: noteFill({ cursors: [] }), checkpoint: 'bk' });
    const check = await checkSchema(pool(url));
    expect(check).toMatchObject({ verdict: 'newer_incompatible', access: 'none' });
    const refused = await prepareSchema(pool(url), { authority: 'external' }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(StartupRefused);
    expect((refused as StartupRefused).exitCode).toBe(12);
    expect((refused as Error).message).toMatch(
      new RegExp(`can’t read.*Run a Whombat whose schema is at least ${INCOMPATIBLE.tag}`),
    );
    const before = await appliedMigrations(authority);
    const boot = await runMigrations(pool(url)).catch((e: unknown) => e);
    expect(boot).toBeInstanceOf(SchemaMismatch);
    expect(await appliedMigrations(authority)).toEqual(before);
  });
});

describe('a new binary on an old schema', () => {
  it('before migrating: validation says migration required and changes nothing; the authority then migrates', async () => {
    const url = await seededDb();
    const sql = pool(url);
    const newer = newerBinary([EXPAND]);
    const snapshot = async () => ({
      applied: await appliedMigrations(sql),
      recorded: await sql`select * from whombat_meta.schema_versions order by version`,
      columns:
        await sql`select column_name from information_schema.columns where table_name = 'messages' order by 1`,
    });
    const before = await snapshot();
    const check = await checkSchema(sql, { folder: newer });
    expect(check).toMatchObject({ verdict: 'migration_required', access: 'none', pending: [EXPAND.tag] });
    const refused = await prepareSchema(sql, { authority: 'external', folder: newer }).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(StartupRefused);
    expect((refused as StartupRefused).exitCode).toBe(10);
    expect((refused as Error).message).toMatch(/needs migrating before this version of Whombat can start/);
    expect(await snapshot()).toEqual(before);

    const booted = await prepareSchema(sql, { authority: 'boot', folder: newer });
    expect(booted).toMatchObject({
      access: 'read-write',
      applied: [EXPAND.tag],
      check: { verdict: 'current' },
    });
  });
});

describe('resumable backfills', () => {
  it('an interrupted backfill resumes from its last committed batch and finishes', async () => {
    const url = await seededDb();
    const sql = pool(url);
    const [{ n: total } = { n: 0 }] = await sql<{ n: number }[]>`select count(*)::int as n from messages`;
    expect(total).toBeGreaterThan(6);
    const newer = newerBinary([EXPAND, BACKFILL]);
    const first = { cursors: [] as (string | null)[], failAt: 3 };
    await expect(runMigrations(sql, { folder: newer, backfills: noteFill(first) })).rejects.toThrow(
      /the backfill process died/,
    );
    // The schema change committed; two batches (6 rows) are done and checkpointed.
    expect(await appliedMigrations(sql)).toHaveLength(OLD.length + 2);
    const [state] = await sql<{ state: string; cursor: string; processed: string; batches: number }[]>`
      select state, cursor, processed::text, batches from whombat_meta.backfills where name = 'compat_note_fill'`;
    expect(state).toMatchObject({ state: 'pending', processed: '6', batches: 2 });
    // Until it finishes, the new binary isn't migrated; the old one still reads and writes (B's writers).
    expect(await checkSchema(sql, { folder: newer })).toMatchObject({
      verdict: 'migration_required',
      database: { pendingBackfills: ['compat_note_fill'] },
    });
    expect((await checkSchema(sql)).access).toBe('read-write');

    const second = { cursors: [] as (string | null)[] };
    const resumed = await runMigrations(sql, { folder: newer, backfills: noteFill(second) });
    expect(resumed.applied).toEqual([]);
    expect(resumed.backfilled).toEqual(['compat_note_fill']);
    expect(second.cursors[0]).toBe(state?.cursor);
    const [after] = await sql<{ state: string; processed: string }[]>`
      select state, processed::text from whombat_meta.backfills where name = 'compat_note_fill'`;
    expect(after).toEqual({ state: 'done', processed: String(total) });
    const [missing] = await sql<
      { n: number }[]
    >`select count(*)::int as n from messages where compat_note is null`;
    expect(missing?.n).toBe(0);
    expect(resumed.check.verdict).toBe('current');
  });
});

describe('one migration authority at a time', () => {
  it('two authorities at once: each migration and each backfill batch applied once', async () => {
    const url = await seededDb();
    const newer = newerBinary([EXPAND, BACKFILL]);
    const a = { cursors: [] as (string | null)[] };
    const b = { cursors: [] as (string | null)[] };
    const [ra, rb] = await Promise.all([
      runMigrations(pool(url), { folder: newer, backfills: noteFill(a) }),
      runMigrations(pool(url), { folder: newer, backfills: noteFill(b) }),
    ]);
    expect([...ra.applied, ...rb.applied].sort()).toEqual([EXPAND.tag, BACKFILL.tag]);
    const sql = pool(url);
    const [{ n: total } = { n: 0 }] = await sql<{ n: number }[]>`select count(*)::int as n from messages`;
    const [fill] = await sql<{ processed: string; state: string }[]>`
      select processed::text, state from whombat_meta.backfills where name = 'compat_note_fill'`;
    expect(fill).toEqual({ processed: String(total), state: 'done' });
    // Every batch saw a distinct cursor: no batch ran twice.
    const cursors = [...a.cursors, ...b.cursors];
    expect(new Set(cursors).size).toBe(cursors.length);
    const recorded = await sql<{ version: number }[]>`select version from whombat_meta.schema_versions`;
    expect(recorded).toHaveLength(OLD.length + 2);
  });
});

describe('foreign histories', () => {
  it('a newer migration applied without recorded compatibility (drizzle’s migrator, a pre-model build) is refused', async () => {
    const url = await seededDb();
    const sql = pool(url);
    await migrate(drizzle(sql), { migrationsFolder: newerBinary([EXPAND]) });
    expect(await checkSchema(sql)).toMatchObject({ verdict: 'foreign', access: 'none' });
    await expect(runMigrations(sql)).rejects.toBeInstanceOf(SchemaMismatch);
  });

  it('a different file at a known position is another history', async () => {
    const url = await seededDb();
    const sql = pool(url);
    const other = newerBinary([EXPAND]);
    const first = OLD[0]?.tag as string;
    writeFileSync(
      join(other, `${first}.sql`),
      `${readFileSync(join(other, `${first}.sql`), 'utf8')}\n-- another branch\n`,
    );
    const check = await checkSchema(sql, { folder: other });
    expect(check.verdict).toBe('foreign');
    expect(check.reason).toMatch(/migration 1 of the database isn’t this build’s/);
    await expect(runMigrations(sql, { folder: other })).rejects.toBeInstanceOf(SchemaMismatch);
  });
});
