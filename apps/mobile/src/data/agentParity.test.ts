/**
 * Settings → Agent's Services, Schedules and Notes parts and Keys' always-allowed commands (mobile-parity.md MQ-01;
 * one-agent.md AP-4970…AP-4972; one-person-android.md AP-5760, AP-5762): what the agent runs on your Whombat (how each
 * is, its port and link, Stop while it runs), the schedules (what, when, NEXT / ENDS / RUNS / FOR, Pause / Resume /
 * Remove by `canChange`), the notes (when they changed, the editor's rule) and the always-allowed commands.
 */
import { SCHEDULE_TEXT } from '@whombat/client';
import type { AgentScheduleView, AgentService, CommandAllowance } from '@whombat/core';
import { AGENT, mara, SEED_NOW, SEED_TIME_ZONE } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { allowanceRows, notesCount, notesEdit, notesMeta } from './agentParity';
import { scheduleActionLabel, scheduleDoneText, scheduleRows } from './schedules';
import { SERVICES_TEXT, serviceRows, showsServices } from './services';

const service: AgentService = {
  id: 'a1b2c3d4e5f6',
  name: 'Garden dashboard',
  port: 20001,
  url: 'http://192.168.1.20:20001',
  state: 'running',
  startedAt: '2026-09-23T07:00:00.000Z',
  image: 'node:24-alpine',
};

describe('the Services part (OP-19, AP-5760)', () => {
  it('shows once the host answers, also where it can’t run containers (it says why)', () => {
    expect(showsServices({ services: { available: true, reason: null } })).toBe(true);
    expect(showsServices({ services: { available: false, reason: 'No engine.' } })).toBe(true);
    expect(showsServices(undefined)).toBe(false);
  });

  it('reads each service with its state, when it started and its link, and Stop while it runs', () => {
    const [row] = serviceRows([service], { now: SEED_NOW, timeZone: SEED_TIME_ZONE });
    expect(row).toMatchObject({
      id: service.id,
      name: 'Garden dashboard',
      stateLabel: 'Running',
      tone: 'ok',
      url: 'http://192.168.1.20:20001',
      canStop: true,
    });
    expect(row?.line).toMatch(/^Running · started /);
    expect(row?.stopLabel).toContain('Garden dashboard');
  });

  it('has no link or Stop once stopped, Stop on one that stopped working, a link while starting', () => {
    const rows = serviceRows(
      [
        { ...service, id: 'b1', state: 'stopped' },
        { ...service, id: 'b2', state: 'failed' },
        { ...service, id: 'b3', state: 'starting' },
      ],
      { now: SEED_NOW, timeZone: SEED_TIME_ZONE },
    );
    expect(rows.map((r) => [r.url, r.canStop, r.tone])).toEqual([
      [null, false, null],
      [null, true, 'bad'],
      ['http://192.168.1.20:20001', true, 'warn'],
    ]);
    expect(rows[2]?.line).toBe('Starting');
    expect(SERVICES_TEXT.empty('Neo')).toContain('Neo');
  });
});

function schedule(o: Partial<AgentScheduleView> = {}): AgentScheduleView {
  return {
    id: 'sch_backups',
    agentId: AGENT.id,
    conversationId: 'cnv_dm-dusty',
    threadRootId: null,
    prompt: 'Check last night’s backups and post one line here.\nThen sleep.',
    when: { kind: 'cron', expr: '30 8 * * 1-5', zone: 'Europe/Amsterdam' },
    status: 'active',
    endedReason: null,
    nextAt: '2026-09-24T06:30:00.000Z',
    endsAt: '2026-12-22T06:30:00.000Z',
    runs: 12,
    lastRunAt: '2026-09-23T06:30:00.000Z',
    createdAt: '2026-09-07T06:12:00.000Z',
    ...o,
  };
}

describe('the Schedules part (MQ-01, RA-30, AP-4972)', () => {
  it('reads what it does, when it runs and its facts, with Pause and Remove while active', () => {
    const [row] = scheduleRows([schedule()], 'Neo', SEED_TIME_ZONE, SEED_NOW);
    expect(row).toMatchObject({
      what: 'Check last night’s backups and post one line here.',
      when: 'Every weekday at 08:30 · Active',
      tone: 'ok',
      actions: ['pause', 'remove'],
    });
    expect(row?.facts).toEqual([
      { label: 'Next', value: 'Thu 24 Sep at 08:30' },
      { label: 'Stops', value: 'Tue 22 Dec at 07:30' },
      { label: 'Times run', value: '12' },
    ]);
  });

  it('offers Resume while paused, nothing once cancelled, and no ENDS once ended', () => {
    const rows = scheduleRows(
      [
        schedule({ id: 'a', status: 'paused' }),
        schedule({ id: 'c', status: 'ended', endedReason: 'cancelled', nextAt: null }),
      ],
      'Neo',
      SEED_TIME_ZONE,
      SEED_NOW,
    );
    expect(rows.map((r) => r.actions)).toEqual([['resume', 'remove'], []]);
    expect(rows[0]?.tone).toBe('warn');
    expect(rows[1]).toMatchObject({ tone: null });
    expect(rows[1]?.facts.map((f) => f.label)).toEqual(['Times run']);
  });

  it('speaks the web’s words for its buttons, the confirm and what happened', () => {
    expect(scheduleActionLabel('pause', 'Neo')).toBe('Pause');
    expect(scheduleDoneText('pause', 'Neo')).toBe(SCHEDULE_TEXT.paused);
    expect(scheduleDoneText('resume', 'Neo')).toBe('Resumed.');
    expect(scheduleDoneText('remove', 'Neo')).toBe('Cancelled. Neo won’t run it again.');
  });
});

describe('Notes and always-allowed commands (MQ-01, AP-4970)', () => {
  it('says when the notes changed last', () => {
    expect(notesMeta({ updatedAt: '2026-09-21T10:00:00.000Z' }, SEED_TIME_ZONE, SEED_NOW)).toContain(
      '21 Sep',
    );
    expect(notesMeta({ updatedAt: null }, SEED_TIME_ZONE, SEED_NOW)).toBeNull();
  });

  it('saves only changed notes, trimmed, within 1,500 characters (CT-1205)', () => {
    expect(notesEdit('Old.', '  New words.  ')).toEqual({ kind: 'save', text: 'New words.' });
    expect(notesEdit('Old.', ' Old. ')).toEqual({ kind: 'unchanged' });
    expect(notesEdit('Old.', '   ')).toEqual({ kind: 'save', text: '' });
    expect(notesEdit('', 'x'.repeat(1501)).kind).toBe('too_long');
    expect(notesCount(' ab ')).toContain('2 of 1,500');
  });

  it('lists each command with its target and key, and Remove’s label', () => {
    const allowance = {
      id: 'cma_1',
      agentId: AGENT.id,
      command: 'ssh web-1 systemctl restart caddy',
      category: 'deploy_production',
      keyId: 'deploy.production',
      target: 'web-1',
      createdById: mara.id,
      createdAt: '2026-09-20T10:00:00.000Z',
    } as CommandAllowance;
    expect(allowanceRows([allowance])).toEqual([
      {
        id: 'cma_1',
        command: 'ssh web-1 systemctl restart caddy',
        line: 'web-1 · Deploy to production',
        removeLabel: 'Remove: ssh web-1 systemctl restart caddy',
      },
    ]);
  });
});
