/** Cards that settle into a line (CT-261, Whombat docs/decisions/card-settle.md): where a run is, what came out of it. */
import { describe, expect, it } from 'vitest';
import { MessageCard, StoredCard } from './cards.js';
import { Run } from './run.js';

describe('what a settled card needs (CT-261)', () => {
  it('a run says which thread its card is in; older servers leave it out', () => {
    expect(Run.shape.threadRootId.parse('msg_root1')).toBe('msg_root1');
    expect(Run.shape.threadRootId.parse(null)).toBeNull();
    expect(Run.shape.threadRootId.parse(undefined)).toBeUndefined();
    expect(Run.shape.threadRootId.safeParse('run_x').success).toBe(false);
  });

  it('a schedule carries the run it came out of, stored and resolved; no skill card since 0.125', () => {
    const card = { kind: 'schedule', scheduleId: 'sch_follow1', runId: 'run_fix1' };
    expect(StoredCard.parse(card)).toEqual(card);
    expect(MessageCard.parse(card)).toMatchObject({ runId: 'run_fix1' });
    expect(MessageCard.parse({ kind: 'schedule', scheduleId: 'sch_follow1', runId: null })).toMatchObject({
      runId: null,
    });
    expect(
      StoredCard.safeParse({ kind: 'schedule', scheduleId: 'sch_follow1', runId: 'msg_x' }).success,
    ).toBe(false);
    expect(StoredCard.safeParse({ kind: 'skill', proposalId: 'skp_invoice1' }).success).toBe(false);
  });
});
