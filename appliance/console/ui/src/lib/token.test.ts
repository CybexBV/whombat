import { describe, expect, it } from 'vitest';
import { authHeaders, tokenFromHash } from './token';

describe('tokenFromHash', () => {
  it('takes t= from the fragment', () => {
    expect(tokenFromHash('#t=AbC123_-xyz0987')).toBe('AbC123_-xyz0987');
    expect(tokenFromHash('#x=1&t=0123456789abcdef')).toBe('0123456789abcdef');
  });

  it('keeps base64 characters and percent-decodes', () => {
    expect(tokenFromHash('#t=ab+cd/ef==1234')).toBe('ab+cd/ef==1234');
    expect(tokenFromHash('#t=ab%2Bcd%2Fef%3D%3D')).toBe('ab+cd/ef==');
  });

  it('refuses a missing, short, broken or header-unsafe token', () => {
    expect(tokenFromHash('')).toBeNull();
    expect(tokenFromHash('#')).toBeNull();
    expect(tokenFromHash('#t=')).toBeNull();
    expect(tokenFromHash('#t=short')).toBeNull();
    expect(tokenFromHash('#t=%E0%A4%A')).toBeNull();
    expect(tokenFromHash('#t=abcdefgh%0Aijkl')).toBeNull();
    expect(tokenFromHash('#t=abcd efgh ijkl')).toBeNull();
  });
});

describe('authHeaders', () => {
  it('sends a bearer token only when there is one', () => {
    expect(authHeaders('0123456789abcdef')).toEqual({ Authorization: 'Bearer 0123456789abcdef' });
    expect(authHeaders(null)).toEqual({});
  });
});
