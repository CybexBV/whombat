/** Vitest lifecycle around the database resource also used by the browser/runtime smoke suite. */
import { afterAll, beforeAll } from 'vitest';
import { createTestDb, type TestDb } from './db-resource';

export * from './db-resource';

/**
 * Register a throwaway database for the current test file: created in beforeAll, dropped in afterAll.
 * Access its fields inside tests/hooks (not at module level).
 */
export function useTestDb(options: { poolSize?: number } = {}): TestDb {
  let current: Awaited<ReturnType<typeof createTestDb>> | undefined;
  let pending: ReturnType<typeof createTestDb> | undefined;
  beforeAll(async () => {
    pending = createTestDb(options.poolSize);
    current = await pending;
  });
  afterAll(async () => {
    // Also when beforeAll timed out while the database was still being created: drop it once it exists.
    const created = current ?? (await pending?.catch(() => undefined));
    await created?.drop();
  });
  const get = (): TestDb => {
    if (!current) throw new Error('useTestDb: database not ready (use it inside tests or hooks)');
    return current;
  };
  return {
    get name() {
      return get().name;
    },
    get url() {
      return get().url;
    },
    get sql() {
      return get().sql;
    },
    get db() {
      return get().db;
    },
  };
}
