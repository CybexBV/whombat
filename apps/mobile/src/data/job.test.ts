import type { Handoff } from '@whombat/core';
import { type JobFixtureState, jobFixture } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { jobParts, jobToasts, threadJob } from './job';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const job = (state: JobFixtureState, over: Partial<Handoff> = {}): Handoff => ({
  id: 'mcp:job',
  to: 't3code',
  conversationId: 'cnv_chat' as never,
  rootId: 'msg_root' as never,
  agentId: 'prn_dusty' as never,
  title: 'Dusty - Fix the empty backup list',
  steps: [],
  program: 'Claude · claude-opus-5-5',
  url: null,
  ...jobFixture(state, NOW),
  ...over,
});

describe('the job of a thread', () => {
  it('is its latest hand-over, an ended one too', () => {
    const a = job('merged', { id: 'a' });
    const b = job('tests', { id: 'b' });
    expect(threadJob([a, b, job('tests', { id: 'c', rootId: 'msg_other' as never })], 'msg_root')?.id).toBe(
      'b',
    );
    expect(threadJob([], 'msg_root')).toBeNull();
  });

  it('draws only the parts the box gave', () => {
    expect(jobParts(job('reading'))).toEqual(['message']);
    expect(jobParts(job('question'))).toEqual(['question', 'plan', 'message']);
    expect(jobParts(job('needs_ok'))).toEqual(['plan', 'message']);
    expect(jobParts(job('fixing'))).toEqual(['plan', 'pullRequest', 'changes', 'checks', 'message']);
    expect(jobParts(job('merged'))).toEqual(['receipt', 'plan', 'changes', 'checks']);
    // A box from before the job view: nothing.
    expect(jobParts(job('tests', { stage: undefined, plan: undefined }))).toEqual([]);
  });
});

describe('toasts while the app is open', () => {
  it('say only that a job needs the person, is done or failed, and not for the thread on screen', () => {
    const seen = new Map<string, Handoff>();
    expect(jobToasts(seen, [job('editing')], null, true)).toEqual([]);
    expect(jobToasts(seen, [job('tests')], null, false)).toEqual([]);
    expect(jobToasts(seen, [job('needs_ok')], null, false)).toEqual([
      { kind: 'needsYou', text: 'Fix the empty backup list needs your OK in T3 Code', rootId: 'msg_root' },
    ]);
    expect(jobToasts(seen, [job('checks')], null, false)).toEqual([]);
    expect(jobToasts(seen, [job('merged')], 'msg_root', false)).toEqual([]);
    const other = new Map<string, Handoff>([['mcp:job', job('checks')]]);
    expect(jobToasts(other, [job('merged')], null, false).map((t) => t.kind)).toEqual(['done']);
  });
});
