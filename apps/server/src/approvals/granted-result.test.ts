/**
 * An approved call's result for the agent woken after the yes (docs/decisions/home-redesign.md HR-04): cut to the
 * contract's bound, and the one plain line when nobody can be woken.
 */
import { GRANTED_RESULT_TEXT_MAX } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { grantedResult, plainResultLine } from './granted-result';

describe('an approved call’s result', () => {
  it('is cut at the bound, never half a character', () => {
    const long = `${'a'.repeat(GRANTED_RESULT_TEXT_MAX - 1)}😀tail`;
    const cut = grantedResult('done', long);
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(GRANTED_RESULT_TEXT_MAX);
    expect(cut.text.endsWith('a')).toBe(true);
    expect(grantedResult('done', 'ok')).toEqual({ outcome: 'done', text: 'ok', truncated: false });
  });

  it('says one plain line when nobody can be woken', () => {
    expect(plainResultLine(grantedResult('done', 'HTTP 200 {…}'))).toBe('Done.');
    expect(plainResultLine(grantedResult('failed', 'Couldn’t reach it.'))).toContain('Couldn’t reach it.');
    expect(plainResultLine(grantedResult('error', '{"code":500}'))).not.toContain('500');
  });
});
