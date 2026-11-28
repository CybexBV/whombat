/**
 * One Whombat's periodic jobs (one-whombat-assistant.md ONE-DW21…), on the housekeeping tick:
 *
 * - **Approve later** (ONE-10), every 30 s: approved requests whose `execute_at` has come are re-evaluated, so the
 *   approvals engine runs them (it skips them before their time).
 * - **Widgets** (ONE-09), every 30 s: widgets due for a refresh are read without the model (`widgets.ts`).
 * - **Connection health**, every 5 minutes: each active connection's cheap check and glance (`health.ts`).
 * - **Connection points**, every hour: points older than 48 hours become one an hour, older than 30 days go
 *   (connection-pages.md CP-15, dashboards.md DS-11).
 * - **Looks**, every minute: the assistant looks into what needs a look by itself (look-research.md LR-01…LR-03,
 *   `looks/watch.ts`).
 * - **Looks ahead**, every five minutes: the assistant checks what is on the person's calendar the afternoon before
 *   (looks-ahead.md, `looks-ahead/watch.ts`).
 * - **Incidents**, every minute: outages kept from the same looks, and one push when something important went wrong
 *   (`incidents/watch.ts`).
 * - **Restore tests**, every minute: Proxmox machines' weekly restore tests, a step at a time (`backup-trust/runner.ts`).
 * - **Causes** and **the way out**, every minute: what each thing is down because of
 *   (`things/causes.ts`), and whether Whombat reaches its router, name lookups and the internet (`managed/way-out.ts`).
 * - **What changed on the servers**, every 10 minutes: restarts, kernels, updates installed and containers' images
 *   (`changes/servers.ts`; the connections' changes come with their health). **Settings copies**, every 15 minutes:
 *   a nightly copy of a few services' settings (`changes/copies/run.ts`).
 *
 * Kept out of the `Services` interface (`homeJobsFor`), like the connection pool.
 */
import { and, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { type RestoreTests, restoreTestsFor } from '../backup-trust/runner';
import { CareWatcher } from '../care/watch';
import { SETTINGS_COPIES_MS, settingsCopyPass } from '../changes/copies/run';
import { CHANGES_SERVERS_MS, changesServerPass } from '../changes/servers';
import { approvals } from '../db/schema/index';
import { INCIDENTS_WATCH_MS, IncidentWatcher } from '../incidents/watch';
import { LookWatcher, WATCH_MS } from '../looks/watch';
import { AHEAD_WATCH_MS, AheadWatcher } from '../looks-ahead/watch';
import { WAY_OUT_CHECK_MS, WayOutWatch } from '../managed/way-out';
import type { Services } from '../services';
import { CAUSES_MS, passCauses } from '../things/causes';
import { HEALTH_POINT_MS, rollUpPoints } from '../things/points';
import { pollConnectionHealth } from './health';
import { pollMailGlances } from './mail-glance';
import { refreshDueWidgets } from './widgets';

const APPROVE_LATER_MS = 30_000;
const WIDGETS_MS = 30_000;
export const HEALTH_MS = HEALTH_POINT_MS;
const POINTS_PRUNE_MS = 60 * 60_000;

/** Runs the approved requests whose time has come (Approve later). Returns how many burrows it re-evaluated. */
export async function runDueApprovals(services: Services, now = services.clock()): Promise<number> {
  const rows = await services.db
    .select({ id: approvals.id, burrowId: approvals.burrowId })
    .from(approvals)
    .where(
      and(
        isNotNull(approvals.executeAt),
        lte(approvals.executeAt, now),
        isNull(approvals.executedAt),
        sql`${approvals.state} = 'approved'`,
        sql`${approvals.execution}->>'state' = 'idle'`,
      ),
    )
    .limit(200);
  const byBurrow = new Map<string, string[]>();
  for (const r of rows) byBurrow.set(r.burrowId, [...(byBurrow.get(r.burrowId) ?? []), r.id]);
  for (const [burrowId, approvalIds] of byBurrow)
    await services.approvals.reevaluate(burrowId, { approvalIds });
  return byBurrow.size;
}

class HomeJobs {
  #stops: (() => void)[] = [];
  #running = new Set<Promise<unknown>>();
  readonly #looks: LookWatcher;
  readonly #ahead: AheadWatcher;
  readonly #care: CareWatcher;
  readonly #incidents: IncidentWatcher;
  readonly #wayOut: WayOutWatch;
  readonly #restoreTests: RestoreTests;

  constructor(private readonly services: Services) {
    this.#looks = new LookWatcher(services);
    this.#ahead = new AheadWatcher(services);
    this.#care = new CareWatcher(services);
    this.#incidents = new IncidentWatcher(services);
    this.#wayOut = new WayOutWatch(services);
    this.#restoreTests = restoreTestsFor(services);
  }

  start(): void {
    if (this.#stops.length) return;
    this.#restoreTests.start();
    this.#stops.push(() => this.#restoreTests.close());
    const job = (name: string, everyMs: number, run: () => Promise<unknown>) =>
      this.services.housekeeping.add(name, everyMs, async () => {
        if (this.services.maintenance.held) return;
        const p = run()
          .catch((err) => this.services.log.warn({ err: String(err) }, `${name}: tick failed`))
          .finally(() => this.#running.delete(p));
        this.#running.add(p);
        await p;
      });
    this.#stops.push(
      job('home.approve-later', APPROVE_LATER_MS, () => runDueApprovals(this.services)),
      job('home.widgets', WIDGETS_MS, () => refreshDueWidgets(this.services)),
      job('home.connection-health', HEALTH_MS, async () => {
        await pollConnectionHealth(this.services);
        await pollMailGlances(this.services);
      }),
      job('home.connection-points-prune', POINTS_PRUNE_MS, () => rollUpPoints(this.services)),
      job('home.looks', WATCH_MS, () => this.#looks.pass()),
      job('home.looks-ahead', AHEAD_WATCH_MS, () => this.#ahead.pass()),
      // A care plan for a server that was just added (care-plan.md).
      job('home.care', WATCH_MS, () => this.#care.pass()),
      // Weekly restore tests of Proxmox machines (backup-trust.md).
      job('home.restore-tests', WATCH_MS, () => this.#restoreTests.tick()),
      job('home.incidents', INCIDENTS_WATCH_MS, () => this.#incidents.pass()),
      // The box's own way out, then what each thing is down because of.
      job('home.way-out', WAY_OUT_CHECK_MS, () => this.#wayOut.pass()),
      job('home.causes', CAUSES_MS, () => passCauses(this.services)),
      job('home.changes-servers', CHANGES_SERVERS_MS, () => changesServerPass(this.services)),
      job('home.settings-copies', SETTINGS_COPIES_MS, () => settingsCopyPass(this.services)),
    );
  }

  async close(): Promise<void> {
    for (const stop of this.#stops) stop();
    this.#stops = [];
    await Promise.allSettled([...this.#running]);
  }
}

const jobs = new WeakMap<Services, HomeJobs>();

export function homeJobsFor(services: Services): HomeJobs {
  let j = jobs.get(services);
  if (!j) {
    j = new HomeJobs(services);
    jobs.set(services, j);
  }
  return j;
}
