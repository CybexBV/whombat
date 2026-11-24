/**
 * Figures over time per connection (connection-pages.md CP-15; dashboards.md DS-11; dashboards-server.md DS-S03): the
 * health pass stores its check's response time (`rtt_ms`, null when it failed) and whether it answered (`up`), the machine's disk (`disk_pct`,
 * `disk_gb`), Home Assistant's log errors and database (`log_err`, `log_err_top`, `db_mb`), UniFi's internet line,
 * gateway and clients, a NAS's used space (`nas_used_gb`), a device's numeric readings (`r_<key>`). Kept 30 days: 5-minute points for 48 hours, then one an
 * hour (their average, on the hour); the hourly job rolls them up and removes older ones. A page reads them back on its
 * range's grid (`series.ts`).
 */
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { connectionPoints } from '../db/schema/index';
import type { Services } from '../services';
import type { RawPoint } from './series';

export type { RawPoint } from './series';

/** How long points are kept (DS-11). */
export const POINTS_KEEP_MS = 30 * 24 * 3600_000;
/** How long 5-minute points stay before they are rolled into hours. */
export const POINTS_FINE_MS = 48 * 3600_000;

/** The response time key (ms; null: the check failed). */
export const RTT_KEY = 'rtt_ms';
/**
 * Whether the check answered (docs/decisions/monitoring.md MON-09): 1 or 0 each pass, none when Whombat couldn't run
 * it. An hour rolled up keeps the share it answered, so short outages stay in the uptime.
 */
export const UP_KEY = 'up';
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

/**
 * The hourly job (DS-11): points older than 30 days go; points older than 48 hours become one an hour per key — their
 * average (null when none of them had a value), on the hour. An hour already rolled up stays as it is.
 */
export async function rollUpPoints(services: Services, now = services.clock()): Promise<void> {
  const keepFrom = new Date(now.getTime() - POINTS_KEEP_MS);
  const fineFrom = new Date(now.getTime() - POINTS_FINE_MS);
  await services.pipeline.transactAccount(async (tx) => {
    await tx.delete(connectionPoints).where(lt(connectionPoints.at, keepFrom));
    // Each hour (UTC, whatever the session's zone) with more than one point, or one point off the hour, becomes one
    // point on the hour. The deleted rows feed the insert: the same statement, so an hour is never half rolled up.
    await tx.execute(sql`
      WITH hours AS (
        SELECT connection_id, key, date_bin('1 hour', at, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS hour
        FROM connection_points
        WHERE at < ${fineFrom.toISOString()}::timestamptz
        GROUP BY 1, 2, 3
        HAVING count(*) > 1 OR bool_or(at <> date_bin('1 hour', at, TIMESTAMPTZ '2000-01-01 00:00:00+00'))
      ), moved AS (
        DELETE FROM connection_points p
        USING hours h
        WHERE p.connection_id = h.connection_id AND p.key = h.key
          AND date_bin('1 hour', p.at, TIMESTAMPTZ '2000-01-01 00:00:00+00') = h.hour
        RETURNING p.connection_id, p.key, h.hour, p.value
      )
      INSERT INTO connection_points (connection_id, key, at, value)
      SELECT connection_id, key, hour, avg(value) FROM moved GROUP BY connection_id, key, hour
    `);
  });
}
