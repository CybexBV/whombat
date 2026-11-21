/**
 * A session the server ends under a transaction or a reservation (pg_terminate_backend, a restart or failover, a
 * network reset, idle_in_transaction_session_timeout) is a catchable CONNECTION_CLOSED: the process never crashes,
 * nothing hangs, the pool recovers, and a dead transaction's later statements never run anywhere. postgres.js
 * 3.4.9 fails every test here without patches/postgres@3.4.9.patch (pnpm-workspace.yaml): an uncaught TypeError
 * from nextWrite(), a hung reservation, a stalled pool, the old backend's error replayed onto the next query, an
 * unhandled rejection from the array-type fetch, and a dead transaction's INSERT committed in autocommit.
 */
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { sql as dsql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../test/db';
import { type Database, drizzleFor, type Sql } from './client';

const tdb = useTestDb();
const pools: Sql[] = [];
const crashes: string[] = [];
const onUncaught = (err: unknown) => crashes.push(`uncaughtException: ${String(err)}`);
const onUnhandled = (err: unknown) => crashes.push(`unhandledRejection: ${String(err)}`);

beforeAll(async () => {
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  await tdb.sql`create table lost_session_rows (id int primary key)`;
});
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end({ timeout: 1 })));
  process.off('uncaughtException', onUncaught);
  process.off('unhandledRejection', onUnhandled);
});
beforeEach(() => {
  crashes.length = 0;
});
afterEach(() => {
  expect(crashes).toEqual([]);
});

