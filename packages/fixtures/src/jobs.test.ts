import { Handoff } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { JOB_FIXTURE_STATES, jobFixture, jobSteps } from './jobs';

describe('job fixtures', () => {
  it('are hand-overs the contract accepts, in each state the job view draws', () => {
    const now = Date.parse('2026-11-07T12:00:00Z');
    for (const state of JOB_FIXTURE_STATES) {
      const h = Handoff.parse({
        id: `mcp:${state}`,
        to: 't3code',
        conversationId: 'cnv_chat',
        rootId: 'msg_root',
        agentId: 'prn_dusty',
        title: 'Fix the empty backup list',
        steps: jobSteps(state),
        program: 'Claude · claude-opus-5-5',
        url: null,
        ...jobFixture(state, now),
      });
      expect(h.stage === null || typeof h.stage === 'string').toBe(true);
    }
    expect(jobFixture('fixing', now).checks).toMatchObject({ failing: 'Unit tests', attempts: 1 });
    expect(jobFixture('merged', now).receipt?.tests).toBe('passed');
    // The ended job has its whole answer to read; a job at work has none.
    expect(jobFixture('merged', now).answer).toContain(jobFixture('merged', now).receipt?.summary);
    expect(jobFixture('tests', now).answer).toBeNull();
    // The step a job is on is the one not done yet.
    expect(
      jobSteps('tests')
        .filter((s) => !s.done)
        .map((s) => s.text),
    ).toEqual(['Running the tests']);
    expect(jobSteps('merged').every((s) => s.done)).toBe(true);
  });
});
