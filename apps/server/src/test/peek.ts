/**
 * A backup opened for reading, in tests (backup-look.md): a copy of a test's database as it is now, named as the backup
 * service names a peek's (`whombat_peek_<12 hex>`), next to it on the test Postgres. The copy is made table by table
 * (`COPY`, with foreign keys off while it is filled) into a database of the same migrations; it is dropped by `drop`.
 */
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import postgres from 'postgres';
import { withDatabase } from '../db/url';
import { createTestDb } from './db-resource';

export async function copyAsPeek(sourceUrl: string): Promise<{ name: string; drop(): Promise<void> }> {
  const made = await createTestDb(1);
  await made.sql.end({ timeout: 5 });
  const name = `whombat_peek_${randomBytes(6).toString('hex')}`;
  const admin = postgres(sourceUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`alter database "${made.name}" rename to "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const source = postgres(sourceUrl, { max: 1, onnotice: () => {} });
  const target = postgres(withDatabase(sourceUrl, name), { max: 1, onnotice: () => {} });
  try {
    await target.unsafe('set session_replication_role = replica');
    const tables = await source<{ table: string }[]>`
      select tablename as table from pg_tables where schemaname = 'public' order by tablename`;
    // Whatever the migrations put in first goes, all at once (one table at a time would cascade into copied ones).
    if (tables.length)
      await target.unsafe(`truncate table ${tables.map((t) => `"public"."${t.table}"`).join(', ')} cascade`);
    for (const { table } of tables) {
      const out = await source.unsafe(`copy "public"."${table}" to stdout`).readable();
      const into = await target.unsafe(`copy "public"."${table}" from stdin`).writable();
      await pipeline(out, into);
    }
  } finally {
    await source.end({ timeout: 5 });
    await target.end({ timeout: 5 });
  }
  return {
    name,
    async drop() {
      const a = postgres(sourceUrl, { max: 1, onnotice: () => {} });
      try {
        await a.unsafe(`drop database if exists "${name}" with (force)`);
      } finally {
        await a.end({ timeout: 5 });
      }
    },
  };
}
