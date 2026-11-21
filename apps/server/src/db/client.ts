import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';
import { postgresConnection } from './url';

export type Sql = postgres.Sql;

export function createDb(url: string, options: { max?: number; readOnly?: boolean } = {}) {
  // libpq's unix-socket form (the appliance's, NX-18) as postgres.js takes it (MR-75).
  const target = postgresConnection(url);
  const sql = postgres(target.url, {
    ...(target.host ? { host: target.host } : {}),
    max: options.max ?? 10,
    onnotice: () => {},
    connection: {
      // Floats as exact text whatever the server, database or role says (Postgres 12+ prints the shortest exact
      // form for any value above 0, its default 1): a search cursor carries a rank back (search-pagination.md SP-03).
      extra_float_digits: 3,
      // Read-only start (docs/decisions/managed-db.md MD-07): Postgres itself refuses every write on this pool.
      ...(options.readOnly ? { default_transaction_read_only: true } : {}),
    },
  });
  const db = drizzle(sql, { schema });
  return { sql, db };
}

/** Drizzle bound to a postgres.js pool (for code that already has a `Sql`). */
export function drizzleFor(sql: Sql) {
  return drizzle(sql, { schema });
}

export type Database = ReturnType<typeof createDb>['db'];
/** A transaction handle inside `db.transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything reads can run on: the pool or an open transaction. */
export type Db = Database | Tx;
