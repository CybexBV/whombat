/**
 * The test databases' template is keyed by the migrations' content (docs/decisions/polling.md PL-03): the same
 * migrations give the same hash, any change to one of them a new one.
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../db/migrate';
import { migrationsHash } from './db';

const dir = mkdtempSync(join(tmpdir(), 'whombat-migrations-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the migrations hash', () => {
  it('is the same for the same migrations and changes with any of them', () => {
    const copy = join(dir, 'migrations');
    cpSync(MIGRATIONS_FOLDER, copy, { recursive: true });
    const hash = migrationsHash(MIGRATIONS_FOLDER);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(migrationsHash(copy)).toBe(hash);
    writeFileSync(join(copy, '9999_more.sql'), 'select 1;');
    expect(migrationsHash(copy)).not.toBe(hash);
  });
});
