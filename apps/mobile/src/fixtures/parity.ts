/**
 * Settings → Agent's parts in the app's demo world (mobile-parity.md MQ-01; one-agent.md AP-4961), on top of
 * `@whombat/fixtures` (whose world has no schedules or always-allowed commands; its own memory world serves the agent's
 * notes and Mara's memory, CT-1200…CT-1205, and its services world what the agent runs, CT-1533), so “Explore the demo
 * burrow” shows what the phone does with the agent:
 *
 * - **Its schedules**: the weekday backup check (active) and the Friday incident summary (paused), in Mara's Chat;
 *   Pause, Resume and Remove change them (`schedules.*`).
 * - **Its always-allowed command**: a staging deploy workflow; Remove takes it away.
 *
 * Pure TypeScript over `Response`, unit-tested next to the fixture server.
 */
import type { AgentScheduleView, CommandAllowance } from '@whombat/core';
import { AGENT, mara } from '@whombat/fixtures';
import { DEFAULT_CHAT_ID } from './assistant';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const notFound = (what: string) => json({ error: { code: 'not_found', message: `No ${what}` } }, 404);

function schedules(): AgentScheduleView[] {
  const base = {
    agentId: AGENT.id,
    conversationId: DEFAULT_CHAT_ID,
    threadRootId: null,
    endedReason: null,
    forName: 'Mara',
    canChange: true,
  };
  return [
    {
      ...base,
      id: 'sch_backups',
      prompt: 'Check last night’s backups and post one line here.',
      when: { kind: 'cron', expr: '30 8 * * 1-5', zone: 'Europe/Amsterdam' },
      status: 'active',
      nextAt: '2026-09-24T06:30:00.000Z',
      endsAt: '2026-12-22T06:30:00.000Z',
      runs: 12,
      lastRunAt: '2026-09-23T06:30:00.000Z',
      createdAt: '2026-09-07T06:12:00.000Z',
    },
    {
      ...base,
      id: 'sch_incidents',
      prompt: 'Summarize the week’s open incidents for the Friday review.',
      when: { kind: 'cron', expr: '0 15 * * 5', zone: 'Europe/Amsterdam' },
      status: 'paused',
      nextAt: null,
      endsAt: '2026-12-18T14:00:00.000Z',
      runs: 3,
      lastRunAt: '2026-09-18T13:00:00.000Z',
      createdAt: '2026-08-28T09:40:00.000Z',
    },
  ] as AgentScheduleView[];
}

function allowances(): CommandAllowance[] {
  return [
    {
      id: 'cma_staging',
      agentId: AGENT.id,
      keyId: 'deploy',
      command: 'gh workflow run deploy.yml -f environment=staging',
      target: 'lumio/billing',
      createdById: mara.id,
      createdAt: '2026-09-20T10:00:00.000Z',
    },
  ];
}

export interface ParityFixtures {
  handle(id: string | undefined, params: Record<string, string>): Response | null;
}

export function createParityFixtures(): ParityFixtures {
  let agentSchedules = schedules();
  let agentAllowances = allowances();
  const setSchedule = (scheduleId: string, change: (s: AgentScheduleView) => AgentScheduleView) => {
    const found = agentSchedules.find((s) => s.id === scheduleId);
    if (!found) return notFound(`schedule ${scheduleId}`);
    const next = change(found);
    agentSchedules = agentSchedules.map((s) => (s.id === scheduleId ? next : s));
    return json({ schedule: next, eventId: null });
  };

  return {
    handle(id, params) {
      switch (id) {
        case 'schedules.list':
          return json({ schedules: agentSchedules });
        case 'schedules.pause':
          return setSchedule(params.scheduleId ?? '', (s) => ({ ...s, status: 'paused', nextAt: null }));
        case 'schedules.resume':
          return setSchedule(params.scheduleId ?? '', (s) => ({
            ...s,
            status: 'active',
            nextAt: '2026-09-25T13:00:00.000Z',
          }));
        case 'schedules.remove':
          return setSchedule(params.scheduleId ?? '', (s) => ({
            ...s,
            status: 'ended',
            endedReason: 'cancelled',
            nextAt: null,
          }));
        case 'agent.commandAllowances':
          return json({ allowances: agentAllowances, eventId: null });
        case 'agent.removeCommandAllowance':
          agentAllowances = agentAllowances.filter((a) => a.id !== params.allowanceId);
          return json({ allowances: agentAllowances, eventId: null });
        default:
          return null;
      }
    },
  };
}
