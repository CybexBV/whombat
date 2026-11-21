import { describe, expect, it } from 'vitest';
import {
  cookieCoversHost,
  cookiesForOrigins,
  keptHours,
  keptSiteExpired,
  keptUntil,
  keptWords,
  siteName,
  uniqueOrigins,
} from './kept-site-rules';

const c = (name: string, domain: string) => ({ name, value: 'v', domain, path: '/' });

describe('kept site rules', () => {
  it('names a site by the host of its first origin', () => {
    expect(siteName(['https://accounts.hetzner.com:8443', 'https://konsoleh.hetzner.com'])).toBe(
      'accounts.hetzner.com',
    );
    expect(uniqueOrigins(['https://a.com', 'https://b.com', 'https://a.com'])).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
  });

  it('keeps only the cookies a browser sends to one of the origins', () => {
    expect(cookieCoversHost('.hetzner.com', 'accounts.hetzner.com')).toBe(true);
    expect(cookieCoversHost('accounts.hetzner.com', 'accounts.hetzner.com')).toBe(true);
    expect(cookieCoversHost('hetzner.com', 'nothetzner.com')).toBe(false);
    expect(cookieCoversHost('robot.hetzner.com', 'accounts.hetzner.com')).toBe(false);
    expect(cookieCoversHost('.', 'accounts.hetzner.com')).toBe(false);
    const kept = cookiesForOrigins(
      [c('a', '.hetzner.com'), c('b', 'konsoleh.hetzner.com'), c('c', 'tracker.example.com'), c('d', '.com')],
      ['https://accounts.hetzner.com', 'https://konsoleh.hetzner.com'],
    );
    expect(kept.map((k) => k.name)).toEqual(['a', 'b', 'd']);
  });

  it('keeps a site 4 hours by default, from its last use', () => {
    expect(keptHours(undefined)).toBe(4);
    expect(keptHours(24)).toBe(24);
    const from = new Date('2026-11-13T10:00:00Z');
    const until = keptUntil(from, 4);
    expect(until.toISOString()).toBe('2026-11-13T14:00:00.000Z');
    expect(keptSiteExpired(until, new Date('2026-11-13T13:59:59Z'))).toBe(false);
    expect(keptSiteExpired(until, until)).toBe(true);
  });

  it('says how long in plain words', () => {
    expect(keptWords('github.com', 1)).toContain('1 hour');
    expect(keptWords('github.com', 4)).toContain('4 hours');
  });
});
