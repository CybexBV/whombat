/** The cookie jar of sign in once (docs/decisions/connections-setup.md CS-02): set, replaced, dropped, sent. */
import { describe, expect, it } from 'vitest';
import { CookieJar, parseSetCookie } from './cookies';
import { idName, nthName, stamp } from './network-support';

const now = new Date('2026-10-08T14:05:00Z');

describe('parseSetCookie', () => {
  it('reads the name and value and ignores the attributes', () => {
    expect(parseSetCookie('TOKEN=abc.def=; path=/; samesite=none; secure; httponly', now)).toEqual({
      name: 'TOKEN',
      value: 'abc.def=',
      expired: false,
    });
    expect(parseSetCookie('q="quoted value"', now)?.value).toBe('quoted value');
    expect(parseSetCookie('novalue', now)).toBeNull();
  });

  it('sees a removal by Max-Age or a past Expires', () => {
    expect(parseSetCookie('a=deleted; Max-Age=0', now)?.expired).toBe(true);
    expect(parseSetCookie('a=deleted; expires=Thu, 01 Jan 1970 00:00:01 GMT', now)?.expired).toBe(true);
    expect(parseSetCookie('a=1; expires=Fri, 01 Jan 2100 00:00:00 GMT', now)?.expired).toBe(false);
  });
});

describe('CookieJar', () => {
  it('keeps what answers set, replaces and drops, and sends one Cookie header', () => {
    const jar = new CookieJar(() => now);
    expect(jar.header()).toBeNull();
    expect(jar.with({ Accept: 'x' })).toEqual({ Accept: 'x' });
    jar.take({ headers: { 'set-cookie': ['PHPSESSID=one; path=/', 'lang=en'] } });
    jar.take({ headers: { 'set-cookie': 'PHPSESSID=two; path=/' } });
    expect(jar.header()).toBe('PHPSESSID=two; lang=en');
    jar.take({ headers: { 'set-cookie': ['lang=; Max-Age=0'] } });
    expect(jar.with({ Accept: 'x' })).toEqual({ Accept: 'x', Cookie: 'PHPSESSID=two' });
    jar.clear();
    expect(jar.size).toBe(0);
  });
});

describe('names', () => {
  it('stamps in UTC, derives ids and suffixes', () => {
    expect(stamp(new Date('2026-01-02T03:04:59Z'))).toBe('20260102-0304');
    expect(idName('Whombat (Home Lab)')).toBe('whombat-home-lab');
    expect(idName('Wömbät')).toBe('wombat');
    expect(idName('!!!')).toBe('whombat');
    expect([nthName('Whombat', 1), nthName('Whombat', 2), nthName('whombat', 3, '-')]).toEqual([
      'Whombat',
      'Whombat 2',
      'whombat-3',
    ]);
  });
});
