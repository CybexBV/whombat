/**
 * Figures over time per connection (connection-pages.md CP-15; dashboards.md DS-11; dashboards-server.md DS-S03): the
 * health pass stores its check's response time (`rtt_ms`, null when it failed) and whether it answered (`up`), the machine's disk (`disk_pct`,
 * `disk_gb`), Home Assistant's log errors and database (`log_err`, `log_err_top`, `db_mb`), UniFi's internet line,
 * gateway and clients, a NAS's used space (`nas_used_gb`), a device's numeric readings (`r_<key>`). Kept 30 days: 5-minute points for 48 hours, then one an
 * hour (their average, on the hour); the hourly job rolls them up and removes older ones. A page reads them back on its
 * range's grid (`series.ts`).
 */
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { outsideCommandScope } from '../commit/scope';
import type { Db, Tx } from '../db/client';
import { accountUptimePoints, connectionPoints } from '../db/schema/index';
import type { Services } from '../services';
import type { RawPoint } from './series';

export type { RawPoint } from './series';

/** How long points are kept (DS-11). */
export const POINTS_KEEP_MS = 30 * 24 * 3600_000;
/** How often the health pass records a point. */
export const HEALTH_POINT_MS = 5 * 60_000;
/** How long 5-minute points stay before they are rolled into hours. */
export const POINTS_FINE_MS = 48 * 3600_000;
const HOUR_MS = 3600_000;

/** An hour rolls up once it is old enough in full. */
export const pointRollupBefore = (now: Date) =>
  Math.floor((now.getTime() - POINTS_FINE_MS) / HOUR_MS) * HOUR_MS;

/** The response time key (ms; null: the check failed). */
export const RTT_KEY = 'rtt_ms';
/**
 * Whether the check answered: 1 or 0 each pass, none when Whombat couldn't run
 * it. An hour rolled up keeps the share it answered, so short outages stay in the uptime.
 */
export const UP_KEY = 'up';
/** How many readings an hourly uptime point covers. */
export const UP_COUNT_KEY = 'up_n';
/** The machine it runs on: its disk used, in percent and in GB (CP-08). */
export const DISK_PCT_KEY = 'disk_pct';
export const DISK_GB_KEY = 'disk_gb';
/** Home Assistant: errors in its log since it started, the noisiest source's, the recorder's size in MB. */
export const LOG_ERR_KEY = 'log_err';
export const LOG_ERR_TOP_KEY = 'log_err_top';
export const DB_MB_KEY = 'db_mb';
/** UniFi: the gateway's CPU and memory (%) and the clients connected. */
export const GW_CPU_KEY = 'gw_cpu';
export const GW_MEM_KEY = 'gw_mem';
export const CLIENTS_KEY = 'clients';

/** A device reading's key (`r_<key>`, cut to the contract's key length). */
export function readingKey(key: string): string {
  return `r_${key.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`.slice(0, 40);
}

/** A device's points (CP-15): its first three numeric readings, `r_<key>`; one that couldn't be read is null. */
export function devicePoints(
  readings: readonly { key: string; value: unknown }[] | null,
  previous: readonly { key: string; value: unknown }[] | null,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (readings) {
    for (const r of readings.filter((x) => typeof x.value === 'number').slice(0, 3))
      out[readingKey(r.key)] = r.value as number;
  } else {
    // The device didn't answer: a gap in the lines it had.
    for (const r of (previous ?? []).filter((x) => typeof x.value === 'number').slice(0, 3))
      out[readingKey(r.key)] = null;
  }
  return out;
}

/** Stores one moment's values (inside the caller's transaction); a value of `undefined` is left out. */
export async function recordPoints(
  tx: Tx | Db,
  connectionId: string,
  at: Date,
  values: Record<string, number | null | undefined>,
): Promise<void> {
  const rows = Object.entries(values)
    .filter((e): e is [string, number | null] => e[1] !== undefined)
    .map(([key, value]) => ({
      connectionId,
      at,
      key,
      value: value === null || !Number.isFinite(value) ? null : value,
    }));
  if (rows.length) await tx.insert(connectionPoints).values(rows).onConflictDoNothing();
}

/** Some keys of a connection since `sinceMs` ago (24 hours by default), oldest first. */
export async function readPoints(
  db: Db | Tx,
  connectionId: string,
  keys: readonly string[],
  now: Date,
  sinceMs = 24 * 3600_000,
): Promise<Map<string, RawPoint[]>> {
  const out = new Map<string, RawPoint[]>(keys.map((k) => [k, []]));
  if (!keys.length) return out;
  const rows = await db
    .select()
    .from(connectionPoints)
    .where(
      and(
        eq(connectionPoints.connectionId, connectionId),
        inArray(connectionPoints.key, [...keys]),
        gte(connectionPoints.at, new Date(now.getTime() - Math.min(sinceMs, POINTS_KEEP_MS))),
      ),
    )
    .orderBy(asc(connectionPoints.at))
    // 48 hours of 5-minute points and 28 days of hours, with room to spare.
    .limit(keys.length * 2000);
  for (const r of rows) out.get(r.key)?.push({ at: r.at, value: r.value });
  return out;
}

type AccountUptimeOwner = { connectionId: string } | { githubBurrowId: string };

