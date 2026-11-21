/**
 * The engine's lock dies with its session (docs/decisions/command-safety.md CS-11): when the server ends the session
 * holding it (a failover, a restart, `pg_terminate_backend`), the active engine steps down at once and another takes
 * over — never both active.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { BUSY_POOL_SIZE } from '../test/db';
import { useTestServer } from '../test/harness';
import { AutomationEngine, ENGINE_LOCK } from './engine';

const t = useTestServer({ poolSize: BUSY_POOL_SIZE });
const engines: AutomationEngine[] = [];

afterAll(async () => {
  for (const e of engines) await e.close();
});

/**
 * The session holding this test database's engine lock. Advisory locks are per database, and other test files run
 * their own engines in their own databases on the same Postgres at the same time: without the database filter this
 * could pick (and end) another file's session.
 */
async function lockHolder(): Promise<number | null> {
  const [row] = await t.services.sql<{ pid: number }[]>`
    select pid from pg_locks
    where locktype = 'advisory' and objid = ${ENGINE_LOCK} and granted
      and database = (select oid from pg_database where datname = current_database())`;
  return row?.pid ?? null;
}

describe('the automations engine’s lock (CS-11)', () => {
  it('steps down when its session ends; a second engine takes over without overlap', async () => {
    // The same lock options on both, as on every process.
    const a = new AutomationEngine(t.services, { tickMs: 20, lockCheckMs: 20, lockRetryMs: 30 });
    const b = new AutomationEngine(t.services, { tickMs: 20, lockCheckMs: 20, lockRetryMs: 30 });
    engines.push(a, b);
    a.start();
    await expect.poll(() => a.isActive, { timeout: 5_000 }).toBe(true);
    b.start();
    const holder = await lockHolder();
    expect(holder).not.toBeNull();

    let overlap = false;
    const sampler = setInterval(() => {
      if (a.isActive && b.isActive) overlap = true;
    }, 2);
    try {
      await t.services.sql`select pg_terminate_backend(${holder})`;
      await expect.poll(() => a.isActive, { timeout: 2_000, interval: 5 }).toBe(false);
      await expect.poll(() => b.isActive, { timeout: 5_000, interval: 5 }).toBe(true);
      // A tries again, and stays passive while B holds the lock.
      await new Promise((resolve) => setTimeout(resolve, 900));
    } finally {
      clearInterval(sampler);
    }
    expect(overlap).toBe(false);
    expect(a.isActive).toBe(false);
    expect(b.isActive).toBe(true);
    const next = await lockHolder();
    expect(next).not.toBeNull();
    expect(next).not.toBe(holder);
    // The pool still answers.
    expect(await t.services.sql`select 1 as one`).toEqual([{ one: 1 }]);
  });
});
