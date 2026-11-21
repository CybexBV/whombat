/**
 * `pnpm db:migrate [--checkpoint <ref>]`: the development migration authority (docs/decisions/managed-db.md
 * MD-02). Outside production it passes a development checkpoint for contract migrations, like the server's
 * boot; in production pass the backup taken after quiescing writes (MD-06), or use `whombat migrate`.
 */
import { parseArgs } from 'node:util';
import { loadConfig, loadDotEnv } from '../config';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';

loadDotEnv();
const { DATABASE_URL, NODE_ENV } = loadConfig();
const { values } = parseArgs({ options: { checkpoint: { type: 'string' } } });
const checkpoint =
  values.checkpoint ?? (NODE_ENV === 'production' ? undefined : 'development (pnpm db:migrate)');
const { sql } = createDb(DATABASE_URL, { max: 1 });
try {
  const result = await runMigrations(sql, { checkpoint, onWait: (l) => console.log(l) });
  console.log(
    result.applied.length ? `Migrations applied: ${result.applied.join(', ')}.` : 'Migrations applied.',
  );
  if (result.check.access !== 'read-write') console.log(`${result.check.reason}. ${result.check.action}`);
} finally {
  await sql.end();
}
