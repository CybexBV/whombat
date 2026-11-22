import { describe, expect, it } from 'vitest';
import { PREVIOUS_RELEASE_STOPS_AT, previousReleaseStops, runDeadline } from './runs';

const agent = { id: 'ask', kind: 'dispatch_agent', prompt: 'Look.' } as const;
const actions = { id: 'act', kind: 'connection_actions', from: 'ask', otherwise: 'skip' } as const;

describe('runs the previous release must stop', () => {
  it('holds mail runs and runs with a step kind the previous release lacks, nothing else', () => {
    expect(previousReleaseStops({ trigger: { kind: 'mail' }, definition: { steps: [agent] } })).toBe(true);
    expect(
      previousReleaseStops({ trigger: { kind: 'manual' }, definition: { steps: [agent, actions] } }),
    ).toBe(true);
    for (const kind of ['manual', 'schedule', 'tracker', 'github', 'message_posted'])
      expect(previousReleaseStops({ trigger: { kind }, definition: { steps: [agent] } })).toBe(false);
  });

  it('reads a held run’s deadline from its own time limit, any other from deadline_at', () => {
    const createdAt = new Date('2026-11-22T10:00:00Z');
    const definition = { limits: { runTimeoutMinutes: 90 }, steps: [actions] };
    const held = { deadlineAt: PREVIOUS_RELEASE_STOPS_AT, createdAt, startedAt: createdAt, definition };
    expect(runDeadline({ ...held, trigger: { kind: 'manual' } })).toEqual(new Date('2026-11-22T11:30:00Z'));
    const own = new Date('2026-11-22T10:30:00Z');
    const plain = { limits: { runTimeoutMinutes: 30 }, steps: [agent] };
    expect(
      runDeadline({
        deadlineAt: own,
        createdAt,
        startedAt: null,
        trigger: { kind: 'manual' },
        definition: plain,
      }),
    ).toEqual(own);
  });

  it('counts a run the release gate may hold from when it first started, however long it waited before', () => {
    const createdAt = new Date('2026-11-22T10:00:00Z');
    const startedAt = new Date('2026-11-25T08:00:00Z');
    const limits = { runTimeoutMinutes: 90 };
    const proposing = { ...agent, proposeActions: true };
    for (const [trigger, steps] of [
      ['mail', [agent]],
      ['manual', [agent, actions]],
      ['manual', [proposing]],
    ] as const) {
      const run = { createdAt, trigger: { kind: trigger }, definition: { limits, steps } };
      // Stored at the epoch for the previous release, or with a deadline counted from when it was made.
      for (const deadlineAt of [PREVIOUS_RELEASE_STOPS_AT, new Date('2026-11-22T11:30:00Z')]) {
        expect(runDeadline({ ...run, deadlineAt, startedAt })).toEqual(new Date('2026-11-25T09:30:00Z'));
        // A run from before it kept when it started counts from when it was made.
        expect(runDeadline({ ...run, deadlineAt, startedAt: null })).toEqual(
          new Date('2026-11-22T11:30:00Z'),
        );
      }
    }
    // Any other run keeps the deadline it was made with, however late it started.
    const own = new Date('2026-11-22T10:30:00Z');
    const plain = { limits, steps: [agent] };
    expect(
      runDeadline({
        createdAt,
        startedAt,
        deadlineAt: own,
        trigger: { kind: 'schedule' },
        definition: plain,
      }),
    ).toEqual(own);
  });
});