/** The error's code, through drizzle's DrizzleQueryError (`cause`). */
function codeOf(err: unknown): string {
  for (let e = err; e; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return `no code: ${String(err)}`;
}

/** `p`'s value, or `fallback` when it takes longer than `ms`. */
async function within<T>(p: PromiseLike<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(resolve, ms, fallback);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** How `p` settles within `ms`: 'resolved', the error's code, or 'hung'. */
function outcome(p: PromiseLike<unknown>, ms = 5_000): Promise<string> {
  return within(
    Promise.resolve(p).then(() => 'resolved', codeOf),
    ms,
    'hung',
  );
}

/** What a statement of the transaction callback came to: the callback runs on after the transaction rejected. */
function later() {
  let set: (value: string) => void = () => {};
  const value = new Promise<string>((resolve) => {
    set = resolve;
  });
  return { set: (v: string) => set(v), value: () => within(value, 10_000, 'never got there') };
}

/** A crash surfaces a tick after the statement that caused it (nextWrite runs from setImmediate). */
async function expectNoCrash() {
  await sleep(100);
  expect(crashes).toEqual([]);
}

interface Pool {
  sql: Sql;
  db: Database;
  /** Resolves when the pool next sees one of its sessions end. */
  closed(): Promise<void>;
  /** Terminates backend `pid`, waiting for it to exit and for the pool to see its session end. */
  kill(pid: unknown): Promise<void>;
}

function openPool(max: number, url = tdb.url): Pool {
  const waiting: (() => void)[] = [];
  const sql = postgres(url, {
    max,
    onnotice: () => {},
    onclose: () => {
      for (const resolve of waiting.splice(0)) resolve();
    },
  });
  pools.push(sql);
  const closed = () => new Promise<void>((resolve) => waiting.push(resolve));
  return {
    sql,
    db: drizzleFor(sql),
    closed,
    async kill(pid) {
      const seen = closed();
      const [row] = await tdb.sql<
        { ok: boolean }[]
      >`select pg_terminate_backend(${Number(pid)}::int, 5000) as ok`;
      expect(row?.ok).toBe(true);
      expect(await outcome(seen)).toBe('resolved');
    },
  };
}

async function expectPoolWorks(pool: Pool) {
  expect(await outcome(pool.sql`select 1 as ok`)).toBe('resolved');
}

type Rows = readonly Record<string, unknown>[];
type Run = (strings: TemplateStringsArray, ...values: (string | number)[]) => Promise<Rows>;

/** The two ways server code opens a transaction; `run` issues a statement inside it. */
const transactions: {
  name: string;
  begin: <T>(pool: Pool, fn: (run: Run) => Promise<T>) => Promise<unknown>;
}[] = [
  {
    name: "drizzle's db.transaction",
    begin: (pool, fn) => pool.db.transaction((tx) => fn((s, ...v) => tx.execute(dsql(s, ...v)))),
  },
  {
    name: 'sql.begin',
    begin: (pool, fn) => pool.sql.begin((tx) => fn((s, ...v) => tx(s, ...v))),
  },
];

describe.each(transactions)('a session lost under $name', ({ begin }) => {
  it('rejects the transaction and its later statements when the callback continues, without crashing', async () => {
    const pool = openPool(1);
    const select = later();
    const tx = begin(pool, async (run) => {
      const [row] = await run`select pg_backend_pid() as pid`;
      await pool.kill(row?.pid);
      select.set(await outcome(run`select 2`));
      return 'committed';
    });
    expect(await outcome(tx)).toBe('CONNECTION_CLOSED');
    expect(await select.value()).toBe('CONNECTION_CLOSED');
    await expectNoCrash();
    await expectPoolWorks(pool);
  });

  it('rejects the transaction when the callback returns (its commit), without crashing', async () => {
    const pool = openPool(1);
    const returned = later();
    const tx = begin(pool, async (run) => {
      const [row] = await run`select pg_backend_pid() as pid`;
      await pool.kill(row?.pid);
      returned.set('returned');
      return 'committed';
    });
    expect(await outcome(tx)).toBe('CONNECTION_CLOSED');
    expect(await returned.value()).toBe('returned');
    await expectNoCrash();
    await expectPoolWorks(pool);
  });

  it('never runs the dead transaction’s INSERT on the session the pool reconnected for queued work', async () => {
    await tdb.sql`delete from lost_session_rows`;
    const pool = openPool(1);
    const queued = later();
    const insert = later();
    const tx = begin(pool, async (run) => {
      await run`insert into lost_session_rows values (${1})`;
      const [row] = await run`select pg_backend_pid() as pid`;
      // The transaction holds the only connection: this query waits in the pool's queue.
      const waiting = outcome(pool.sql`select 'queued' as q`);
      await pool.kill(row?.pid);
      // The pool reconnected the connection for the queued query, which ran on the new session.
      queued.set(await waiting);
      insert.set(await outcome(run`insert into lost_session_rows values (${2})`));
      return 'committed';
    });
    expect(await outcome(tx)).toBe('CONNECTION_CLOSED');
    expect(await queued.value()).toBe('resolved');
    expect(await insert.value()).toBe('CONNECTION_CLOSED');
    await sleep(100);
    const rows = await tdb.sql<{ id: number }[]>`select id from lost_session_rows order by id`;
    expect(rows.map((r) => r.id)).toEqual([]);
    await expectNoCrash();
    await expectPoolWorks(pool);
  });

  it('rejects cleanly when idle_in_transaction_session_timeout ends the transaction', async () => {
    const pool = openPool(1);
    const select = later();
    const tx = begin(pool, async (run) => {
      const ended = pool.closed();
      await run`set local idle_in_transaction_session_timeout = 100`;
      await outcome(ended);
      select.set(await outcome(run`select 3`));
      return 'committed';
    });
    expect(await outcome(tx)).toBe('CONNECTION_CLOSED');
    expect(await select.value()).toBe('CONNECTION_CLOSED');
    await expectNoCrash();
    await expectPoolWorks(pool);
  });
});

describe('the pool after a lost session', () => {
  it.each([
    ['sql', (pool: Pool) => pool.sql`select 42 as n`],
    ["drizzle's db.execute", (pool: Pool) => pool.db.execute(dsql`select 42 as n`)],
  ] as const)(
    'runs the next %s query on a fresh session (the old backend’s error is not replayed)',
    async (_, next) => {
      const pool = openPool(1);
      const [row] = await pool.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const sleeping = outcome(pool.sql`select pg_sleep(30)`, 10_000);
      // The FATAL must reach the client while the query is in flight.
      let active = false;
      for (let i = 0; i < 100 && !active; i++) {
        const found = await tdb.sql`select 1 from pg_stat_activity where pid = ${row?.pid ?? 0}::int
        and state = 'active' and query like 'select pg_sleep%'`;
        active = found.length > 0;
        if (!active) await sleep(20);
      }
      expect(active).toBe(true);
      await pool.kill(row?.pid);
      expect(await sleeping).toBe('CONNECTION_CLOSED');
      let n: unknown;
      const first = Promise.resolve(next(pool)).then((rows) => {
        n = rows[0]?.n;
      });
      expect(await outcome(first)).toBe('resolved');
      expect(n).toBe(42);
      await expectNoCrash();
    },
  );
});

describe('sql.reserve() on a lost session', () => {
  it('rejects the reserved handle’s queries instead of hanging, and release() leaves the pool working', async () => {
    const pool = openPool(1);
    const reserved = await pool.sql.reserve();
    const [row] = await reserved<{ pid: number }[]>`select pg_backend_pid() as pid, pg_try_advisory_lock(42)`;
    await pool.kill(row?.pid);
    expect(await outcome(reserved`select pg_advisory_unlock(42)`)).toBe('CONNECTION_CLOSED');
    reserved.release();
    await expectNoCrash();
    await expectPoolWorks(pool);
  });
});

describe('a session lost while the pool connects (the array-type fetch, postgres.js fetch_types)', () => {
  /** The ErrorResponse Postgres sends before closing a session ended by pg_terminate_backend or a shutdown. */
  function terminating(): Buffer {
    const field = (code: string, value: string) => Buffer.from(`${code}${value}\0`);
    const body = Buffer.concat([
      field('S', 'FATAL'),
      field('V', 'FATAL'),
      field('C', '57P01'),
      field('M', 'terminating connection due to administrator command'),
      Buffer.from('\0'),
    ]);
    const header = Buffer.alloc(5);
    header.write('E');
    header.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([header, body]);
  }

  /** A TCP proxy to the test Postgres that ends the first session when it fetches array types. */
  async function proxy(end: 'fatal' | 'reset') {
    const target = new URL(tdb.url);
    let ended = false;
    const server = net.createServer((client) => {
      const upstream = net.connect(Number(target.port || 5432), target.hostname);
      client.on('data', (chunk) => {
        if (!ended && chunk.includes('typarray')) {
          ended = true;
          if (end === 'fatal') client.end(terminating());
          else client.resetAndDestroy();
          upstream.destroy();
          return;
        }
        upstream.write(chunk);
      });
      upstream.on('data', (chunk) => client.writable && client.write(chunk));
      for (const [a, b] of [
        [client, upstream],
        [upstream, client],
      ] as const) {
        a.on('error', () => b.destroy());
        a.on('close', () => b.destroy());
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const url = new URL(tdb.url);
    url.hostname = '127.0.0.1';
    url.port = String(port);
    return { url: url.toString(), close: () => server.close() };
  }

  it.each([
    ['a FATAL and a clean close', 'fatal', '57P01'],
    ['a connection reset', 'reset', 'ECONNRESET'],
  ] as const)(
    'with %s: the waiting query gets the error, the process does not crash, the next query runs',
    async (_, end, code) => {
      const through = await proxy(end);
      try {
        const pool = openPool(1, through.url);
        expect(await outcome(pool.sql`select 1`)).toBe(code);
        await expectNoCrash();
        await expectPoolWorks(pool);
      } finally {
        through.close();
      }
    },
  );
});
