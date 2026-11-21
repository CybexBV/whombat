/** Turns an agent schedules for itself (Whombat resourceful-agents.md RA-30, contracts 0.44.0). */
import { describe, expect, it } from 'vitest';
import { api } from '../contracts/index.js';
import { MCP_TOOLS, WHOMBAT_TOOL_NAMES } from '../contracts/mcp.js';
import { ScheduleToolInput, ScheduleToolOutput } from '../contracts/mcp-schedules.js';
import { DispatchContext } from '../contracts/runner.js';
import { EVENT_TYPES } from './audit.js';
import { CARD_KINDS, MessageCard, PostableCard, StoredCard } from './cards.js';
import { DispatchTrigger } from './dispatch.js';
import {
  type AgentSchedule,
  describeScheduleWhen,
  nextScheduleRun,
  SCHEDULE_PROMPT_MAX,
  SCHEDULES_ACTIVE_MAX,
  ScheduleWhen,
  scheduleActions,
  scheduleCardText,
  scheduleCardTitle,
  scheduleCopy,
  scheduleEndsAt,
  scheduleLimitProblem,
  schedulePromptLine,
  scheduleWhenProblem,
} from './schedules.js';

const NOW = '2026-10-03T10:00:00.000Z';
const AMS = 'Europe/Amsterdam';

const schedule: AgentSchedule = {
  id: 'sch_deploycheck',
  agentId: 'prn_dusty',
  conversationId: 'cnv_billing-v2',
  threadRootId: 'msg_billing-neo-1125',
  prompt: 'Check the staging deploy finished.\nIf not, look at the logs.',
  when: { kind: 'every', minutes: 30 },
  status: 'active',
  endedReason: null,
  nextAt: '2026-10-03T10:30:00.000Z',
  endsAt: '2027-01-01T10:00:00.000Z',
  runs: 0,
  lastRunAt: null,
  createdAt: NOW,
};

