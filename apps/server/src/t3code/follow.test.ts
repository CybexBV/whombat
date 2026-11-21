import { JOB_REPORT_MARK } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { SUBAGENT_MARK } from '../delegate/briefs';
import { withLaunchRules } from './follow';

const person = { trigger: 'dm' as const, mode: 'reply' as const, onBehalfOfAccountId: 'acc_mara' };

describe('a new thread’s message (withLaunchRules)', () => {
  it('tells a thread handed over for the person how to write its report, after the agent’s words, once', () => {
    const out = withLaunchRules('Fix the login bug.', person);
    expect(out.startsWith('Fix the login bug.')).toBe(true);
    expect(out).toContain(SUBAGENT_MARK);
    expect(out).toContain(JOB_REPORT_MARK);
    expect(out.indexOf(SUBAGENT_MARK)).toBeLessThan(out.indexOf(JOB_REPORT_MARK));
    // A message that has it already isn't told twice.
    expect(withLaunchRules(out, person)).toBe(out);
  });

  it('leaves it out where Whombat posts no result: a step, a report’s turn, a council, a checklist, an answer', () => {
    for (const dispatch of [
      { ...person, trigger: 'automation' as const },
      { ...person, trigger: 'feedback' as const },
      { ...person, trigger: 'council' as const },
      { ...person, trigger: 'delegation' as const },
      { ...person, mode: 'answer' as const },
      { ...person, onBehalfOfAccountId: null },
    ]) {
      const out = withLaunchRules('Do it.', dispatch);
      expect(out).toContain(SUBAGENT_MARK);
      expect(out).not.toContain(JOB_REPORT_MARK);
    }
  });
});
