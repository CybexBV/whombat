import { describe, expect, it } from 'vitest';
import { unraidHostnameOf } from './unraid';

describe('Unraid’s own name (SB-09)', () => {
  it('reads the hostname from the answer, else nothing', () => {
    expect(unraidHostnameOf({ data: { info: { os: { hostname: 'BlackBox' } } } })).toBe('BlackBox');
    expect(unraidHostnameOf({ data: { info: { os: { hostname: '  ' } } } })).toBeNull();
    expect(unraidHostnameOf({ errors: [{ message: 'Forbidden resource' }] })).toBeNull();
    expect(unraidHostnameOf(null)).toBeNull();
  });
});