describe('when a schedule runs (RA-30)', () => {
  it('runs a one-off once, at its time', () => {
    const at = { kind: 'at', at: '2026-10-03T12:30:00+02:00' } as const;
    expect(nextScheduleRun(at, NOW)).toBe('2026-10-03T10:30:00.000Z');
    expect(nextScheduleRun(at, '2026-10-03T10:30:00.000Z')).toBeNull();
    expect(scheduleEndsAt(at, NOW)).toBeNull();
  });

  it('runs every N minutes from when it was made', () => {
    const every = { kind: 'every', minutes: 30 } as const;
    expect(nextScheduleRun(every, NOW, { anchor: NOW })).toBe('2026-10-03T10:30:00.000Z');
    expect(nextScheduleRun(every, '2026-10-03T10:31:00.000Z', { anchor: NOW })).toBe(
      '2026-10-03T11:00:00.000Z',
    );
    expect(nextScheduleRun(every, NOW)).toBe('2026-10-03T10:30:00.000Z');
    expect(scheduleEndsAt(every, NOW)).toBe('2027-01-01T10:00:00.000Z');
  });

  it('reads cron in its zone, through DST', () => {
    const daily = { kind: 'cron', expr: '0 9 * * *', zone: AMS } as const;
    // 09:00 in Amsterdam is 07:00Z in summer time, 08:00Z in winter.
    expect(nextScheduleRun(daily, NOW)).toBe('2026-10-04T07:00:00.000Z');
    expect(nextScheduleRun(daily, '2026-10-24T08:00:00.000Z')).toBe('2026-10-25T08:00:00.000Z');
    // 02:30 on the spring-forward night doesn't exist: it runs shifted, at 03:30.
    const night = { kind: 'cron', expr: '30 2 * * *', zone: AMS } as const;
    expect(nextScheduleRun(night, '2027-03-27T12:00:00.000Z')).toBe('2027-03-28T01:30:00.000Z');
    expect(nextScheduleRun({ kind: 'cron', expr: '0 9 * * *', zone: 'Mars/Olympus' }, NOW)).toBeNull();
  });

  it('refuses a past or far one-off, a bad or too frequent cron', () => {
    expect(scheduleWhenProblem({ kind: 'at', at: '2026-10-03T09:00:00Z' }, NOW)).toBe(
      'That time has passed. Pick a time in the future.',
    );
    expect(scheduleWhenProblem({ kind: 'at', at: '2028-01-01T09:00:00Z' }, NOW)).toBe(
      'That is more than a year ahead.',
    );
    expect(scheduleWhenProblem({ kind: 'at', at: '2026-10-03T11:00:00Z' }, NOW)).toBeNull();
    expect(scheduleWhenProblem({ kind: 'every', minutes: 5 }, NOW)).toBeNull();
    expect(scheduleWhenProblem({ kind: 'cron', expr: '*/5 * * * *', zone: AMS }, NOW)).toBeNull();
    expect(scheduleWhenProblem({ kind: 'cron', expr: '* * * * *', zone: AMS }, NOW)).toBe(
      'It may run at most every 5 minutes.',
    );
    expect(scheduleWhenProblem({ kind: 'cron', expr: '0 9 * *', zone: AMS }, NOW)).toMatch(/five fields/);
    expect(scheduleWhenProblem({ kind: 'cron', expr: '0 9 * * *', zone: 'Nowhere/Here' }, NOW)).toMatch(
      /is not a time zone/,
    );
    expect(scheduleWhenProblem({ kind: 'cron', expr: '0 9 30 2 *', zone: AMS }, NOW)).toBe(
      'This schedule never runs.',
    );
    expect(ScheduleWhen.safeParse({ kind: 'every', minutes: 4 }).success).toBe(false);
    expect(ScheduleWhen.safeParse({ kind: 'at', at: '2026-10-03 12:00' }).success).toBe(false);
  });

  it('keeps the agent to 20 active schedules', () => {
    expect(SCHEDULES_ACTIVE_MAX).toBe(20);
    expect(scheduleLimitProblem(19)).toBeNull();
    expect(scheduleLimitProblem(20)).toBe(
      'You have 20 active schedules, the most you can keep. Cancel one first.',
    );
  });

  it('says when it runs as people read it', () => {
    expect(describeScheduleWhen({ kind: 'at', at: '2026-10-04T07:00:00Z' }, AMS, NOW)).toBe(
      'Once, Sun 4 Oct at 09:00',
    );
    expect(describeScheduleWhen({ kind: 'every', minutes: 30 }, AMS)).toBe('Every 30 minutes');
    expect(describeScheduleWhen({ kind: 'every', minutes: 120 }, AMS)).toBe('Every 2 hours');
    expect(describeScheduleWhen({ kind: 'every', minutes: 1440 }, AMS)).toBe('Every day');
    const cron = (expr: string, zone = AMS) => describeScheduleWhen({ kind: 'cron', expr, zone }, AMS);
    expect(cron('0 9 * * *')).toBe('Every day at 09:00');
    expect(cron('30 8 * * 1-5')).toBe('Every weekday at 08:30');
    expect(cron('0 16 * * 5')).toBe('Every Friday at 16:00');
    expect(cron('0 9 * * 4,1')).toBe('Every Monday and Thursday at 09:00');
    expect(cron('0 9 * * 0,6')).toBe('Every Saturday and Sunday at 09:00');
    expect(cron('0 9 1 * *')).toBe('On the 1st of every month at 09:00');
    expect(cron('*/15 * * * *')).toBe('Every 15 minutes');
    expect(cron('0 */6 * * *')).toBe('Every 6 hours');
    // Another zone is named; what words can't say is never shown as the expression.
    expect(cron('0 16 * * 5', 'America/New_York')).toBe('Every Friday at 16:00 (New York time)');
    expect(cron('0 9 1 1 *')).toBe('On its own schedule');
  });
});

