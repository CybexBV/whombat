import { describe, expect, it } from 'vitest';
import { newStep, planChangePayload, planEventText, type StoredStep, stepRemovable } from './plans';

const step = (id: string, over: Partial<StoredStep> = {}): StoredStep => ({
  ...newStep(id, `Step ${id}`, null),
  ...over,
});

describe('stepRemovable (WS-07)', () => {
  it('removes only a queued step that never started and links nothing', () => {
    expect(stepRemovable(step('a'))).toBe(true);
    expect(stepRemovable(step('a', { state: 'active' }))).toBe(false);
    expect(stepRemovable(step('a', { runId: 'run_1' }))).toBe(false);
    expect(stepRemovable(step('a', { dispatchId: 'dsp_1' }))).toBe(false);
    expect(stepRemovable(step('a', { followKey: 'run:run_1:failed' }))).toBe(false);
    // Back to queued, but it had started.
    expect(stepRemovable(step('a', { startedAt: '2026-09-26T10:00:00.000Z' }))).toBe(false);
  });
});

describe('planChangePayload (WS-03, WS-10)', () => {
  it('holds ids, states and old/new links, never titles or notes', () => {
    const before = {
      title: 'Secret',
      due: null,
      steps: [step('a', { runId: 'run_1' }), step('b'), step('c')],
    };
    const after = {
      title: 'Secret v2',
      due: '2026-10-14',
      steps: [
        step('b', { title: 'Renamed secret', note: 'a secret note' }),
        step('a', { runId: 'run_2', state: 'blocked' }),
        step('d'),
      ],
    };
    const payload = planChangePayload(before, after);
    expect(payload).toEqual({
      renamed: true,
      due: [null, '2026-10-14'],
      added: ['d'],
      removed: ['c'],
      reordered: true,
      steps: [
        { stepId: 'b', title: true, note: true },
        {
          stepId: 'a',
          state: ['queued', 'blocked'],
          runId: ['run_1', 'run_2'],
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toMatch(/secret/i);
  });
});

describe('planEventText (WS-10)', () => {
  it('names the plan in branch rooms only', () => {
    expect(planEventText({ kind: 'branch' }, 'Invoice PDF export', 'made')).toBe(
      'Made the plan “Invoice PDF export”',
    );
    expect(planEventText({ kind: 'branch' }, 'Invoice PDF export', 'updated')).toBe(
      'Updated the plan “Invoice PDF export”',
    );
    expect(planEventText({ kind: 'dm' }, 'Birthday', 'made')).toBe('Made a plan');
    expect(planEventText({ kind: 'dm' }, 'Birthday', 'updated')).toBe('Updated a plan');
  });
});
