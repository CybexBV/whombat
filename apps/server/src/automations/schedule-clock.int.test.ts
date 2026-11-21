/**
 * Schedules across downtime and clock trouble (docs/decisions/bp-automations.md BP-C18), as a managed appliance sees
 * them: a long power-off, a clock that ran ahead and is corrected back, a stale clock at boot, a restart, a schedule
 * that can't fire, and periodic recovery after the wall clock steps back. Real database, FAKE AGENTS.
 */
import type { AutomationDefinitionInput } from '@whombat/core';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { automations, automationVersions } from '../db/schema/index';
import { IDS, useAutomationWorld } from '../test/automations';

const w = useAutomationWorld();

type Trigger = Extract<AutomationDefinitionInput['triggers'][number], { kind: 'schedule' }>;

const scheduled = (
  schedule: Trigger['schedule'],
  policy: Partial<Pick<Trigger, 'overlap' | 'missed' | 'maxCatchUp'>> = {},
  steps: AutomationDefinitionInput['steps'] = [{ id: 'note', kind: 'post_message', text: 'Tick.' }],
) =>
  ({
    version: 1,
    conversationId: IDS.billing,
    triggers: [
      {
        kind: 'schedule',
        schedule,
        timeZone: 'Europe/Amsterdam',
        overlap: 'skip',
        missed: 'skip',
        maxCatchUp: 3,
        ...policy,
      },
    ],
    steps,
  }) as AutomationDefinitionInput;

const ASK = [{ id: 'ask', kind: 'dispatch_agent', prompt: 'Scheduled look.' }] as const;

async function nextFireAt(id: string) {
  const [a] = await w.services.db.select().from(automations).where(eq(automations.id, id));
  return a?.nextFireAt?.toISOString() ?? null;
}

/** Scheduled fires that got a run, in the order they were created (run numbers; a wrong clock skews createdAt). */
const fired = async (id: string) =>
  (await w.runs(id)).sort((a, b) => a.number - b.number).map((r) => r.trigger.scheduledFor);

afterEach(() => {
  vi.useRealTimers();
});

describe('after a long downtime', () => {
  it('an interval down for 60 days catches up its newest missed fire, not one from a month ago', async () => {
    w.setNow('2026-10-01T10:00:00.000Z');
    const id = await w.publish(scheduled({ kind: 'interval', everyMinutes: 5 }, { missed: 'run_once' }), {
      name: 'Long down interval',
    });
    w.setNow('2026-11-30T10:00:30.000Z');
    await w.settle();
    // One catch-up run for 09:55 (the newest missed fire) and the on-time 10:00; nothing from the weeks between.
    expect(await fired(id)).toEqual(['2026-11-30T09:55:00.000Z', '2026-11-30T10:00:00.000Z']);
    expect((await w.runs(id))[0]?.trigger.summary).toMatch(/missed while Whombat was down/);
    expect(await nextFireAt(id)).toBe('2026-11-30T10:05:00.000Z');
  });

  it('a busy cron down for 30 days catches up in bounded time', async () => {
    w.setNow('2026-10-01T10:00:00.000Z');
    const id = await w.publish(scheduled({ kind: 'cron', expr: '*/5 * * * *' }, { missed: 'run_once' }), {
      name: 'Long down cron',
    });
    w.setNow('2026-10-31T10:02:30.000Z');
    const started = performance.now();
    await w.settle(1);
    // Walking all 8 640 missed fires took tens of seconds of CPU inside the burrow's transaction.
    expect(performance.now() - started).toBeLessThan(5000);
    expect(await fired(id)).toEqual(['2026-10-31T10:00:00.000Z']);
    expect(await nextFireAt(id)).toBe('2026-10-31T10:05:00.000Z');
  });
});

