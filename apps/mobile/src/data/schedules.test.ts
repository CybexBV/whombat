/**
 * A turn an agent scheduled for itself, on the phone (Whombat resourceful-agents.md RA-30; AP-691): the card reads as
 * on the web — its state, what the agent scheduled and when it runs — and is cancelled on the web; a schedule that
 * isn't there says so.
 */
import { SCHEDULE_TEXT } from '@whombat/client';
import type { AgentScheduleView, MessageCard } from '@whombat/core';
import { AGENT } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { worldContext } from '../test/world';
import { cardSummary } from './messages';

function schedule(o: Partial<AgentScheduleView> = {}): AgentScheduleView {
  return {
    id: 'sch_backups',
    agentId: AGENT.id,
    conversationId: 'cnv_dm-dusty',
    threadRootId: null,
    prompt: 'Check last night’s backups and post one line here.',
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

const card = (s: AgentScheduleView | null): MessageCard => ({
  kind: 'schedule',
  scheduleId: 'sch_backups',
  schedule: s,
});

describe('the schedule card on the phone (RA-30; AP-691)', () => {
  it('reads its state, what the agent scheduled and when it runs', () => {
    expect(cardSummary(card(schedule()), worldContext())).toMatchObject({
      kind: 'schedule',
      label: 'SCHEDULE · ACTIVE',
      title: `${AGENT.name} scheduled: Check last night’s backups and post one line here.`,
      detail: 'Every weekday at 08:30',
      tone: 'ok',
    });
    expect(cardSummary(card(schedule({ status: 'paused' })), worldContext())).toMatchObject({
      label: 'SCHEDULE · PAUSED',
      tone: 'warn',
    });
  });

  it('says a schedule that isn’t there any more', () => {
    expect(cardSummary(card(null), worldContext())).toMatchObject({
      label: 'SCHEDULE',
      title: SCHEDULE_TEXT.gone,
      detail: null,
      quiet: true,
    });
  });
});
