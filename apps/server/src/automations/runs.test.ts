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
    const definition = { limits: { runTimeoutMinutes: 90 } };
    expect(runDeadline({ deadlineAt: PREVIOUS_RELEASE_STOPS_AT, createdAt, definition })).toEqual(
      new Date('2026-11-22T11:30:00Z'),
    );
    const own = new Date('2026-11-22T10:30:00Z');
    expect(runDeadline({ deadlineAt: own, createdAt, definition })).toEqual(own);
  });
});
