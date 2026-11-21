import { describe, expect, it } from 'vitest';
import { groupError, serverNameError, slugify } from '../agents/slug';
import { safeNext } from './next';

const O = 'https://rackoon.example';

describe('safeNext', () => {
  it('keeps same-origin paths with query and hash', () => {
    expect(safeNext('/servers/basalt?range=7d#temps', O)).toBe('/servers/basalt?range=7d#temps');
    expect(safeNext('/', O)).toBe('/');
  });
  it('rejects other origins, protocol-relative and odd input', () => {
    for (const v of [null, '', 'https://evil.example/', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 'servers']) {
      expect(safeNext(v, O)).toBe('/');
    }
  });
  it('never returns to the auth pages', () => {
    expect(safeNext('/login?next=/x', O)).toBe('/');
    expect(safeNext('/setup', O)).toBe('/');
  });
});

describe('server names', () => {
  it('slugs like the hub', () => {
    expect(slugify('TheTitan')).toBe('thetitan');
    expect(slugify('web01.home.arpa')).toBe('web01-home-arpa');
    expect(slugify('--a__b--')).toBe('a-b');
    expect(slugify('x'.repeat(70))).toHaveLength(63);
    expect(slugify('')).toBe('');
  });
  it('validates names and groups', () => {
    expect(serverNameError('thetitan')).toBeNull();
    expect(serverNameError('Web-01')).toBeNull();
    expect(serverNameError('')).toMatch(/name/);
    expect(serverNameError('web_01')).toMatch(/letters, digits/);
    expect(serverNameError('-web')).toMatch(/letters, digits/);
    expect(serverNameError('a--b')).toMatch(/single dashes/);
    expect(groupError('Lab')).toBeNull();
    expect(groupError(' ')).toMatch(/name/);
    expect(groupError('all')).toMatch(/reserved/);
  });
});
