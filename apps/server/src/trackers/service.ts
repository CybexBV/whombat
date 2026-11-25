/**
 * The tracker poller (docs/decisions/report-trackers.md TA-05, TA-06): it reads only the tracker connections a live
 * automation listens to, every 60 s (trackers send no webhooks), single flight per connection, skipped while
 * maintenance is paused or the licence lapsed, after a failure 1 min doubling to 15 min. Newest first, page by page
 * until a page reaches the cursor (at most 5 pages a cycle). The first read is a baseline: nothing fires. After it a
 * report is new when its number is past `after` and the tracker says it was filed no earlier than an hour before
 * `since`; at most 20 a cycle, oldest first, each mirrored once (`tracker.item_opened`, TA-07). When nothing listens
 * any more the cursor is cleared, so the next listener starts with a new baseline. Each tick also revokes the
 * organization access of steps that have settled. Each cycle also fills in the tracker's organization id of mirrored
 * reports that have none and ends the feature request cards of reports closed in the tracker; an intake that can't go
 * on by itself — a backlog past what a cycle reads, or an hour of failed polls — tells the person once per streak
 * (`stuck.ts`). Before all that, a cycle forgets the reports the tracker erased (`erase.ts`, its driver's `erasures`), and
 * a connection nothing listens to that still keeps mirrored reports is read for that alone.
 */
import { and, eq, inArray, isNotNull, isNull, notInArray } from 'drizzle-orm';
import { outsideCommandScope } from '../commit/scope';
import type { CatalogConnectionRow } from '../connections/types';
import { trackerCursors, trackerItems } from '../db/schema/index';
import type { Services } from '../services';
import { revokeSettledGrants } from './access';
import { tokenRefused, trackerConnectionRow, trackerDriver } from './connection';
import type { TrackerItem } from './driver';
import { type BoundDriver, TrackerDrivers } from './drivers';
import { ERASE_PER_COMMIT, eraseTrackerItems, keepingBurrow, keepingConnections, keptReports } from './erase';
import { SourceProblem, TrackerNotFound } from './errors';
import { closedReportRequests, endClosedReportRequests } from './features';
import { customerSaid, followFixes, healthOf } from './fixes';
import { mirroredReport } from './items';
import { mirrorTrackerItem, noteReportOrganizations, ORGANIZATIONS_PER_CYCLE } from './mirror';
import { trackerPrincipalIn } from './principal';
import {
  changed,
  customerAnswer,
  noteSeen,
  reporterReplied,
  seenOf,
  type Watched,
  watchedReports,
} from './replies';
import { listenedConnections } from './store';
import {
  backlogText,
  FAILING_NOTICE_MS,
  failingText,
  goneText,
  resendLimited,
  type StuckNotice,
  tellStuck,
  unreadableText,
} from './stuck';
import { resendUnlanded } from './unlanded';

export interface TrackerTimings {
  /** How often the housekeeping tick looks for connections that are due. */
  tickMs: number;
  /** Between reads of a connection that answered. */
  intervalMs: number;
  /** After a failure: the first wait, doubling up to `retryMaxMs`. */
  retryMinMs: number;
  retryMaxMs: number;
}

export const DEFAULT_TRACKER_TIMINGS: TrackerTimings = {
  tickMs: 15_000,
  intervalMs: 60_000,
  retryMinMs: 60_000,
  retryMaxMs: 15 * 60_000,
};

/** New reports one cycle mirrors at most; the rest come next time. */
export const MAX_NEW = 20;
/** Watched reports past the pages a cycle read that it reads one by one, in turn. */
export const DEEPER_PER_CYCLE = 10;
/** How many turns running a deeper watched report may fail to be read before the person hears (TA-64). */
export const DEEPER_MISSES = 3;
/** How long before the baseline a report's creation may lie and still be new (clocks differ). */
export const CLOCK_SLACK_MS = 60 * 60_000;
/** Pages of the tracker's erased reports one cycle reads at most; the rest come next time. */
export const ERASURE_PAGES = 5;

