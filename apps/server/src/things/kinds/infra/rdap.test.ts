/**
 * Public RDAP bootstrap parsing, domain URL resolution, expiration date extraction and caching.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../../../services';
import {
  cachedDomainExpirations,
  defaultRdapFetch,
  IANA_RDAP_BOOTSTRAP_URL,
  parseRdapBootstrap,
  parseRdapExpiration,
  RDAP_DEADLINE_MS,
  type RdapFetch,
  rdapUrlForDomain,
  readDomainExpirations,
  warmDomainExpirations,
} from './rdap';

const outbound = vi.hoisted(() => ({
  calls: [] as { url: string; timeoutMs?: number; deadlineMs?: number }[],
  handler: null as
    | ((
        url: string,
        opts: { timeoutMs?: number; deadlineMs?: number },
      ) => Promise<{ status: number; headers: Record<string, string>; body: Buffer }>)
    | null,
}));

vi.mock('../../../lib/outbound', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/outbound')>();
  return {
    ...real,
    outboundRequest: async (
      url: string,
      _init: unknown,
      opts: { timeoutMs?: number; deadlineMs?: number } = {},
    ) => {
      outbound.calls.push({ url, timeoutMs: opts.timeoutMs, deadlineMs: opts.deadlineMs });
      if (!outbound.handler) throw new Error('unexpected outboundRequest');
      return outbound.handler(url, opts);
    },
  };
});

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

  it('shares one overall 4 s deadline across redirect hops in defaultRdapFetch', async () => {
    expect(RDAP_DEADLINE_MS).toBe(4_000);
    outbound.calls = [];
    let hop = 0;
    outbound.handler = async () => {
      hop += 1;
      await new Promise((r) => setTimeout(r, 30));
      if (hop === 1) {
        return {
          status: 302,
          headers: { location: 'https://rdap.verisign.com/com/v1/domain/example.com' } as Record<
            string,
            string
          >,
          body: Buffer.alloc(0),
        };
      }
      return {
        status: 200,
        headers: {} as Record<string, string>,
        body: Buffer.from(JSON.stringify(RDAP_DOMAIN_OK)),
      };
    };

    const res = await defaultRdapFetch('https://rdap.iana.org/domain/example.com', 200);
    expect(res.ok).toBe(true);
    expect(outbound.calls).toHaveLength(2);
    expect(outbound.calls[0]?.deadlineMs).toBeLessThanOrEqual(200);
    expect(outbound.calls[1]?.deadlineMs).toBeLessThan(outbound.calls[0]?.deadlineMs ?? 200);
    expect(outbound.calls[1]?.timeoutMs).toBe(outbound.calls[1]?.deadlineMs);

    // Exhausting the budget on hop 1 prevents hop 2 from running at all.
    outbound.calls = [];
    outbound.handler = async () => {
      await new Promise((r) => setTimeout(r, 60));
      return {
        status: 302,
        headers: { location: 'https://rdap.verisign.com/com/v1/domain/example.com' },
        body: Buffer.alloc(0),
      };
    };
    const expired = await defaultRdapFetch('https://rdap.iana.org/domain/example.com', 40);
    expect(expired.ok).toBe(false);
    expect(outbound.calls).toHaveLength(1);
    outbound.handler = null;
  });

  it('enforces one overall deadline across bootstrap and domain queries and warms cache without blocking', async () => {
    const services = fakeServices();
    const now = new Date('2026-10-21T12:00:00Z');
    // Bootstrap takes longer than the overall deadline: domain queries must never start.
    const slowBootstrap = vi.fn<RdapFetch>(async () => {
      await new Promise((r) => setTimeout(r, 120));
      return { ok: true, status: 200, json: BOOTSTRAP };
    });
    const t0 = Date.now();
    const timedOut = await readDomainExpirations(services, ['example.com'], now, slowBootstrap, 40);
    expect(timedOut).toBeNull();
    expect(Date.now() - t0).toBeLessThan(110);
    expect(slowBootstrap).toHaveBeenCalledTimes(1);

    // Cold cache reports missing synchronously without network I/O; warm populates it asynchronously.
    const services2 = fakeServices();
    expect(cachedDomainExpirations(services2, ['example.com'], now)).toEqual({
      expirations: null,
      partial: false,
      missing: true,
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fastFetch = vi.fn<RdapFetch>(async (url) => {
      await gate;
      if (url === IANA_RDAP_BOOTSTRAP_URL) return { ok: true, status: 200, json: BOOTSTRAP };
      return { ok: true, status: 200, json: RDAP_DOMAIN_OK };
    });
    warmDomainExpirations(services2, ['example.com'], now, fastFetch, 1_000);
    warmDomainExpirations(services2, ['example.com'], now, fastFetch, 1_000);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(fastFetch).toHaveBeenCalledTimes(2);
    const hit = cachedDomainExpirations(services2, ['example.com'], now);
    expect(hit.missing).toBe(false);
    expect(hit.expirations?.get('example.com')?.toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });
});
