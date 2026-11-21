import { describe, expect, it } from 'vitest';
import { classifyAddress, hostMatches, localName } from './addresses';
import { checkDestination } from './egress';

describe('classifyAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.8.9.10', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'cgnat'],
    ['169.254.10.10', 'link_local'],
    ['169.254.169.254', 'metadata'],
    ['168.63.129.16', 'metadata'],
    ['100.100.100.200', 'metadata'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.251', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['8.8.8.8', 'public'],
    ['172.32.0.1', 'public'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fd00::1', 'unique_local'],
    ['fc12::1', 'unique_local'],
    ['fd00:ec2::254', 'metadata'],
    ['fe80::1', 'link_local'],
    ['fe80::1%eth0', 'link_local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'reserved'],
    ['2606:4700::1111', 'public'],
    ['[2606:4700::1111]', 'public'],
  ])('%s is %s', (address, cls) => {
    expect(classifyAddress(address).class).toBe(cls);
  });

  it('sees IPv4 inside IPv6 (mapped, compatible, NAT64, 6to4)', () => {
    expect(classifyAddress('::ffff:127.0.0.1')).toMatchObject({ class: 'loopback', embedded: '127.0.0.1' });
    expect(classifyAddress('::ffff:7f00:1').class).toBe('loopback');
    expect(classifyAddress('::ffff:10.0.0.5').class).toBe('private');
    expect(classifyAddress('::ffff:169.254.169.254').class).toBe('metadata');
    expect(classifyAddress('::10.0.0.1').class).toBe('private');
    expect(classifyAddress('64:ff9b::a9fe:a9fe').class).toBe('metadata');
    expect(classifyAddress('64:ff9b::808:808').class).toBe('public');
    expect(classifyAddress('2002:c0a8:0101::1').class).toBe('private');
    expect(classifyAddress('2002:0808:0808::1').class).toBe('public');
    expect(classifyAddress('::ffff:8.8.8.8').class).toBe('public');
  });

  it('rejects what is not an address', () => {
    expect(classifyAddress('example.com').class).toBe('invalid');
    expect(classifyAddress('1.2.3').class).toBe('invalid');
  });
});

describe('names', () => {
  it('matches host patterns exactly or by subdomain', () => {
    expect(hostMatches('api.github.com', '*.github.com')).toBe(true);
    expect(hostMatches('github.com', '*.github.com')).toBe(false);
    expect(hostMatches('evilgithub.com', '*.github.com')).toBe(false);
    expect(hostMatches('GitHub.com.', 'github.com')).toBe(true);
    expect(hostMatches('anything.example', '*')).toBe(true);
  });

  it('treats local and metadata names as local', () => {
    for (const n of [
      'localhost',
      'foo.localhost',
      'metadata.google.internal',
      'db.internal',
      'printer.local',
      'nas',
    ])
      expect(localName(n)).toBe(true);
    expect(localName('api.anthropic.com')).toBe(false);
  });
});

describe('checkDestination', () => {
  const resolveTo = (map: Record<string, string[]>) => async (host: string) => {
    const found = map[host];
    if (!found) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    return found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  const policy = { allow: ['api.anthropic.com', '*.github.com', 'github.com'] };

  it('allows an allowlisted name with public addresses only', async () => {
    const r = await checkDestination(
      'api.anthropic.com',
      443,
      policy,
      resolveTo({ 'api.anthropic.com': ['160.79.104.10'] }),
    );
    expect(r).toEqual({ ok: true, address: '160.79.104.10', family: 4 });
  });

  it('refuses names off the list, local names, literals and other ports', async () => {
    const res = resolveTo({ 'evil.example': ['1.2.3.4'], 'github.com': ['140.82.121.4'] });
    expect((await checkDestination('evil.example', 443, policy, res)).ok).toBe(false);
    expect((await checkDestination('localhost', 443, { allow: 'public' }, res)).ok).toBe(false);
    expect((await checkDestination('1.2.3.4', 443, policy, res)).ok).toBe(false);
    expect((await checkDestination('github.com', 22, policy, res)).ok).toBe(false);
  });

  it('refuses a name with any private address (rebinding), in public mode too', async () => {
    const res = resolveTo({
      'rebind.example': ['1.2.3.4', '10.0.0.1'],
      'six.example': ['2606:4700::1', 'fd00::5'],
    });
    const a = await checkDestination('rebind.example', 443, { allow: 'public' }, res);
    expect(a).toMatchObject({ ok: false, reason: expect.stringContaining('10.0.0.1 is private') });
    expect((await checkDestination('six.example', 443, { allow: 'public' }, res)).ok).toBe(false);
  });

  it('refuses every non-public literal in public mode, IPv4 and IPv6', async () => {
    for (const host of [
      '127.0.0.1',
      '10.0.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.1.1',
      '[::1]',
      'fd00::1',
      '::ffff:127.0.0.1',
      'fe80::1',
    ])
      expect((await checkDestination(host, 443, { allow: 'public' })).ok, host).toBe(false);
    expect((await checkDestination('8.8.8.8', 443, { allow: 'public' })).ok).toBe(true);
  });

  it('opens a customer network only through an explicit grant, never loopback or metadata', async () => {
    const grants = [
      { cidr: '10.20.0.0/16', ports: [8080] },
      { cidr: '127.0.0.0/8' },
      { cidr: '169.254.0.0/16' },
    ];
    const p = { allow: [] as string[], grants };
    expect((await checkDestination('10.20.1.2', 8080, p)).ok).toBe(true);
    expect((await checkDestination('10.20.1.2', 443, p)).ok).toBe(false);
    expect((await checkDestination('10.21.1.2', 8080, p)).ok).toBe(false);
    expect((await checkDestination('127.0.0.1', 443, p)).ok).toBe(false);
    expect((await checkDestination('169.254.169.254', 443, p)).ok).toBe(false);
  });
});
