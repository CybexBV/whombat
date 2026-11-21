/**
 * How the box is doing (docs/decisions/box-status.md BS-06; contracts CT-334). The manager measures the box every 10 s
 * and keeps the history (BS-02, BS-03): the server is sandboxed without `/proc`, and nothing measured goes into
 * Postgres. The runtime only asks it — `POST /v1/host/metrics` on the manager socket — for the person's session op
 * `host.metrics` and for the disk alerts (`host-disk-alerts.ts`).
 *
 * A manager that doesn't answer within 2 s, answers 404 (before 0.78) or answers what the contract doesn't allow makes
 * the measurements `unavailable`, never an error. The app polls every 10 s while the section is open, so that is
 * logged at most once a minute.
 */
import { LOCAL_API_VERSION, MANAGER_PATHS } from '@whombat/control-contracts/local';
import type { HostMetricsInput, HostMetricsOutput } from '@whombat/protocol/session';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { burrows, principals } from '../db/schema/index';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';
import { ManagerCallError, type ManagerPort } from './ports';
import type { SessionPrincipal } from './trust';

/** How long the runtime waits for the manager's measurements (BS-06). */
export const HOST_METRICS_TIMEOUT_MS = 2_000;
/** A manager that doesn't answer is logged at most this often. */
const WARN_EVERY_MS = 60_000;

export class HostMetricsService {
  #warnedAt = Number.NEGATIVE_INFINITY;
  #unmeasured = false;

  constructor(
    private readonly services: Services,
    private readonly manager: ManagerPort,
  ) {}

  /** One range of the manager's measurements, its days counted in `timeZone`, or `unavailable`. Never throws. */
  async read(input: HostMetricsInput, timeZone: string): Promise<HostMetricsOutput> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ManagerCallError(MANAGER_PATHS.hostMetrics, 0, 'unreachable', 'host metrics: timed out'),
          ),
        HOST_METRICS_TIMEOUT_MS,
      );
    });
    try {
      const answer = await Promise.race([
        this.manager.hostMetrics({
          v: LOCAL_API_VERSION,
          range: input.range,
          ...(input.since ? { since: input.since } : {}),
          timeZone,
        }),
        timeout,
      ]);
      this.#unmeasured = false;
      return { metrics: answer.metrics, reason: null };
    } catch (err) {
      this.#unmeasured = err instanceof ManagerCallError && err.status === 503;
      this.#warn(err);
      return { metrics: null, reason: 'unavailable' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The last read was a manager that answered but hasn't measured the box yet (503, its first 10 s). */
  get unmeasured(): boolean {
    return this.#unmeasured;
  }

  #warn(err: unknown): void {
    const status = err instanceof ManagerCallError ? err.status : null;
    // A manager that just started answers 503 until its first sample (10 s): the desk's power check asks at boot
    // (desk-display-server.md), so that is expected, not a warning.
    if (status === 503) {
      this.services.log.debug({ status }, 'host metrics: the box hasn’t been measured yet');
      return;
    }
    const now = this.services.clock().getTime();
    if (now - this.#warnedAt < WARN_EVERY_MS) return;
    this.#warnedAt = now;
    this.services.log.warn(
      { err: String(err).slice(0, 300), status },
      status === 404
        ? 'host metrics: this manager doesn’t measure the box yet'
        : 'host metrics: the manager didn’t answer',
    );
  }
}

/**
 * The zone the person's days are counted in (BS-05, BS-D03): their oldest burrow's here — the zone `spend.overview`
 * counts “today” in —, else this Whombat's oldest burrow's, else UTC.
 */
export async function hostTimeZone(db: Db, accountId: string): Promise<string> {
  const [theirs] = await db
    .select({ timeZone: burrows.timeZone })
    .from(principals)
    .innerJoin(burrows, eq(burrows.id, principals.burrowId))
    .where(and(eq(principals.accountId, accountId), eq(principals.kind, 'person')))
    .orderBy(asc(burrows.createdAt), asc(burrows.id))
    .limit(1);
  if (theirs) return theirs.timeZone;
  const [oldest] = await db
    .select({ timeZone: burrows.timeZone })
    .from(burrows)
    .orderBy(asc(burrows.createdAt), asc(burrows.id))
    .limit(1);
  return oldest?.timeZone ?? 'UTC';
}

/**
 * The session op `host.metrics` (BS-06): for the person's devices; `not_managed` where no manager measures the box
 * (`host` absent), `unavailable` when it doesn't answer.
 */
export async function hostMetricsOp(
  c: { principal: SessionPrincipal; services: Services; host: HostMetricsService | undefined },
  input: HostMetricsInput,
): Promise<HostMetricsOutput> {
  if (!c.principal.account) throw new ApiError('unauthorized', 'Enroll this device first.');
  if (!c.host) return { metrics: null, reason: 'not_managed' };
  return c.host.read(input, await hostTimeZone(c.services.db, c.principal.account.id));
}
