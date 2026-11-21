/**
 * Schedules (bp-automations BP-C18): due schedules (`next_fire_at`, the durable timer) fire under their missed-run and
 * overlap policies, timers a clock that went backwards left too late are pulled back, and the first fire still to come
 * tells the engine when to pass next (server-efficiency SV-03).
 */
import { firesBetween, type ScheduleContext, type ScheduleSpec } from '@whombat/core';
import { and, asc, eq, gt, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { automationRunSteps, automationRuns, automations, automationVersions } from '../../db/schema/index';
import type { Services } from '../../services';
import { cancelRunDispatches } from '../commands';
import { createRun, runsToday } from '../runs';
import { ACTIVE_RUN_STATUSES, publishRun, scheduleNext } from '../store';
import type { EngineOptions } from './options';

/**
 * The newest `max` fires in (from, to], oldest first — what `firesBetween(spec, from, to, ctx, max).fires` means.
 * `firesBetween` walks every fire from `from`: after a long downtime that is thousands of cron evaluations (an
 * every-5-minutes cron costs ~5 ms each, so a week down took ~10 s of CPU inside the burrow's transaction, a busier cron
 * minutes) and it stops after 10 000 fires, so a 5-minute schedule down for 35 days caught up a fire from a month
 * ago. Only the newest `max` count, so look back from `to` in a window that doubles until it holds `max` fires or
 * reaches `from`.
 */
export function newestFires(
  spec: ScheduleSpec,
  from: number,
  to: number,
  ctx: ScheduleContext,
  max: number,
): number[] {
  for (let span = 10 * 60_000; ; span *= 2) {
    const lo = Math.max(from, to - span);
    const { fires } = firesBetween(spec, lo, to, ctx, max);
    if (fires.length >= max || lo === from) return fires;
  }
}

/** The live automations' schedules, as the active engine fires them. */
export class Schedules {
  /** The first fire still to come at the last scan (clock ms), now when some fired, null when none is set. */
  private next: number | null = null;
  /** The clock (`services.clock`) at the last schedule scan, to notice it going backwards. */
  private lastScheduleClock: number | null = null;
  /** `performance.now()` of the last schedule timer realignment. */
  private lastRealign = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly services: Services,
    /** The engine's own options, read as they are at each scan. */
    private readonly options: Pick<EngineOptions, 'recoverEveryMs' | 'missedGraceMs'>,
  ) {}

  /** When the engine should pass next for a schedule (clock ms), or null. */
  get nextFire(): number | null {
    return this.next;
  }

  /** Fires the due schedules; returns how many runs started. */
  async scan(): Promise<number> {
    const now = this.services.clock();
    // Timers set under a clock that has since gone back: at the first scan (a restart may follow a correction), when
    // this process sees the clock step back, and periodically (monotonic).
    const wentBack = this.lastScheduleClock !== null && now.getTime() < this.lastScheduleClock;
    this.lastScheduleClock = now.getTime();
    const mono = performance.now();
    if (wentBack || mono - this.lastRealign >= this.options.recoverEveryMs) {
      this.lastRealign = mono;
      await this.realignTimers(now);
    }
    // Every live schedule, soonest first: the due ones fire, the first one still to come sets the next pass (SV-03).
    const scheduled = await this.services.db
      .select({ id: automations.id, burrowId: automations.burrowId, nextFireAt: automations.nextFireAt })
      .from(automations)
      .where(and(eq(automations.status, 'published'), isNotNull(automations.nextFireAt)))
      .orderBy(asc(automations.nextFireAt));
    const due = scheduled.filter((a) => a.nextFireAt && a.nextFireAt <= now);
    this.next = scheduled.find((a) => a.nextFireAt && a.nextFireAt > now)?.nextFireAt?.getTime() ?? null;
    // The ones that fire now have a new next fire this pass didn't read: look again soon.
    if (due.length) this.next = now.getTime();
    let fired = 0;
    for (const a of due) {
      // One automation that can't fire (a zone this runtime no longer knows, a failed write) must not hold up the rest.
      try {
        fired += await this.fire(a.id, a.burrowId);
      } catch (err) {
        this.services.log.error(
          { err: String(err), stack: (err as Error)?.stack, automationId: a.id },
          'automation schedule did not fire',
        );
      }
    }
    return fired;
  }

  /**
   * A timer later than the schedule's next fire from now means the clock went backwards after it was set (an NTP
   * correction of a clock that ran ahead, a restored snapshot): left alone the schedule stays silent until the clock
   * catches up, possibly for days. Pull such timers back. Not while the clock reads earlier than the moment the
   * schedule was switched on (its anchor): that clock is the wrong one (a stale RTC at boot), so nothing fires until it
   * is corrected. A fire that already has a run is not repeated (`fire` checks the trigger key first).
   */
  async realignTimers(now: Date): Promise<number> {
    const rows = await this.services.db
      .select({ a: automations, v: automationVersions })
      .from(automations)
      .innerJoin(
        automationVersions,
        and(
          eq(automationVersions.automationId, automations.id),
          eq(automationVersions.n, automations.currentVersion),
        ),
      )
      .where(and(eq(automations.status, 'published'), gt(automations.nextFireAt, now)));
    let moved = 0;
    for (const { a, v } of rows) {
      try {
        const anchor = a.scheduleAnchor ?? a.createdAt;
        if (!a.nextFireAt || now < anchor) continue;
        const next = scheduleNext(v.definition, now, anchor);
        if (!next || next >= a.nextFireAt) continue;
        const updated = await this.services.db
          .update(automations)
          .set({ nextFireAt: next })
          .where(and(eq(automations.id, a.id), eq(automations.nextFireAt, a.nextFireAt)))
          .returning({ id: automations.id });
        if (updated.length) {
          moved++;
          this.services.log.warn(
            { automationId: a.id, was: a.nextFireAt.toISOString(), now: next.toISOString() },
            'automation schedule timer was ahead of the clock; moved back',
          );
        }
      } catch (err) {
        this.services.log.error(
          { err: String(err), automationId: a.id },
          'automation schedule timer check failed',
        );
      }
    }
    return moved;
  }

  /**
   * While the licence is lapsed (LC-10): every schedule that came due moves to its next fire after now without a run,
   * so nothing missed meanwhile runs later. Returns how many schedules moved.
   */
  async skipDue(now: Date): Promise<number> {
    let moved = 0;
    const due = await this.services.db
      .select({ a: automations, v: automationVersions })
      .from(automations)
      .innerJoin(
        automationVersions,
        and(
          eq(automationVersions.automationId, automations.id),
          eq(automationVersions.n, automations.currentVersion),
        ),
      )
      .where(
        and(
          eq(automations.status, 'published'),
          isNotNull(automations.nextFireAt),
          lte(automations.nextFireAt, now),
        ),
      );
    for (const { a, v } of due) {
      const next = scheduleNext(v.definition, now, a.scheduleAnchor ?? a.createdAt);
      await this.services.pipeline.transact(a.burrowId, async ({ tx }) => {
        const updated = await tx
          .update(automations)
          .set({ nextFireAt: next })
          .where(and(eq(automations.id, a.id), eq(automations.nextFireAt, a.nextFireAt as Date)))
          .returning({ id: automations.id });
        moved += updated.length;
      });
    }
    return moved;
  }

  /** One due schedule's fires under its policies, and its next fire, in one transaction. */
  private async fire(automationId: string, burrowId: string): Promise<number> {
    const services = this.services;
    const { result } = await services.pipeline.transact(burrowId, async (session) => {
      const tx = session.tx;
      const now = services.clock();
      const [a] = await tx.select().from(automations).where(eq(automations.id, automationId)).for('update');
      if (
        a?.status !== 'published' ||
        a.deletedAt ||
        !a.nextFireAt ||
        a.nextFireAt > now ||
        !a.currentVersion
      )
        return 0;
      const [v] = await tx
        .select()
        .from(automationVersions)
        .where(and(eq(automationVersions.automationId, a.id), eq(automationVersions.n, a.currentVersion)));
      const trigger = v?.definition.triggers.find((t) => t.kind === 'schedule');
      if (!v || !trigger || trigger.kind !== 'schedule') {
        await tx.update(automations).set({ nextFireAt: null }).where(eq(automations.id, a.id));
        return 0;
      }
      const anchor = a.scheduleAnchor ?? a.createdAt;
      const ctx = { timeZone: trigger.timeZone, dst: trigger.dst, anchor: anchor.getTime() };
      const fires = newestFires(
        trigger.schedule,
        a.nextFireAt.getTime() - 1,
        now.getTime(),
        ctx,
        trigger.maxCatchUp,
      );
      const onTime = fires.filter((f) => now.getTime() - f <= this.options.missedGraceMs);
      const missed = fires.filter((f) => now.getTime() - f > this.options.missedGraceMs);
      // Missed (the server was down): skip them, or run once for the newest; on-time fires always run.
      const toRun = [
        ...(trigger.missed === 'run_once' && missed.length ? [missed[missed.length - 1] as number] : []),
        ...onTime,
      ];
      let fired = 0;
      for (const at of toRun) {
        const scheduledFor = new Date(at).toISOString();
        const triggerKey = `sched:${scheduledFor}`;
        // A fire that already has a run (the clock went back over it) is done: in particular it must not cancel
        // that run under `cancel_previous` (createRun would then dedupe, leaving nothing running).
        const [done] = await tx
          .select({ id: automationRuns.id })
          .from(automationRuns)
          .where(
            and(
              eq(automationRuns.automationId, a.id),
              eq(automationRuns.version, v.n),
              eq(automationRuns.triggerKey, triggerKey),
            ),
          )
          .limit(1);
        if (done) continue;
        const active = await tx
          .select({ id: automationRuns.id, status: automationRuns.status })
          .from(automationRuns)
          .where(
            and(
              eq(automationRuns.automationId, a.id),
              inArray(automationRuns.status, [...ACTIVE_RUN_STATUSES]),
            ),
          );
        let skippedBecause: string | undefined;
        if (active.length) {
          if (trigger.overlap === 'skip') skippedBecause = 'The previous run was still going.';
          else if (trigger.overlap === 'cancel_previous') {
            for (const r of active) {
              await tx
                .update(automationRuns)
                .set({
                  status: 'cancelled',
                  finishedAt: now,
                  error: 'A newer scheduled run replaced it.',
                  updatedAt: now,
                })
                .where(eq(automationRuns.id, r.id));
              await tx
                .update(automationRunSteps)
                .set({ state: 'cancelled', finishedAt: now, updatedAt: now })
                .where(
                  and(
                    eq(automationRunSteps.runId, r.id),
                    sql`${automationRunSteps.state} in ('pending','running','waiting','uncertain')`,
                  ),
                );
              await cancelRunDispatches(tx, r.id, now, session);
              // Its room, its search document and plan steps that follow it see it stop (WS-05).
              await publishRun(session, r.id);
            }
          } else if (active.filter((r) => r.status === 'queued').length >= 1) {
            skippedBecause = 'A run was already waiting for its turn.';
          }
        }
        if (!skippedBecause && (await runsToday(session, a.id, now)) >= v.definition.limits.maxRunsPerDay)
          skippedBecause = 'It reached its runs for today.';
        const runId = await createRun(session, {
          automation: a,
          definition: v.definition,
          version: v.n,
          publishedById: v.publishedById,
          trigger: {
            kind: 'schedule',
            summary: `Scheduled for ${scheduledFor}${missed.includes(at) ? ' (missed while Whombat was down)' : ''}`,
            actorId: null,
            eventId: null,
            messageId: null,
            scheduledFor,
          },
          triggerKey,
          scope: { kind: 'schedule', scheduledFor, text: '' },
          conversationId: v.definition.conversationId,
          threadRootId: null,
          causalDepth: 0,
          causalChain: [a.id],
          startedById: null,
          test: false,
          now,
          ...(skippedBecause ? { skippedBecause } : {}),
        });
        if (runId && !skippedBecause) fired++;
      }
      await tx
        .update(automations)
        .set({ nextFireAt: scheduleNext(v.definition, now, anchor) })
        .where(eq(automations.id, a.id));
      return fired;
    });
    return result;
  }
}
