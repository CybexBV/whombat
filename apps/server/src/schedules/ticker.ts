/**
 * The schedules' ticker (docs/decisions/resourceful-agents.md RA-30, RA-DS36): every 30 seconds, while this process runs
 * and isn't held for maintenance or past its licence, each active schedule that is due queues one `schedule` turn —
 * in its conversation and thread, for its person, its own turn (never merged with a queued one), carrying
 * `DispatchContext.schedule` — and moves to its next run. Runs missed while nothing ticked collapse into one. A one-off
 * that ran ends `done`; a repeating one whose next run falls after its 90 days ends `expired` (Resume renews it) — both
 * keep the turn they just queued, which runs (RA-DS43); one whose agent is gone ends `cancelled`. Each schedule moves in its own transaction holding its burrow's lock, after locking its
 * row and checking it is still due, so two servers never run one twice.
 */
import { type DispatchContext, nextScheduleRun } from '@whombat/core';
import { and, asc, eq, isNotNull, lte, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import { agentSchedules, type dispatches } from '../db/schema/index';
import { enqueueInSession } from '../domain/dispatch';
import { isoOrNull } from '../lib/time';
import { loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { endSchedule } from './commands';
import { liveRunOfSchedule, lockSchedule, type ScheduleRow } from './store';

/** How often the ticker looks (a schedule runs at most this late). */
export const SCHEDULE_TICK_MS = 30_000;
/** Due schedules one tick takes at most (the rest wait for the next). */
const TICK_BATCH = 200;

export class ScheduleTicker {
  #timer: ReturnType<typeof setInterval> | null = null;
  #first: ReturnType<typeof setTimeout> | null = null;
  #running: Promise<number> | null = null;

  constructor(private readonly services: Services) {}

  /** One pass: queues the due turns and ends what has ended. Returns the turns queued. */
  async tick(now = this.services.clock()): Promise<number> {
    const { maintenance, licence } = this.services;
    if (maintenance.held || maintenance.draining || licence.lapsed) return 0;
    const due = await this.services.db
      .select()
      .from(agentSchedules)
      .where(
        and(
          eq(agentSchedules.status, 'active'),
          or(
            and(isNotNull(agentSchedules.nextAt), lte(agentSchedules.nextAt, now)),
            and(isNotNull(agentSchedules.endsAt), lte(agentSchedules.endsAt, now)),
          ),
        ),
      )
      .orderBy(asc(agentSchedules.nextAt))
      .limit(TICK_BATCH);
    let queued = 0;
    for (const row of due) {
      try {
        queued += await this.runOne(row, now);
      } catch (err) {
        this.services.log.warn({ err: String(err), scheduleId: row.id }, 'schedules: a run failed');
      }
    }
    return queued;
  }

  /** One due schedule, in its burrow's transaction. */
  private async runOne(due: ScheduleRow, now: Date): Promise<number> {
    const { result } = await this.services.pipeline.transact(due.burrowId, async (session) => {
      const tx = session.tx;
      const row = await lockSchedule(tx, due.id);
      // Another server (or a person) moved it since it was read.
      if (row?.status !== 'active' || row.nextAt?.getTime() !== due.nextAt?.getTime()) return 0;
      const agent = await loadPrincipalRow(tx, row.agentId);
      if (agent?.kind !== 'agent') {
        await endSchedule(session, row, 'cancelled', { signerId: row.agentId, text: null, at: now });
        return 0;
      }
      // Its days ran out before its next run.
      if (row.endsAt && row.endsAt <= now && (!row.nextAt || row.nextAt >= row.endsAt)) {
        await endSchedule(session, row, 'expired', { signerId: agent.id, text: null, at: now });
        return 0;
      }
      if (!row.nextAt || row.nextAt > now) return 0;
      const following =
        row.when.kind === 'at' ? null : nextScheduleRun(row.when, now, { anchor: row.anchorAt });
      // Made in a run that is still live (it waits on a CI run, a build): the turn continues that run (RC-15).
      const runId = await liveRunOfSchedule(tx, row);
      const queued = await enqueueInSession(session, {
        burrowId: row.burrowId,
        causedById: agent.id,
        conversationId: row.conversationId,
        messageId: null,
        threadRootId: row.threadRootId,
        requests: [{ agentId: agent.id, trigger: 'schedule', ...(runId ? { mode: 'run' as const } : {}) }],
        at: now,
        onBehalfOfAccountId: row.forAccountId,
        scheduleId: row.id,
        ...(runId ? { runId } : {}),
      });
      const ran = queued.length > 0;
      const last =
        following === null || (row.endsAt !== null && Date.parse(following) >= row.endsAt.getTime());
      const [moved] = await tx
        .update(agentSchedules)
        .set({
          nextAt: last ? null : new Date(following as string),
          runs: row.runs + (ran ? 1 : 0),
          lastRunAt: ran ? now : row.lastRunAt,
          updatedAt: now,
        })
        .where(eq(agentSchedules.id, row.id))
        .returning();
      if (last)
        await endSchedule(session, moved ?? row, following === null ? 'done' : 'expired', {
          signerId: agent.id,
          text: null,
          at: now,
        });
      return queued.length;
    });
    return result;
  }

  /** Every 30 seconds while the process runs (the first look 5 seconds after start). */
  start(): void {
    if (this.#timer) return;
    const run = () => {
      if (this.#running) return;
      this.#running = this.tick()
        .catch((err) => {
          this.services.log.warn({ err: String(err) }, 'schedules: tick failed');
          return 0;
        })
        .finally(() => {
          this.#running = null;
        });
    };
    this.#first = setTimeout(run, 5_000);
    this.#timer = setInterval(run, SCHEDULE_TICK_MS);
    this.#first.unref?.();
    this.#timer.unref?.();
  }

  close(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#first) clearTimeout(this.#first);
    this.#timer = null;
    this.#first = null;
  }
}

const tickers = new WeakMap<Services, ScheduleTicker>();

/** Stops this server's schedule ticker, if it has one (closing never makes one). */
export function closeSchedules(services: Services): void {
  tickers.get(services)?.close();
}

/** This server's schedule ticker. */
export function schedulesFor(services: Services): ScheduleTicker {
  let t = tickers.get(services);
  if (!t) {
    t = new ScheduleTicker(services);
    tickers.set(services, t);
  }
  return t;
}

/**
 * `DispatchContext.schedule` for a `schedule` turn (RA-30, RA-DC13): the prompt the agent wrote itself, when it runs,
 * how many turns it started and its next run (also for a retry of one). Null for every other turn, and when the
 * schedule is gone.
 */
export async function scheduleContextOf(
  db: Db,
  row: Pick<typeof dispatches.$inferSelect, 'trigger' | 'scheduleId' | 'agentId'>,
): Promise<DispatchContext['schedule']> {
  if ((row.trigger !== 'schedule' && row.trigger !== 'retry') || !row.scheduleId) return null;
  const [schedule] = await db.select().from(agentSchedules).where(eq(agentSchedules.id, row.scheduleId));
  if (!schedule || schedule.agentId !== row.agentId) return null;
  return {
    id: schedule.id,
    prompt: schedule.prompt,
    when: schedule.when,
    runs: schedule.runs,
    nextAt: isoOrNull(schedule.nextAt),
  };
}