describe('when the clock was wrong', () => {
  const DAILY = { kind: 'cron', expr: '0 9 * * *' } as const;

  it('a clock that ran a year ahead and is corrected back does not stall the schedule', async () => {
    w.setNow('2026-10-05T06:00:00.000Z');
    const id = await w.publish(scheduled(DAILY), { name: 'Ran ahead' });
    // The clock jumps a year ahead: the schedule fires at the wrong time (nothing can tell) ...
    w.setNow('2027-10-05T07:00:30.000Z');
    await w.settle();
    expect(await fired(id)).toEqual(['2027-10-05T07:00:00.000Z']);
    expect(await nextFireAt(id)).toBe('2027-10-06T07:00:00.000Z');
    // ... and NTP puts it back while Whombat runs: the timer follows instead of waiting a year.
    w.setNow('2026-10-05T07:10:00.000Z');
    await w.settle();
    expect(await nextFireAt(id)).toBe('2026-10-06T07:00:00.000Z');
    w.setNow('2026-10-06T07:00:30.000Z');
    await w.settle();
    expect(await fired(id)).toEqual(['2027-10-05T07:00:00.000Z', '2026-10-06T07:00:00.000Z']);
  });

  it('the correction also holds across a restart', async () => {
    w.setNow('2026-10-12T06:00:00.000Z');
    const id = await w.publish(scheduled(DAILY), { name: 'Ran ahead, restarted' });
    w.setNow('2026-12-12T08:00:30.000Z');
    await w.settle();
    expect(await nextFireAt(id)).toBe('2026-12-13T08:00:00.000Z');
    // Powered off, and the clock is right at the next boot.
    await w.restart();
    w.setNow('2026-10-12T12:00:00.000Z');
    await w.settle();
    expect(await nextFireAt(id)).toBe('2026-10-13T07:00:00.000Z');
  });

  it('a clock behind the moment the schedule was switched on fires nothing until it is corrected', async () => {
    w.setNow('2026-10-20T06:00:00.000Z');
    const id = await w.publish(scheduled(DAILY), { name: 'Stale clock' });
    expect(await nextFireAt(id)).toBe('2026-10-20T07:00:00.000Z');
    // A board without a real-time clock boots in 2020.
    await w.restart();
    w.setNow('2020-01-01T00:00:00.000Z');
    await w.settle();
    w.advance(3 * 86_400_000);
    await w.settle();
    expect(await nextFireAt(id)).toBe('2026-10-20T07:00:00.000Z');
    expect(await w.runs(id)).toHaveLength(0);
    // NTP sets it right: the schedule goes on as usual.
    w.setNow('2026-10-20T07:00:30.000Z');
    await w.settle();
    expect(await fired(id)).toEqual(['2026-10-20T07:00:00.000Z']);
  });

  it('a fire the clock went back over is not repeated, and cancel_previous leaves its run alone', async () => {
    w.setNow('2026-10-25T12:00:00.000Z');
    const id = await w.publish(
      scheduled({ kind: 'interval', everyMinutes: 5 }, { overlap: 'cancel_previous' }, [...ASK]),
      { name: 'Back over a fire' },
    );
    w.setNow('2026-10-25T12:05:01.000Z');
    await w.settle();
    expect((await w.runs(id)).map((r) => r.status)).toEqual(['waiting']);
    // The clock steps back a minute: the timer goes back to 12:05 ...
    w.setNow('2026-10-25T12:04:01.000Z');
    await w.settle();
    expect(await nextFireAt(id)).toBe('2026-10-25T12:05:00.000Z');
    // ... and reaching 12:05 again neither starts a second run nor cancels the first.
    w.setNow('2026-10-25T12:05:30.000Z');
    await w.settle();
    const runs = await w.runs(id);
    expect(runs.map((r) => [r.trigger.scheduledFor, r.status])).toEqual([
      ['2026-10-25T12:05:00.000Z', 'waiting'],
    ]);
    expect(await nextFireAt(id)).toBe('2026-10-25T12:10:00.000Z');
  });
});

describe('robustness', () => {
  it('a schedule that cannot fire does not hold up the others', async () => {
    w.setNow('2026-11-02T10:00:00.000Z');
    const broken = await w.publish(scheduled({ kind: 'cron', expr: '*/5 * * * *' }), { name: 'Broken zone' });
    w.setNow('2026-11-02T10:01:00.000Z');
    const fine = await w.publish(scheduled({ kind: 'interval', everyMinutes: 5 }), { name: 'Fine' });
    // A runtime update no longer knows the zone the published version names.
    await w.services.db
      .update(automationVersions)
      .set({
        definition: sql`jsonb_set(${automationVersions.definition}, '{triggers,0,timeZone}', '"Mars/Olympus"')`,
      })
      .where(eq(automationVersions.automationId, broken));
    w.setNow('2026-11-02T10:06:30.000Z');
    await w.settle();
    expect(await w.runs(broken)).toHaveLength(0);
    expect(await fired(fine)).toEqual(['2026-11-02T10:06:00.000Z']);
  });

  it('periodic approval recovery keeps running after the wall clock steps back', async () => {
    const engine = w.services.automations;
    // Handover waits two lock checks (5 s each by default, SV-03).
    engine.options.lockCheckMs = 50;
    engine.start();
    await vi.waitFor(() => expect(engine.isActive).toBe(true), { timeout: 10_000 });
    engine.options.recoverEveryMs = 50;
    await engine.tick();
    const recover = vi.spyOn(w.services.approvals, 'recover');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - 86_400_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await engine.tick();
    expect(recover).toHaveBeenCalled();
    await engine.close();
  });
});
