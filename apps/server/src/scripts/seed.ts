/**
 * `pnpm db:seed [--relative]` — loads the mock world through the commit pipeline (every event signed and
 * chained), then verifies the chain. `--relative` shifts the world so its "now" is the current time.
 * Run `pnpm db:reset` first; seeding refuses to overwrite an existing burrow.
 */
import { eq } from 'drizzle-orm';
import { verifyBurrowChain } from '../audit/verify';
import { loadConfig, loadDotEnv } from '../config';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { burrows } from '../db/schema/index';
import { loadSeedWorld } from '../seed/load';
import { seedWorldSource } from '../seed/source';
import { consoleLogger, createServices } from '../services';

loadDotEnv();
const config = loadConfig();
// Production never gets the mock world (docs/decisions/archive/production.md).
if (config.NODE_ENV === 'production') throw new Error('db:seed refuses to run with NODE_ENV=production');
const relative = process.argv.includes('--relative');
const { sql } = createDb(config.DATABASE_URL, { max: 2 });
try {
  await runMigrations(sql);
  const services = createServices({ config, sql, log: consoleLogger });
  const { world, source } = await seedWorldSource();
  const [existing] = await services.db
    .select({ id: burrows.id })
    .from(burrows)
    .where(eq(burrows.slug, world.burrow.slug));
  if (existing) {
    console.error(`Burrow "${world.burrow.slug}" already exists. Run \`pnpm db:reset\` first.`);
    process.exitCode = 1;
  } else {
    const shiftMs = relative ? Date.now() - Date.parse(world.now) : 0;
    const result = await loadSeedWorld(services, world, { shiftMs });
    const report = await verifyBurrowChain(services.db, result.burrowId);
    services.typing.close();
    console.log(
      `Seeded ${world.burrow.name} (${world.burrow.slug}) from ${source}${relative ? ', shifted to now' : ''}: ` +
        `${result.messages} messages, ${result.events} signed events, chain ${report.ok ? 'verified' : 'BROKEN'}.`,
    );
    if (!report.ok) process.exitCode = 1;
  }
} finally {
  await sql.end({ timeout: 5 });
}
