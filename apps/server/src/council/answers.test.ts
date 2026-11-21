import { describe, expect, it } from 'vitest';
import { scoreOf, verdictOf } from './answers';

describe('a member’s answer lines', () => {
  it('reads the last score and verdict', () => {
    const answer =
      'The layout works.\n\nEnd with `Score: n/10`.\n\nScore: 7.5/10\nVerdict: changes needed\nMust fix:\n- x';
    expect(scoreOf(answer)).toBe(7.5);
    expect(verdictOf(answer)).toBe('changes');
  });

  it('takes Markdown around the lines', () => {
    expect(scoreOf('**Score:** 8 / 10')).toBe(8);
    expect(scoreOf('- Score: 9 out of 10')).toBe(9);
    expect(verdictOf('**Verdict: agree**')).toBe('agree');
    expect(verdictOf('Verdict: disagree')).toBe('changes');
  });

  it('is no score rather than a guess', () => {
    expect(scoreOf('I would give it about 8.')).toBeNull();
    expect(scoreOf('Score: 12/10')).toBeNull();
    expect(verdictOf('Looks good to me.')).toBeNull();
  });

  it('rounds to halves', () => {
    expect(scoreOf('Score: 8,7/10')).toBe(8.5);
  });
});