describe('the schedule card and tab (RA-30)', () => {
  const view = schedule;

  it('is a server-made card that an agent can’t post', () => {
    expect(CARD_KINDS).toContain('schedule');
    expect(MessageCard.parse({ kind: 'schedule', scheduleId: schedule.id })).toEqual({
      kind: 'schedule',
      scheduleId: schedule.id,
      schedule: null,
    });
    expect(StoredCard.safeParse({ kind: 'schedule', scheduleId: schedule.id }).success).toBe(true);
    expect(PostableCard.safeParse({ kind: 'schedule', scheduleId: schedule.id }).success).toBe(false);
    expect(scheduleCardTitle('Neo', view)).toBe('Neo scheduled: Check the staging deploy finished.');
    expect(scheduleCardTitle('Neo', null)).toBe('Neo scheduled a task');
    expect(scheduleCardText({ schedule: view }, AMS)).toBe('[schedule: Every 30 minutes; active]');
    expect(scheduleCardText({ schedule: null }, AMS)).toBe('[schedule]');
    expect(schedulePromptLine('x'.repeat(100), 10)).toBe('xxxxxxxxx…');
  });

  it('offers Pause, Resume (a paused or expired one) and Remove', () => {
    expect(scheduleActions(schedule)).toEqual({ pause: true, resume: false, remove: true });
    expect(scheduleActions({ status: 'paused', endedReason: null })).toEqual({
      pause: false,
      resume: true,
      remove: true,
    });
    expect(scheduleActions({ status: 'ended', endedReason: 'expired' })).toEqual({
      pause: false,
      resume: true,
      remove: false,
    });
    expect(scheduleActions({ status: 'ended', endedReason: 'cancelled' })).toEqual({
      pause: false,
      resume: false,
      remove: false,
    });
    expect(scheduleCopy('Neo').empty).toBe('Neo hasn’t scheduled anything.');
  });

  it('has the REST ops of the Schedules tab and signs its events', () => {
    expect(api.schedules.list.path).toBe('/burrows/:burrow/agent/schedules');
    expect(api.schedules.pause.path).toBe('/burrows/:burrow/agent/schedules/:scheduleId/pause');
    expect(api.schedules.resume.method).toBe('POST');
    expect(api.schedules.remove.method).toBe('DELETE');
    expect(api.schedules.list.response.parse({ schedules: [view] }).schedules[0]).not.toHaveProperty(
      'forName',
    );
    for (const type of ['schedule.created', 'schedule.paused', 'schedule.resumed', 'schedule.ended'] as const)
      expect(EVENT_TYPES[type]).toBe('System');
  });
});

describe('the schedule tool and the scheduled turn (RA-30)', () => {
  it('creates, lists and cancels, needs no key and is listed', () => {
    const tool = MCP_TOOLS.schedule;
    expect(tool.requiredKey).toBeNull();
    expect(tool.input).toBe(ScheduleToolInput);
    expect(WHOMBAT_TOOL_NAMES).toContain('schedule');
    const ok = (input: unknown) => ScheduleToolInput.safeParse(input).success;
    expect(ok({ action: 'create', when: { kind: 'every', minutes: 30 }, prompt: 'Check the deploy.' })).toBe(
      true,
    );
    expect(ok({ action: 'create', when: { kind: 'every', minutes: 30 } })).toBe(false);
    expect(ok({ action: 'create', prompt: 'Check.' })).toBe(false);
    expect(
      ok({
        action: 'create',
        when: { kind: 'every', minutes: 30 },
        prompt: 'x'.repeat(SCHEDULE_PROMPT_MAX + 1),
      }),
    ).toBe(false);
    expect(ok({ action: 'list' })).toBe(true);
    expect(ok({ action: 'cancel' })).toBe(false);
    expect(ok({ action: 'cancel', scheduleId: 'sch_x' })).toBe(true);
    expect(
      ScheduleToolOutput.safeParse({ status: 'ok', schedule: null, schedules: [], others: 2 }).success,
    ).toBe(true);
    expect(
      ScheduleToolOutput.safeParse({ status: 'invalid', problems: ['That time has passed.'] }).success,
    ).toBe(true);
  });

  it('wakes the agent with trigger schedule and what it told itself', () => {
    expect(DispatchTrigger.options).toEqual(expect.arrayContaining(['schedule', 'notify']));
    expect(DispatchTrigger.options).not.toContain('reflect');
    const part = DispatchContext.shape.schedule.parse({
      id: schedule.id,
      prompt: schedule.prompt,
      when: schedule.when,
      runs: 3,
      nextAt: '2026-10-03T11:00:00.000Z',
    });
    expect(part?.runs).toBe(3);
    expect(
      DispatchContext.shape.notify.parse({ text: 'Backup finished: 12 GB.', fromDispatchId: 'dsp_a' })?.text,
    ).toBe('Backup finished: 12 GB.');
    expect(
      DispatchContext.shape.notify.safeParse({ text: 'x'.repeat(2001), fromDispatchId: 'dsp_a' }).success,
    ).toBe(false);
    expect('reflect' in DispatchContext.shape).toBe(false);
    expect(
      DispatchContext.shape.commands.parse({ productionServers: [], homeNetworks: [], lan: true })?.lan,
    ).toBe(true);
    expect(
      DispatchContext.shape.commands.safeParse({ productionServers: [], homeNetworks: [] }).success,
    ).toBe(false);
  });
});