/** What one cycle did (tests, logs). */
export interface PollResult {
  skipped?: 'not_listened' | 'not_connected' | 'needs_token' | 'paused';
  baseline?: boolean;
  /** Reports mirrored now. */
  mirrored: number;
  /** Reports that didn't parse (skipped, never fatal). */
  invalid: number;
  /** Customers' answers on watched reports (TA-31). */
  answers?: number;
  /** Mirrored reports that got the tracker's organization id now. */
  organizations?: number;
  /** Feature request cards ended because their report was closed in the tracker. */
  closedRequests?: number;
  /** Mirrored reports forgotten because the tracker erased them. */
  erased?: number;
  problem?: string;
}

type CursorRow = typeof trackerCursors.$inferSelect;

export class TrackerService {
  readonly timings: TrackerTimings;
  #started = false;
  #closed = false;
  #ticker: (() => void) | null = null;
  readonly #running = new Map<string, Promise<PollResult>>();
  readonly #next = new Map<string, number>();
  readonly #backoff = new Map<string, number>();
  readonly #background = new Set<Promise<unknown>>();
  /** Where each connection's turn through its deeper watched reports is (`DEEPER_PER_CYCLE` a cycle). */
  readonly #deeperTurn = new Map<string, number>();
  /** How many turns running a deeper watched report couldn't be read, by its tracker id. */
  readonly #unreadDeeper = new Map<string, number>();
  /** When a connection's current run of failed polls began, as this process saw it. */
  readonly #failingSince = new Map<string, number>();
  /** The notices to the person this process has handled already, by key. */
  readonly #told = new Set<string>();
  /** `performance.now()` of the last sweep of settled steps' access. */
  #lastSweep = Number.NEGATIVE_INFINITY;
  /** `performance.now()` of the last pass over the fixes Whombat follows, and that pass while it runs (single flight). */
  #lastFixes = Number.NEGATIVE_INFINITY;
  #fixing: Promise<number> | null = null;
  /** The drivers of this Whombat's trackers, loaded from the plugins folder at start. */
  readonly drivers: TrackerDrivers;
  /** Test seam: the driver a connection is talked to with. */
  driverFor: (row: CatalogConnectionRow) => BoundDriver = (row) => trackerDriver(this.services, row);
  constructor(
    private readonly services: Services,
    timings: Partial<TrackerTimings> = {},
  ) {
    this.timings = { ...DEFAULT_TRACKER_TIMINGS, ...timings };
    this.drivers = new TrackerDrivers(services);
  }

  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#ticker = this.services.housekeeping.add(
      'tracker',
      () => this.timings.tickMs,
      () => this.tick(),
      { first: 'tick' },
    );
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#ticker?.();
    this.#ticker = null;
    await Promise.allSettled([...this.#running.values(), ...this.#background, this.#fixing]);
  }

  /**
   * Runs `work` in the background, tracked so `close` and tests can wait for it. Outside any command scope: a step's
   * commit asks for it from its `after` hook, and the work commits as itself (managed-runtime.md MR-06).
   */
  background(work: () => Promise<unknown>): void {
    if (this.#closed) return;
    const run = outsideCommandScope(work)
      .catch((err) =>
        this.services.log.warn({ err: String(err).slice(0, 200) }, 'tracker: background work failed'),
      )
      .finally(() => this.#background.delete(run));
    this.#background.add(run);
  }

  /** Tests: the background work has finished. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.#background]);
  }

  #paused(): boolean {
    return this.services.maintenance.paused || this.services.licence.lapsed;
  }

  /** One tick: cursors nothing listens to are cleared, due connections are read, settled steps' access is revoked. */
  async tick(): Promise<void> {
    if (this.#closed || this.#paused()) return;
    const listened = await listenedConnections(this.services.db);
    // Nothing listens any more: the next listener starts with a new baseline (TA-06).
    const ids = [...listened.keys()];
    // A connection nothing listens to that still keeps mirrored reports is read for its tracker's erasures only.
    const keeping = await keepingConnections(this.services.db, ids);
    await this.services.db
      .update(trackerCursors)
      .set({ since: null, after: null, updatedAt: this.services.clock() })
      .where(
        and(
          isNotNull(trackerCursors.since),
          ids.length ? notInArray(trackerCursors.connectionId, ids) : undefined,
        ),
      );
    const now = this.services.clock().getTime();
    for (const id of [...ids, ...keeping]) {
      if (this.#closed || this.#paused()) return;
      if (this.#running.has(id) || now < (this.#next.get(id) ?? 0)) continue;
      void this.pollNow(id).catch(() => {});
    }
    const mono = performance.now();
    // The fixes Whombat follows move along at most once a poll interval (TA-29…TA-33), in the background.
    if (mono - this.#lastFixes >= this.timings.intervalMs && !this.#fixing) {
      this.#lastFixes = mono;
      void this.followFixesNow().catch(() => {});
      // A needs-you notice lost right after its run ended is sent now (TA-61), and one for reports a run limit skipped
      // (TA-64).
      void outsideCommandScope(async () => {
        await resendUnlanded(this.services);
        await resendLimited(this.services);
      }).catch((err) =>
        this.services.log.warn(
          { err: String(err).slice(0, 200) },
          'tracker: resending needs-you notices failed',
        ),
      );
    }
    // What the tracker didn't confirm revoking is tried again, at most once a poll interval.
    if (mono - this.#lastSweep < this.timings.intervalMs) return;
    this.#lastSweep = mono;
    await revokeSettledGrants(this.services, {}).catch((err) =>
      this.services.log.warn({ err: String(err).slice(0, 200) }, 'tracker: revoking access failed'),
    );
  }

  /**
   * One pass over the fixes Whombat follows now (TA-29…TA-33): merged, live, the customer told. Concurrent calls share
   * the running pass. Answers how many fixes it looked at.
   */
  followFixesNow(): Promise<number> {
    if (this.#fixing) return this.#fixing;
    if (this.#closed || this.#paused()) return Promise.resolve(0);
    const run = outsideCommandScope(() => followFixes(this.services, (row) => this.driverFor(row)))
      .catch((err) => {
        this.services.log.warn({ err: String(err).slice(0, 300) }, 'tracker: following fixes failed');
        return 0;
      })
      .finally(() => {
        this.#fixing = null;
      });
    this.#fixing = run;
    return run;
  }

  /** One cycle of a connection now; concurrent calls share the running one. */
  pollNow(connectionId: string): Promise<PollResult> {
    const running = this.#running.get(connectionId);
    if (running) return running;
    const run = this.#cycle(connectionId)
      .then(
        (result) => {
          this.#schedule(connectionId, !!result.problem);
          return result;
        },
        (err: unknown) => {
          // Not a problem the cycle names: still logged, and still waited out like one.
          this.services.log.warn({ err: String(err).slice(0, 200), connectionId }, 'tracker: poll failed');
          this.#schedule(connectionId, true);
          throw err;
        },
      )
      .finally(() => this.#running.delete(connectionId));
    this.#running.set(connectionId, run);
    return run;
  }

  #schedule(connectionId: string, failed: boolean): void {
    const now = this.services.clock().getTime();
    if (!failed) {
      this.#backoff.delete(connectionId);
      this.#next.set(connectionId, now + this.timings.intervalMs);
      return;
    }
    const prev = this.#backoff.get(connectionId) ?? 0;
    const wait = prev ? Math.min(prev * 2, this.timings.retryMaxMs) : this.timings.retryMinMs;
    this.#backoff.set(connectionId, wait);
    this.#next.set(connectionId, now + wait);
  }

  async #cursor(row: CatalogConnectionRow): Promise<CursorRow> {
    const now = this.services.clock();
    await this.services.db
      .insert(trackerCursors)
      .values({ connectionId: row.id, burrowId: row.burrowId as string, updatedAt: now })
      .onConflictDoNothing();
    const [cursor] = await this.services.db
      .select()
      .from(trackerCursors)
      .where(eq(trackerCursors.connectionId, row.id));
    if (!cursor) throw new Error('no cursor');
    return cursor;
  }

  async #set(connectionId: string, values: Partial<typeof trackerCursors.$inferInsert>): Promise<void> {
    await this.services.db
      .update(trackerCursors)
      .set({ ...values, updatedAt: this.services.clock() })
      .where(eq(trackerCursors.connectionId, connectionId));
  }

  async #cycle(connectionId: string): Promise<PollResult> {
    const result: PollResult = { mirrored: 0, invalid: 0 };
    if (this.#paused()) return { ...result, skipped: 'paused' };
    const listened = (await listenedConnections(this.services.db)).get(connectionId);
    if (!listened) {
      const erased = await this.#unlistenedErasures(connectionId);
      return { ...result, skipped: 'not_listened', ...(erased ? { erased } : {}) };
    }
    const row = await trackerConnectionRow(this.services.db, listened.burrowId, connectionId);
    if (!row?.burrowId) return { ...result, skipped: 'not_connected' };
    const cursor = await this.#cursor(row);
    const now = this.services.clock();
    await this.#set(row.id, { checkedAt: now });
    // A token the tracker refused waits for a new one (“Needs a new token”, TA-03); the cursor says why meanwhile.
    if (row.status === 'needs_reauth') {
      await this.#set(row.id, {
        problemCode: 'refused',
        problem: `${row.label} needs a new token: the tracker refused the one it has.`,
      });
      // The connection's repair message tells the person, not the failing notice.
      this.#failingSince.delete(row.id);
      return { ...result, skipped: 'needs_token', problem: 'refused' };
    }
    try {
      const driver = this.driverFor(row);
      // What the tracker erased since the last look is forgotten first (never fails the cycle).
      const erased = await this.#erasures(row, driver, cursor);
      if (erased) result.erased = erased;
      if (cursor.since === null || cursor.after === null) {
        // The baseline (TA-06): nothing that exists now is new.
        const page = await driver.poll({ after: null, watch: [] });
        const after = Math.max(
          0,
          ...page.items.map((i) => i.number),
          ...page.unreadable.map((u) => u.number).filter((n): n is number => n !== null),
        );
        await this.#set(row.id, {
          since: now,
          after,
          succeededAt: now,
          problemCode: null,
          problem: null,
        });
        this.#failingSince.delete(row.id);
        return { ...result, baseline: true };
      }
      const after = cursor.after;
      // The reports an automation ran for that are still open: read as far down as the lowest (TA-31).
      const watched = await watchedReports(this.services.db, row.id);
      const read = await driver.poll({ after, watch: watched.map((w) => w.number) });
      // Never past a report it didn't read: when even a catch-up doesn't reach the cursor, nothing moves and the
      // connection says so (TA-59).
      this.#failingSince.delete(row.id);
      if (read.backlog) {
        await this.#set(row.id, {
          succeededAt: now,
          problemCode: 'backlog',
          problem: `${row.label} has more new reports than Whombat reads at once, so none were taken yet.`,
        });
        // It doesn't clear by itself (the cursor stays where it is): the person hears it, once while it lasts.
        await this.#notice(row, {
          key: `tracker_backlog:${row.id}:${cursor.since.getTime()}:${after}`,
          where: row.label,
          text: backlogText(row.label),
        });
        return result;
      }
      const from = cursor.since.getTime() - CLOCK_SLACK_MS;
      const parsed: TrackerItem[] = read.items;
      const watchedNumbers = new Set(watched.map((x) => x.number));
      for (const r of read.unreadable) {
        const n = r.number;
        // A new report it can't read isn't taken, and a watched one's customer answers go unread: the person hears,
        // once a report (TA-64's notice; a report without a number by its id).
        const isNew = n === null || n > after;
        if (isNew) result.invalid++;
        if (isNew || watchedNumbers.has(n))
          await this.#notice(row, {
            key: `tracker_unreadable:${row.id}:${n ?? r.id ?? 'unknown'}`,
            where: row.label,
            text: unreadableText(row.label, n, !isNew),
          });
      }
      const later = parsed.filter((r) => r.number > after).sort((a, b) => a.number - b.number);
      const fresh = later.filter((r) => {
        const created = Date.parse(r.createdAt);
        return !Number.isNaN(created) && created >= from;
      });
      const handled = fresh.slice(0, MAX_NEW);
      let moved = after;
      if (handled.length) {
        const signer = await this.#signer(row.burrowId);
        for (const report of handled) {
          const seen = seenOf(report);
          const res = await this.services.pipeline.commit(
            mirrorTrackerItem,
            {
              connectionId: row.id,
              product: driver.words.product,
              report: mirroredReport(report),
              seen: {
                status: seen.status,
                updatedAt: seen.updatedAt.toISOString(),
                reporterMessages: seen.reporterMessages,
                reporterAt: seen.reporterAt?.toISOString() ?? null,
              },
            },
            { burrowId: row.burrowId, actorId: signer },
          );
          if (res.status !== 'ok') throw new Error(`tracker.item_opened: ${res.status}`);
          if (res.result.created) result.mirrored++;
          moved = Math.max(moved, report.number);
        }
      }
      // Everything listed past the cursor was handled (or is history): the cursor moves past it. With more new ones
      // than a cycle mirrors, it stops at the last one handled and the rest come next time.
      if (fresh.length <= MAX_NEW) for (const r of later) moved = Math.max(moved, r.number);
      await this.#set(row.id, { after: moved, succeededAt: now, problemCode: null, problem: null });
      // Rows mirrored before Whombat kept the organization's id get it from what this cycle read.
      result.organizations = await this.#organizations(row, parsed);
      if (result.mirrored)
        this.services.log.info(
          { connectionId: row.id, mirrored: result.mirrored },
          'tracker: new reports for automations',
        );
      // What the customers of the watched reports did since the last look (TA-31).
      // Watched reports deeper than the pages read this cycle are read one by one, a few each cycle in turn, so a
      // customer's answer on an older report is never left unread (TA-31).
      const listed = new Set(parsed.map((r) => r.id));
      const deeper = watched.filter((w) => !listed.has(w.externalId));
      const extra: TrackerItem[] = [];
      if (deeper.length) {
        const turn = (this.#deeperTurn.get(row.id) ?? 0) % deeper.length;
        const picked = [...deeper.slice(turn), ...deeper.slice(0, turn)].slice(0, DEEPER_PER_CYCLE);
        this.#deeperTurn.set(row.id, turn + picked.length);
        for (const w of picked) {
          let gone = false;
          let understood = true;
          const one = await driver.item(w.externalId).catch((err: unknown) => {
            gone = err instanceof TrackerNotFound;
            understood = !(err instanceof SourceProblem && err.code === 'invalid_answer');
            return null;
          });
          if (one) {
            extra.push(one);
            this.#unreadDeeper.delete(w.externalId);
            continue;
          }
          // Read but not understood, or not read three turns running: its customer's answers can't be followed, and
          // the person hears, once a report (TA-64).
          const misses = (this.#unreadDeeper.get(w.externalId) ?? 0) + 1;
          this.#unreadDeeper.set(w.externalId, misses);
          if (!understood || misses >= DEEPER_MISSES)
            await this.#notice(row, {
              key: `tracker_unreadable:${row.id}:${w.number}`,
              where: row.label,
              // The tracker saying it has no such report: it was deleted there, not unreadable.
              text: gone ? goneText(row.label, w.number) : unreadableText(row.label, w.number, true),
            });
        }
      }
      result.answers = await this.#answers(row, watched, [...parsed, ...extra]);
      // A card still waiting for a report that is closed now can't be answered any more.
      result.closedRequests = await this.#closedRequests(row);
      if (result.mirrored || result.answers) this.services.automations.nudge();
      // Which installation it is and what it runs (TA-32), at most once a minute.
      await healthOf(this.services, row, () => driver);
      return result;
    } catch (err) {
      const problem =
        err instanceof SourceProblem
          ? { code: err.code, message: err.message }
          : { code: 'unreachable', message: `${row.label} couldn’t be read.` };
      if (!(err instanceof SourceProblem))
        this.services.log.warn(
          { connectionId: row.id, err: String(err).slice(0, 300) },
          'tracker: the poll failed',
        );
      await this.#set(row.id, { problemCode: problem.code, problem: problem.message.slice(0, 500) });
      // A refused token marks the connection when the entry's check is refused too; its repair message tells the
      // person then. Any other failure that lasts an hour is the failing notice's.
      const marked = problem.code === 'refused' && (await tokenRefused(this.services, row.id));
      if (marked) this.#failingSince.delete(row.id);
      else await this.#failing(row, cursor, problem.code, now);
      return { ...result, problem: problem.code };
    }
  }

  /**
   * A failed poll: once the connection's polls have failed for `FAILING_NOTICE_MS` in a row, the person hears
   * it, once per streak — a streak runs from the last success, so its key is that success's time. The streak's start
   * is what this process saw; after a restart in the middle of one, the last success.
   */
  async #failing(row: CatalogConnectionRow, cursor: CursorRow, code: string, now: Date): Promise<void> {
    let since = this.#failingSince.get(row.id);
    if (since === undefined) {
      const failedBefore = !!cursor.problemCode && cursor.problemCode !== 'backlog';
      since = failedBefore && cursor.succeededAt ? cursor.succeededAt.getTime() : now.getTime();
      this.#failingSince.set(row.id, since);
    }
    if (now.getTime() - since < FAILING_NOTICE_MS) return;
    await this.#notice(row, {
      key: `tracker_failing:${row.id}:${cursor.succeededAt?.getTime() ?? 'never'}`,
      where: row.label,
      text: failingText(row.label, code),
    });
  }

  /** Tells the person `notice` once (`tellStuck`); a notice this process handled isn't looked up again. Never throws. */
  async #notice(row: CatalogConnectionRow, notice: StuckNotice): Promise<void> {
    if (this.#told.has(notice.key)) return;
    try {
      // Only once told (or found told already): no person or Chat yet is asked again next time.
      if ((await tellStuck(this.services, row.burrowId as string, notice)) !== 'nobody')
        this.#told.add(notice.key);
    } catch (err) {
      this.services.log.warn(
        { connectionId: row.id, err: String(err).slice(0, 200) },
        'tracker: the person couldn’t be told the intake is stuck',
      );
    }
  }

  /**
   * The tracker's organization id for this connection's mirrored reports that have none, from the reports listed
   * this cycle: at most `ORGANIZATIONS_PER_CYCLE`, never overwriting one. Answers how many it filled in; never fails the
   * cycle.
   */
  async #organizations(row: CatalogConnectionRow, listed: TrackerItem[]): Promise<number> {
    const known = new Map<string, string>();
    for (const report of listed) {
      const id = mirroredReport(report).organizationId;
      if (id && known.size < 500) known.set(report.id, id);
    }
    if (!known.size) return 0;
    try {
      const missing = await this.services.db
        .select({ externalId: trackerItems.externalId })
        .from(trackerItems)
        .where(
          and(
            eq(trackerItems.connectionId, row.id),
            isNull(trackerItems.organizationId),
            inArray(trackerItems.externalId, [...known.keys()]),
          ),
        )
        .limit(ORGANIZATIONS_PER_CYCLE);
      if (!missing.length) return 0;
      const res = await this.services.pipeline.commit(
        noteReportOrganizations,
        {
          connectionId: row.id,
          reports: missing.map((m) => ({
            reportId: m.externalId,
            organizationId: known.get(m.externalId) as string,
          })),
        },
        { burrowId: row.burrowId as string, actorId: await this.#signer(row.burrowId as string) },
      );
      if (res.status !== 'ok') throw new Error(`tracker.item_organizations: ${res.status}`);
      return res.result.filled;
    } catch (err) {
      this.services.log.warn(
        { connectionId: row.id, err: String(err).slice(0, 200) },
        'tracker: the reports’ organizations couldn’t be noted',
      );
      return 0;
    }
  }

  /**
   * The reports the tracker erased since the cursor (the driver's `erasures`, absent: nothing), forgotten: each one this
   * Whombat mirrored or ran for (`tracker.items_erased`), in pages of `ERASE_PER_COMMIT`; the others were never here. The
   * cursor moves past a page only once all of it is forgotten. Answers how many mirrored reports went; never fails the
   * cycle (the next one tries again from the same place).
   */
  async #erasures(row: CatalogConnectionRow, driver: BoundDriver, cursor: CursorRow): Promise<number> {
    if (!driver.erasures) return 0;
    const burrowId = row.burrowId as string;
    let after = cursor.erasedAfter;
    let erased = 0;
    try {
      for (let page = 0; page < ERASURE_PAGES; page++) {
        const read = await driver.erasures({ after });
        const kept = await keptReports(this.services.db, burrowId, row.id, [...new Set(read.ids)]);
        for (let i = 0; i < kept.length; i += ERASE_PER_COMMIT) {
          const res = await this.services.pipeline.commit(
            eraseTrackerItems,
            { connectionId: row.id, reportIds: kept.slice(i, i + ERASE_PER_COMMIT) },
            { burrowId, actorId: await this.#signer(burrowId) },
          );
          if (res.status !== 'ok') throw new Error(`tracker.items_erased: ${res.status}`);
          erased += res.result.erased;
        }
        if (read.next !== null && read.next !== after) {
          after = read.next;
          await this.#set(row.id, { erasedAfter: after });
        }
        if (!read.more || read.next === null) break;
      }
    } catch (err) {
      this.services.log.warn(
        { connectionId: row.id, err: String(err).slice(0, 200) },
        'tracker: reports the tracker deleted couldn’t be forgotten yet',
      );
    }
    if (erased)
      this.services.log.info(
        { connectionId: row.id, erased },
        'tracker: reports the tracker deleted forgotten',
      );
    return erased;
  }

  /** A connection nothing listens to that keeps mirrored reports: only its tracker's erasures are read. */
  async #unlistenedErasures(connectionId: string): Promise<number> {
    const burrowId = await keepingBurrow(this.services.db, connectionId);
    if (!burrowId) return 0;
    const row = await trackerConnectionRow(this.services.db, burrowId, connectionId);
    if (!row?.burrowId || row.status === 'needs_reauth') return 0;
    let driver: BoundDriver;
    try {
      driver = this.driverFor(row);
    } catch {
      return 0;
    }
    if (!driver.erasures) return 0;
    return this.#erasures(row, driver, await this.#cursor(row));
  }

  /**
   * The waiting feature request cards of this connection whose report is closed as last seen, ended. Answers
   * how many; never fails the cycle.
   */
  async #closedRequests(row: CatalogConnectionRow): Promise<number> {
    try {
      const ids = await closedReportRequests(this.services.db, row.id);
      if (!ids.length) return 0;
      const res = await this.services.pipeline.commit(
        endClosedReportRequests,
        { connectionId: row.id, requestIds: ids },
        { burrowId: row.burrowId as string, actorId: await this.#signer(row.burrowId as string) },
      );
      if (res.status !== 'ok') throw new Error(`tracker.feature_requests_closed: ${res.status}`);
      if (res.result.ended)
        this.services.log.info(
          { connectionId: row.id, ended: res.result.ended },
          'tracker: feature requests of closed reports ended',
        );
      return res.result.ended;
    } catch (err) {
      this.services.log.warn(
        { connectionId: row.id, err: String(err).slice(0, 200) },
        'tracker: feature requests of closed reports couldn’t be ended',
      );
      return 0;
    }
  }

  /**
   * The customers' answers on the watched reports listed this cycle (TA-31): a first sight is the baseline, a change
   * with nothing of the customer's in it is only noted, and an answer is recorded (`tracker.reporter_replied`) — “It
   * works” also confirms the fix and says so in the thread, “Still happening” reopens it. Answers how many there were.
   */
  async #answers(row: CatalogConnectionRow, watched: Watched[], listed: TrackerItem[]): Promise<number> {
    if (!watched.length) return 0;
    const byId = new Map(listed.map((r) => [r.id, r]));
    let answers = 0;
    let signer: string | null = null;
    for (const w of watched) {
      const report = byId.get(w.externalId);
      if (!report) continue;
      const now = seenOf(report);
      if (!w.seen) {
        await noteSeen(this.services.db, w.id, now);
        continue;
      }
      if (!changed(w.seen, now)) continue;
      const answer = customerAnswer(w.seen, report);
      if (!answer) {
        await noteSeen(this.services.db, w.id, now);
        continue;
      }
      signer ??= await this.#signer(row.burrowId as string);
      const res = await this.services.pipeline.commit(
        reporterReplied,
        {
          rowId: w.id,
          event: answer.event,
          text: answer.text,
          seen: {
            status: now.status,
            updatedAt: now.updatedAt.toISOString(),
            reporterMessages: now.reporterMessages,
            reporterAt: now.reporterAt?.toISOString() ?? null,
          },
        },
        { burrowId: row.burrowId as string, actorId: signer },
      );
      if (res.status !== 'ok') throw new Error(`tracker.reporter_replied: ${res.status}`);
      if (!res.result.replyId) continue;
      answers++;
      if (answer.event !== 'wrote')
        await customerSaid(
          this.services,
          { connectionId: row.id, reportId: w.externalId, number: w.number, burrowId: w.burrowId },
          answer.event,
        ).catch((err) =>
          this.services.log.warn(
            { connectionId: row.id, err: String(err).slice(0, 200) },
            'tracker: the customer’s answer about the fix couldn’t be noted',
          ),
        );
    }
    if (answers) this.services.log.info({ connectionId: row.id, answers }, 'tracker: customers wrote back');
    return answers;
  }

  async #signer(burrowId: string): Promise<string> {
    const { result } = await this.services.pipeline.transact(burrowId, (session) =>
      trackerPrincipalIn(session),
    );
    return result;
  }
}
