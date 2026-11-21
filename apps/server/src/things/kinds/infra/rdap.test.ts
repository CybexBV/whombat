/**
 * Public RDAP bootstrap parsing, domain URL resolution, expiration date extraction and caching.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../../../services';
import {
  IANA_RDAP_BOOTSTRAP_URL,
  parseRdapBootstrap,
  parseRdapExpiration,
  type RdapFetch,
  rdapUrlForDomain,
  readDomainExpirations,
} from './rdap';

const BOOTSTRAP = {
  version: '1.0',
  services: [
    [
      ['com', 'net'],
      ['http://insecure.example/rdap/', 'https://rdap.verisign.com/com/v1/'],
    ],
    [['org'], ['https://rdap.publicinterestregistry.org/rdap']],
    [['http-only'], ['http://plain.example/rdap/']],
  ],
};

const RDAP_DOMAIN_OK = {
  objectClassName: 'domain',
  ldhName: 'example.com',
  events: [
    { eventAction: 'registration', eventDate: '2020-10-21T00:00:00Z' },
    { eventAction: 'expiration', eventDate: '2026-11-02T00:00:00Z' },
    { eventAction: 'last changed', eventDate: '2025-10-21T00:00:00Z' },
  ],
};

const fakeServices = () => ({}) as unknown as Services;

describe('RDAP parsing and lookup', () => {
  it('parses IANA bootstrap preferring HTTPS and normalising trailing slashes', () => {
    const map = parseRdapBootstrap(BOOTSTRAP);
    expect(map.get('com')).toBe('https://rdap.verisign.com/com/v1/');
    expect(map.get('net')).toBe('https://rdap.verisign.com/com/v1/');
    expect(map.get('org')).toBe('https://rdap.publicinterestregistry.org/rdap/');
    expect(map.has('http-only')).toBe(false);
  });

  it('resolves authoritative RDAP URLs and rejects private, local and invalid names', () => {
    const map = parseRdapBootstrap(BOOTSTRAP);
    expect(rdapUrlForDomain('Example.COM.', map)).toBe('https://rdap.verisign.com/com/v1/domain/example.com');
    expect(rdapUrlForDomain('site.org', map)).toBe(
      'https://rdap.publicinterestregistry.org/rdap/domain/site.org',
    );
    expect(rdapUrlForDomain('nas.local', map)).toBeNull();
    expect(rdapUrlForDomain('router.lan', map)).toBeNull();
    expect(rdapUrlForDomain('app.internal', map)).toBeNull();
    expect(rdapUrlForDomain('10.100.0.1', map)).toBeNull();
    expect(rdapUrlForDomain('unknown.zz', map)).toBeNull();
    expect(rdapUrlForDomain('bad..example.com', map)).toBeNull();
  });

  it('extracts expiration date from RFC 9083 events, falling back to registrar expiration', () => {
    expect(parseRdapExpiration(RDAP_DOMAIN_OK)?.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(
      parseRdapExpiration({
        events: [{ eventAction: 'registrar expiration', eventDate: '2026-12-01T12:00:00Z' }],
      })?.toISOString(),
    ).toBe('2026-12-01T12:00:00.000Z');
    expect(
      parseRdapExpiration({ events: [{ eventAction: 'registration', eventDate: '2020-01-01Z' }] }),
    ).toBeNull();
    expect(parseRdapExpiration({})).toBeNull();
  });

  it('caches bootstrap and domain lookups and marks transient failures as partial', async () => {
    const services = fakeServices();
    const now = new Date('2026-10-21T12:00:00Z');
    const fetchJson = vi.fn<RdapFetch>(async (url) => {
      if (url === IANA_RDAP_BOOTSTRAP_URL) return { ok: true, status: 200, json: BOOTSTRAP };
      if (url.endsWith('/domain/example.com')) return { ok: true, status: 200, json: RDAP_DOMAIN_OK };
      if (url.endsWith('/domain/example.org')) return { ok: false, status: 503 };
      return { ok: true, status: 404, json: null };
    });

    const first = await readDomainExpirations(
      services,
      ['example.com', 'example.org', 'example.zz'],
      now,
      fetchJson,
    );
    expect(first?.partial).toBe(true);
    expect(first?.expirations.get('example.com')?.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(first?.expirations.has('example.org')).toBe(false);
    // Unsupported TLD resolves to null without marking the read partial.
    expect(first?.expirations.get('example.zz')).toBeNull();
    expect(fetchJson).toHaveBeenCalledTimes(3);

    // Second call within TTL uses cache without extra network requests.
    const second = await readDomainExpirations(services, ['example.com', 'example.org'], now, fetchJson);
    expect(second?.partial).toBe(true);
    expect(fetchJson).toHaveBeenCalledTimes(3);
  });

  it('returns null when bootstrap is unavailable', async () => {
    const services = fakeServices();
    const fetchJson = vi.fn<RdapFetch>(async () => ({ ok: false, status: 0 }));
    const res = await readDomainExpirations(
      services,
      ['example.com'],
      new Date('2026-10-21T12:00:00Z'),
      fetchJson,
    );
    expect(res).toBeNull();
  });
});