/** A fresh account read counts at most once per five minutes, even when several parts are read. */
export async function recordAccountUptime(
  services: Services,
  owner: AccountUptimeOwner,
  up: 0 | 1,
): Promise<void> {
  const at = new Date(Math.floor(services.clock().getTime() / HEALTH_POINT_MS) * HEALTH_POINT_MS);
  const points = accountUptimePoints;
  await outsideCommandScope(() =>
    services.pipeline.transactAccount(async (tx) => {
      await tx
        .insert(points)
        .values({ ...owner, at, up })
        .onConflictDoUpdate({
          target: [points.connectionId, points.githubBurrowId, points.at],
          set: { up: sql`greatest(${points.up}, excluded.up)` },
          // Concurrent reads can finish in either order. One working read establishes that the account answered.
          setWhere: sql`${points.samples} is null and ${points.up} < excluded.up`,
        });
    }),
  ).catch((err) => services.log.debug({ err: String(err) }, 'account uptime: reading could not be saved'));
}

export async function readAccountUptime(db: Db, owner: AccountUptimeOwner, from: Date) {
  const points = accountUptimePoints;
  return db
    .select({ at: points.at, value: points.up, samples: points.samples })
    .from(points)
    .where(
      and(
        'connectionId' in owner
          ? eq(points.connectionId, owner.connectionId)
          : eq(points.githubBurrowId, owner.githubBurrowId),
        gte(points.at, from),
      ),
    )
    .orderBy(asc(points.at))
    .limit(2000);
}

/**
 * Points older than 30 days go. Points older than 48 hours become hourly averages. Keep the number of uptime
 * readings too, so an hour with just one reading doesn't weigh as much as an hour with twelve.
 */
export async function rollUpPoints(services: Services, now = services.clock()): Promise<void> {
  const keepFrom = new Date(now.getTime() - POINTS_KEEP_MS);
  const fineFrom = new Date(pointRollupBefore(now));
  await services.pipeline.transactAccount(async (tx) => {
    await tx.delete(connectionPoints).where(lt(connectionPoints.at, keepFrom));
    await tx.delete(accountUptimePoints).where(lt(accountUptimePoints.at, keepFrom));
    // The deleted rows feed the insert, so the average and the count are saved together.
    await tx.execute(sql`
      WITH old_points AS (
        SELECT connection_id, key, at, date_bin('1 hour', at, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS hour
        FROM connection_points WHERE at < ${fineFrom.toISOString()}::timestamptz AND key <> ${UP_COUNT_KEY}
      ), hours AS (
        SELECT connection_id, key, hour FROM old_points p
        GROUP BY 1, 2, 3
        HAVING count(*) > 1 OR bool_or(at <> hour)
          OR (key = ${UP_KEY} AND NOT EXISTS (
            SELECT 1 FROM connection_points n WHERE n.connection_id = p.connection_id
              AND n.key = ${UP_COUNT_KEY} AND n.at = p.hour
          ))
      ), moved AS (
        DELETE FROM connection_points p
        USING hours h
        WHERE p.connection_id = h.connection_id AND p.key = h.key
          AND date_bin('1 hour', p.at, TIMESTAMPTZ '2000-01-01 00:00:00+00') = h.hour
        RETURNING p.connection_id, p.key, h.hour, p.at, p.value
      ), totals AS (
        SELECT m.connection_id, m.key, m.hour,
          sum(m.value * coalesce(n.value, 1)) / nullif(sum(coalesce(n.value, 1)) FILTER (WHERE m.value IS NOT NULL), 0) AS average,
          coalesce(sum(coalesce(n.value, 1)) FILTER (WHERE m.value IS NOT NULL), 0) AS samples
        FROM moved m
        LEFT JOIN connection_points n ON m.key = ${UP_KEY} AND n.connection_id = m.connection_id
          AND n.key = ${UP_COUNT_KEY} AND n.at = m.at
        GROUP BY m.connection_id, m.key, m.hour
      )
      INSERT INTO connection_points (connection_id, key, at, value)
      SELECT connection_id, key, hour, average FROM totals
      UNION ALL
      SELECT connection_id, ${UP_COUNT_KEY}, hour, samples FROM totals WHERE key = ${UP_KEY}
      ON CONFLICT (connection_id, key, at) DO UPDATE SET value = excluded.value
    `);
    await tx.execute(sql`
      WITH moved AS (
        DELETE FROM account_uptime_points WHERE at < ${fineFrom.toISOString()}::timestamptz AND samples IS NULL
        RETURNING connection_id, github_burrow_id, at, up
      )
      INSERT INTO account_uptime_points (connection_id, github_burrow_id, at, up, samples)
      SELECT connection_id, github_burrow_id, date_bin('1 hour', at, TIMESTAMPTZ '2000-01-01 00:00:00+00'),
        avg(up), count(*)
      FROM moved GROUP BY 1, 2, 3
      ON CONFLICT ON CONSTRAINT account_uptime_slot DO UPDATE SET
        up = (account_uptime_points.up * account_uptime_points.samples + excluded.up * excluded.samples)
          / (account_uptime_points.samples + excluded.samples),
        samples = account_uptime_points.samples + excluded.samples
    `);
  });
}
