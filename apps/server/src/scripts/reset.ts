import { loadConfig, loadDotEnv } from '../config';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';

loadDotEnv();
const { DATABASE_URL, NODE_ENV } = loadConfig();
if (NODE_ENV === 'production') throw new Error('db:reset refuses to run with NODE_ENV=production');

const { sql } = createDb(DATABASE_URL, { max: 1 });
try {
  await sql`drop schema if exists drizzle cascade`;
  await sql`drop schema if exists public cascade`;
  await sql`create schema public`;
  await runMigrations(sql);
  console.log(`Database reset: ${new URL(DATABASE_URL).pathname.slice(1)}`);
} finally {
  await sql.end();
}
