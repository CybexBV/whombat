/** A schedule as it is now, everywhere it shows: the Schedules tab and its card in the room (RA-30; AP-683, AP-684). */
import { QueryClient } from '@tanstack/query-core';
import type { AgentScheduleView, MessagePage } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import { applySchedule } from '../react/resourceful';
import { BURROW, message, t } from '../test/fixtures';
import { endpointKey } from './keys';
import { cardPatchers } from './reducers';

function schedule(o: Partial<AgentScheduleView> = {}): AgentScheduleView {
  return {
    id: 'sch_backups',
    agentId: 'prn_neo',
    conversationId: 'cnv_incidents',
    threadRootId: null,
    prompt: 'Check the backups.',
    when: { kind: 'every', minutes: 60 },
    status: 'active',
    endedReason: null,
    nextAt: t(60),
    endsAt: t(90 * 24 * 60),
    runs: 3,
    lastRunAt: t(0),
    createdAt: t(-120),
    ...o,
  };
}

describe('applySchedule', () => {
  it('replaces the schedule on the tab and on its card, keeping a prompt the answer leaves out', () => {
    const qc = new QueryClient();
    const params = { burrow: BURROW, agent: 'neo' };
    qc.setQueryData(endpointKey(api.schedules.list, { params }), {
      schedules: [schedule(), schedule({ id: 'sch_other' })],
    });
    const listKey = endpointKey(api.messages.list, {
      params: { burrow: BURROW, conversationId: 'cnv_incidents' },
    });
    qc.setQueryData(listKey, {
      messages: [
        message('msg_card', { card: { kind: 'schedule', scheduleId: 'sch_backups', schedule: schedule() } }),
        message('msg_private', { card: { kind: 'schedule', scheduleId: 'sch_backups', schedule: null } }),
      ],
      before: null,
      hasMore: false,
    });

    const cancelled = schedule({ status: 'ended', endedReason: 'cancelled', nextAt: null });
    applySchedule(qc, cancelled);

    const list = qc.getQueryData<{ schedules: AgentScheduleView[] }>(
      endpointKey(api.schedules.list, { params }),
    );
    expect(list?.schedules[0]).toMatchObject({ status: 'ended', prompt: 'Check the backups.' });
    expect(list?.schedules[1]?.status).toBe('active');
    const page = qc.getQueryData<MessagePage>(listKey);
    expect(page?.messages[0]?.card).toMatchObject({
      kind: 'schedule',
      schedule: { status: 'ended', endedReason: 'cancelled', prompt: 'Check the backups.' },
    });
    // A card the viewer can't see stays as it is.
    expect(page?.messages[1]?.card).toEqual({ kind: 'schedule', scheduleId: 'sch_backups', schedule: null });
  });

  it('leaves other cards alone', () => {
    const card = {
      kind: 'schedule' as const,
      scheduleId: 'sch_other',
      schedule: schedule({ id: 'sch_other' }),
    };
    expect(cardPatchers.schedule(schedule({ status: 'paused' }))(card)).toBe(card);
  });
});
