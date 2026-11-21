/**
 * `pnpm --filter @whombat/server audit:verify [slug]` — walks every burrow's chain (or one): hashes,
 * Ed25519 signatures against each actor's key, seq continuity and prev-hash links. Exits 1 on any failure.
 */
import { asc, eq } from 'drizzle-orm';
import { verifyBurrowChain } from '../audit/verify';
import { loadConfig, loadDotEnv } from '../config';
import { createDb } from '../db/client';
import { burrows } from '../db/schema/index';

loadDotEnv();
const { DATABASE_URL } = loadConfig();
const { sql, db } = createDb(DATABASE_URL, { max: 1 });
const only = process.argv.slice(2).find((a) => !a.startsWith('-'));
try {
  const rows = await db
    .select()
    .from(burrows)
    .where(only ? eq(burrows.slug, only) : undefined)
    .orderBy(asc(burrows.createdAt));
  if (rows.length === 0) console.log(only ? `No burrow "${only}".` : 'No burrows.');
  for (const b of rows) {
    const report = await verifyBurrowChain(db, b.id);
    const head = report.head ? `head #${report.head.seq} ${report.head.hash.slice(0, 12)}…` : 'empty';
    console.log(`${b.slug}: ${report.ok ? 'OK' : 'FAILED'} · ${report.checked} events · ${head}`);
    for (const f of report.failures) console.log(`  seq ${f.seq} ${f.id}: ${f.reason}`);
    if (!report.ok) process.exitCode = 1;
  }
} finally {
  await sql.end({ timeout: 5 });
}
