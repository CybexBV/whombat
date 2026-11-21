/**
 * The two commands the appliance's update helper runs with the runtime bundle's `bin/whombat`
 * (docs/decisions/managed-db.md MD-10): `schema-check` (read-only validation) and `migrate` (the migration authority),
 * with `--json --env` answers and exit codes, against a throwaway database next to DATABASE_URL (the shared dev
 * Postgres by default). Needs Postgres: the commands are only what they do to a real database.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readMigrations } from '@whombat/server/host';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateCommand, schemaCheckCommand, targetFromEnv } from './schema';

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://whombat:whombat@localhost:55432/whombat';
const BIN = join(import.meta.dirname, '..', 'bin', 'whombat.mjs');
const ALL = readMigrations();

async function admin(statement: string): Promise<void> {
  const sql = postgres(BASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(statement);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe('schema-check and migrate as the appliance runs them', () => {
  const name = `whombat_cli_${randomBytes(6).toString('hex')}`;
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  let dir: string;
  let envFile: string;

  beforeAll(async () => {
    await admin(`create database "${name}"`);
    dir = mkdtempSync(join(tmpdir(), 'whombat-cli-schema-'));
    envFile = join(dir, 'runtime.env');
    writeFileSync(envFile, `DATABASE_URL=${url}\n`);
    chmodSync(envFile, 0o600);
  });

  afterAll(async () => {
    await admin(`drop database if exists "${name}" with (force)`);
    rmSync(dir, { recursive: true, force: true });
  });

  /** `bin/whombat <args>` with the helper's environment (MR-73): the env file alone, none of the server's secrets. */
  async function whombat(args: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: dir,
      LANG: 'C.UTF-8',
      NODE_ENV: 'production',
      WHOMBAT_ENV_FILE: envFile,
    };
    const run = promisify(execFile)(process.execPath, [BIN, ...args], { cwd: dir, env });
    const out = await run.then(
      (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
      (err: { code?: number; stdout?: string; stderr?: string }) => ({
        code: err.code ?? -1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
      }),
    );
    expect(out.stdout, out.stderr).toMatch(/^\{/);
    return { code: out.code, json: JSON.parse(out.stdout) };
  }

  it('an empty database: schema-check exits 10; migrate applies everything; then both answer 0', async () => {
    const before = await whombat(['schema-check', '--json', '--env']);
    expect(before.code).toBe(10);
    expect(before.json).toMatchObject({
      format: 'whombat.schema-check/1',
      verdict: 'migration_required',
      access: 'none',
      database: { version: 0 },
      pending: ALL.map((m) => m.tag),
      // MD-12: the schema migrate leaves and its floors (the newest migration's floors are older schemas).
      target: { version: ALL.length, tag: ALL.at(-1)?.tag },
    });
    const floors = before.json.target as { readers: number; writers: number };
    expect(floors.readers).toBeLessThanOrEqual(floors.writers);
    expect(floors.writers).toBeLessThanOrEqual(ALL.length);

    const migrated = await whombat(['migrate', '--json', '--env']);
    expect(migrated.code).toBe(0);
    expect(migrated.json).toMatchObject({
      format: 'whombat.migrate/1',
      ok: true,
      check: { verdict: 'current' },
    });
    expect(migrated.json.applied).toHaveLength(ALL.length);

    const after = await whombat(['schema-check', '--json', '--env']);
    expect(after.code).toBe(0);
    expect(after.json).toMatchObject({
      verdict: 'current',
      access: 'read-write',
      database: { version: ALL.length, postgresMajor: 17 },
    });
  }, 60_000);

  it('migrate again applies nothing; the text answers say what they found', async () => {
    const target = targetFromEnv({ DATABASE_URL: url.toString() });
    expect((await migrateCommand(target, { json: true })).code).toBe(0);
    const again = await migrateCommand(target, { json: true });
    expect(again.code).toBe(0);
    expect(JSON.parse(again.text)).toMatchObject({ ok: true, applied: [] });
    expect((await migrateCommand(target, { json: false })).text).toMatch(/up to date/);
    expect((await schemaCheckCommand(target, false)).text).toMatch(/^schema: current \(read-write\)/);
  });

  it('a database that isn’t there is an error, not a verdict', async () => {
    const missing = new URL(url);
    missing.pathname = `/${name}_missing`;
    const out = await schemaCheckCommand(targetFromEnv({ DATABASE_URL: missing.toString() }), true);
    expect(out.code).not.toBe(0);
    expect(JSON.parse(out.text)).toMatchObject({
      format: 'whombat.schema-check/1',
      error: { kind: 'failed' },
    });
  });
});
