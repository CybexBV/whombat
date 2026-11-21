/**
 * The Vault's pure rules (docs/decisions/vault.md VT-82; since 0.125 without Ask, passes or relays, CT-1240…CT-1244):
 * where an entry may connect, credentials and scrubbing, an MCP entry's tools, the copy.
 */
import { describe, expect, it } from 'vitest';
import {
  addressIsPublic,
  canonicalCidr,
  classifyAddress,
  cleanVaultToolText,
  filterVaultResponseHeaders,
  formatIpv6,
  isVaultActivityTool,
  mergeVaultTools,
  parseCidr,
  parseIp,
  parseIpv4,
  parseIpv6,
  parseVaultUrl,
  scrubSecret,
  scrubSecretDeep,
  VAULT_ADDRESS_NOT_ALLOWED_ANY_MORE,
  VAULT_AUDIT_TEXTS,
  VAULT_CHECK_OUTCOMES,
  VAULT_ENTRY_KINDS,
  VAULT_NETWORK_PROBLEM_TEXT,
  VAULT_NEW_TEMPLATES,
  VAULT_PRIVATE_ENTRY,
  VAULT_TEMPLATE_DEFS,
  VAULT_TEMPLATES,
  VAULT_TOOLS_MAX,
  VAULT_TOTP_UNSET,
  VaultAuth,
  VaultEntry,
  VaultEntryDetail,
  VaultNetwork,
  vaultAuditDetailText,
  vaultAuditText,
  vaultBase64,
  vaultBasicAuthorization,
  vaultCheckLine,
  vaultCheckSummary,
  vaultCredential,
  vaultDestinationProblem,
  vaultEntryAddress,
  vaultEntryKey,
  vaultEntryLabel,
  vaultEntryMeta,
  vaultEntryProblem,
  vaultEntryShapeProblems,
  vaultEntryWhere,
  vaultNetworkProblem,
  vaultNetworksFile,
  vaultRequestQuery,
  vaultSecretForms,
  vaultSecretLine,
  vaultTemplateDescription,
  vaultTemplateOf,
  vaultToolHash,
  vaultTurnUseWhat,
  vaultUseRow,
  withCredentialQuery,
} from './index.js';

const TZ = 'Europe/Amsterdam';
const NOW = '2026-09-23T09:22:00.000Z';

describe('IP addresses', () => {
  it('parses strict IPv4', () => {
    expect(parseIpv4('192.168.1.10')).toEqual([192, 168, 1, 10]);
    for (const bad of [
      '192.168.1',
      '192.168.1.256',
      '192.168.01.1',
      '1.2.3.4.5',
      ' 1.2.3.4',
      '0x7f.0.0.1',
      '',
    ])
      expect(parseIpv4(bad), bad).toBeNull();
  });

  it('parses IPv6 in every text form', () => {
    expect(parseIpv6('::1')).toEqual([...new Array(15).fill(0), 1]);
    expect(parseIpv6('::')).toEqual(new Array(16).fill(0));
    expect(parseIpv6('2001:db8::8:800:200c:417a')).toEqual(parseIpv6('2001:0db8:0:0:8:800:200c:417a'));
    expect(parseIpv6('::ffff:192.168.1.10')?.slice(10)).toEqual([0xff, 0xff, 192, 168, 1, 10]);
    expect(parseIpv6('1:2:3:4:5:6:7::')).not.toBeNull();
    for (const bad of [
      '1::2::3',
      '1:2:3:4:5:6:7:8:9',
      '1:2:3:4:5:6:7:8::',
      '12345::',
      'fe80::1%eth0',
      '1.2.3.4::',
      '::1.2.3',
      ':1:2:3:4:5:6:7',
      'g::1',
    ])
      expect(parseIpv6(bad), bad).toBeNull();
  });

  it('formats IPv6 as RFC 5952 does', () => {
    const f = (t: string) => formatIpv6(parseIpv6(t) as number[]);
    expect(f('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
    expect(f('2001:db8:0:1:1:1:1:1')).toBe('2001:db8:0:1:1:1:1:1');
    expect(f('2001:0:0:1:0:0:0:1')).toBe('2001:0:0:1::1');
    expect(f('2001:db8:0:0:1:0:0:1')).toBe('2001:db8::1:0:0:1');
    expect(f('0:0:0:0:0:0:0:0')).toBe('::');
    expect(f('fd00:ec2:0:0:0:0:0:254')).toBe('fd00:ec2::254');
  });

  it('parses bracketed literals', () => {
    expect(parseIp('[::1]')).toEqual({ family: 6, bytes: [...new Array(15).fill(0), 1] });
    expect(parseIp('10.0.0.1')?.family).toBe(4);
    expect(parseIp('example.com')).toBeNull();
  });

  it('classes every non-public range the server refuses, and the metadata addresses', () => {
    const cases: [string, string][] = [
      ['0.0.0.0', 'unspecified'],
      ['0.1.2.3', 'reserved'],
      ['10.1.2.3', 'private'],
      ['100.64.0.1', 'private'],
      ['100.127.255.255', 'private'],
      ['127.0.0.1', 'loopback'],
      ['127.255.0.9', 'loopback'],
      ['169.254.1.1', 'link_local'],
      ['169.254.169.254', 'metadata'],
      ['169.254.170.2', 'metadata'],
      ['100.100.100.200', 'metadata'],
      ['168.63.129.16', 'metadata'],
      ['172.16.0.1', 'private'],
      ['172.31.255.255', 'private'],
      ['192.0.0.8', 'reserved'],
      ['192.0.2.1', 'documentation'],
      ['192.88.99.1', 'reserved'],
      ['192.168.1.10', 'private'],
      ['198.18.0.1', 'reserved'],
      ['198.51.100.7', 'documentation'],
      ['203.0.113.9', 'documentation'],
      ['224.0.0.1', 'multicast'],
      ['239.255.255.250', 'multicast'],
      ['240.0.0.1', 'reserved'],
      ['255.255.255.255', 'reserved'],
      ['::', 'unspecified'],
      ['::1', 'loopback'],
      ['::7f00:1', 'reserved'],
      ['64:ff9b::a00:1', 'reserved'],
      ['64:ff9b:1::1', 'reserved'],
      ['100::1', 'reserved'],
      ['2001::1', 'reserved'],
      ['2001:0:4136:e378::1', 'reserved'],
      ['2001:db8::1', 'documentation'],
      ['2002:c0a8:10a::1', 'reserved'],
      ['3fff::1', 'documentation'],
      ['fc00::1', 'private'],
      ['fd12:3456:789a::1', 'private'],
      ['fd00:ec2::254', 'metadata'],
      ['fe80::1', 'link_local'],
      ['fec0::1', 'reserved'],
      ['ff02::1', 'multicast'],
      ['::ffff:127.0.0.1', 'loopback'],
      ['::ffff:169.254.169.254', 'metadata'],
      ['::ffff:c0a8:10a', 'private'],
      ['8.8.8.8', 'public'],
      ['1.1.1.1', 'public'],
      ['172.32.0.1', 'public'],
      ['100.128.0.1', 'public'],
      ['2606:4700:4700::1111', 'public'],
      ['::ffff:8.8.8.8', 'public'],
    ];
    for (const [ip, cls] of cases) expect(classifyAddress(parseIp(ip) as never), ip).toBe(cls);
    expect(addressIsPublic('8.8.8.8')).toBe(true);
    expect(addressIsPublic('192.168.1.1')).toBe(false);
    expect(addressIsPublic('not an ip')).toBe(false);
  });
});

describe('the home network list (VT-12)', () => {
  it('reads CIDRs canonically, clearing host bits', () => {
    expect(parseCidr('192.168.1.7/24')?.cidr).toBe('192.168.1.0/24');
    expect(canonicalCidr('192.168.1.10')).toBe('192.168.1.10/32');
    expect(canonicalCidr('FD12:3456:789A:0:0:0:0:1/48')).toBe('fd12:3456:789a::/48');
    expect(canonicalCidr('10.0.0.0/33')).toBeNull();
    expect(canonicalCidr('10.0.0.0/08')).toBeNull();
    expect(canonicalCidr('10.0.0.0/')).toBeNull();
    expect(canonicalCidr('nope/24')).toBeNull();
  });

  it('lists private networks up to a /16 or /48', () => {
    expect(vaultNetworkProblem('192.168.1.0/24', [80, 8123])).toBeNull();
    expect(vaultNetworkProblem('10.20.0.0/16', [443])).toBeNull();
    expect(vaultNetworkProblem('172.16.5.0/24', [22])).toBeNull();
    expect(vaultNetworkProblem('100.101.0.0/16', [8123])).toBeNull();
    expect(vaultNetworkProblem('fd12:3456:789a::/48', [8123])).toBeNull();
    expect(vaultNetworkProblem('192.168.1.20', [80])).toBeNull();
  });

  it('refuses every never-listable range', () => {
    const code = (cidr: string, ports = [80]) => vaultNetworkProblem(cidr, ports)?.code;
    expect(code('192.168.1.0/33')).toBe('invalid');
    expect(code('garden')).toBe('invalid');
    expect(code('10.0.0.0/8')).toBe('too_wide');
    expect(code('172.16.0.0/12')).toBe('too_wide');
    expect(code('192.168.0.0/15')).toBe('too_wide');
    expect(code('fc00::/7')).toBe('too_wide');
    expect(code('fd00::/47')).toBe('too_wide');
    expect(code('127.0.0.0/16')).toBe('loopback');
    expect(code('::1/128')).toBe('loopback');
    expect(code('169.254.0.0/16')).toBe('link_local');
    expect(code('169.254.169.254/32')).toBe('metadata');
    expect(code('100.100.0.0/16')).toBe('metadata');
    expect(code('fd00:ec2::/48')).toBe('metadata');
    expect(code('fe80::/64')).toBe('link_local');
    expect(code('224.0.0.0/24')).toBe('multicast');
    expect(code('ff02::/64')).toBe('multicast');
    expect(code('0.0.0.0/16')).toBe('unspecified');
    expect(code('240.0.0.0/16')).toBe('reserved');
    expect(code('198.18.0.0/16')).toBe('reserved');
    expect(code('2002::/48')).toBe('reserved');
    expect(code('192.0.2.0/24')).toBe('documentation');
    expect(code('2001:db8::/48')).toBe('documentation');
    expect(code('8.8.8.0/24')).toBe('public');
    expect(code('2606:4700::/48')).toBe('public');
    expect(code('::ffff:192.168.1.0/120')).toBe('mapped');
    expect(VAULT_NETWORK_PROBLEM_TEXT.too_wide).toBe(
      'That network is too wide. Use a /16 or narrower (a /48 or narrower for IPv6).',
    );
  });

  it('needs 1–16 different ports between 1 and 65535', () => {
    expect(vaultNetworkProblem('192.168.1.0/24', [])?.field).toBe('ports');
    expect(vaultNetworkProblem('192.168.1.0/24', [0])?.code).toBe('ports');
    expect(vaultNetworkProblem('192.168.1.0/24', [65536])?.code).toBe('ports');
    expect(vaultNetworkProblem('192.168.1.0/24', [80, 80])?.code).toBe('ports');
    expect(vaultNetworkProblem('192.168.1.0/24', [1.5])?.code).toBe('ports');
    expect(
      vaultNetworkProblem(
        '192.168.1.0/24',
        Array.from({ length: 17 }, (_, i) => i + 1),
      )?.code,
    ).toBe('ports');
  });

  it('writes the appliance file sorted, without notes', () => {
    expect(
      vaultNetworksFile([
        { cidr: '192.168.2.0/24', ports: [8123, 80] },
        { cidr: '192.168.1.7/24', ports: [443, 80, 80] },
      ]),
    ).toEqual({
      version: 1,
      networks: [
        { cidr: '192.168.1.0/24', ports: [80, 443] },
        { cidr: '192.168.2.0/24', ports: [80, 8123] },
      ],
    });
  });

  it('parses a network row', () => {
    expect(
      VaultNetwork.parse({
        id: 'vln_home',
        cidr: '192.168.1.0/24',
        ports: [80, 8123],
        note: 'Home Assistant',
        addedBy: 'Mara Okafor',
        addedAt: NOW,
      }).ports,
    ).toEqual([80, 8123]);
  });
});

describe('entry URLs', () => {
  it('parses http and https URLs without WHATWG URL', () => {
    const ok = (raw: string) => {
      const r = parseVaultUrl(raw);
      if (!r.ok) throw new Error(r.message);
      return r.url;
    };
    expect(ok('http://192.168.1.10:8123/api/mcp')).toMatchObject({
      scheme: 'http',
      host: '192.168.1.10',
      hostKind: 'ipv4',
      port: 8123,
      origin: 'http://192.168.1.10:8123',
      path: '/api/mcp',
      basePath: '/api/mcp',
    });
    expect(ok('HTTPS://Grafana.Example.com')).toMatchObject({
      host: 'grafana.example.com',
      port: 443,
      path: '/',
      basePath: '',
      origin: 'https://grafana.example.com',
    });
    expect(ok('https://api.example.com:443/v1/')).toMatchObject({
      basePath: '/v1',
      origin: 'https://api.example.com',
    });
    expect(ok('http://[fd12::10]:8123/')).toMatchObject({ host: 'fd12::10', hostKind: 'ipv6', port: 8123 });
    expect(ok('http://homeassistant.local:8123')).toMatchObject({
      host: 'homeassistant.local',
      hostKind: 'name',
    });
  });

  it('refuses what it can’t use', () => {
    const code = (raw: string) => {
      const r = parseVaultUrl(raw);
      return r.ok ? null : r.code;
    };
    expect(code('ftp://example.com')).toBe('scheme');
    expect(code('javascript:alert(1)')).toBe('invalid');
    expect(code('example.com')).toBe('invalid');
    expect(code('https://user:pw@example.com')).toBe('credentials');
    expect(code('https://example.com/?token=1')).toBe('query');
    expect(code('https://example.com/#x')).toBe('query');
    expect(code('https://example.com:0')).toBe('port');
    expect(code('https://example.com:99999')).toBe('port');
    expect(code('https://exa mple.com')).toBe('host');
    expect(code('http://127.1/')).toBe('host');
    expect(code('http://0x7f.0.0.1/')).toBe('host');
    expect(code('http://[::1/')).toBe('host');
    expect(code('https://example.com/a/../b')).toBe('path');
    expect(code('https://example.com/a//b')).toBe('path');
    expect(code('https://example.com/a/%2e%2e/b')).toBe('path');
    expect(code(`https://example.com/${'a'.repeat(2000)}`)).toBe('invalid');
  });

  it('shows the address on the card', () => {
    expect(vaultEntryAddress('http://192.168.1.10:8123/api/mcp')).toBe('192.168.1.10:8123');
    expect(vaultEntryAddress('https://grafana.example.com')).toBe('grafana.example.com');
    expect(vaultEntryAddress('http://[fd12::10]:8123')).toBe('[fd12::10]:8123');
  });
});

describe('vaultDestinationProblem (VT-11…VT-13)', () => {
  const networks = [{ cidr: '192.168.1.0/24', ports: [80, 8123] }];

  it('allows public https and refuses public http', () => {
    expect(
      vaultDestinationProblem({ url: 'https://grafana.example.com', resolved: ['93.184.215.14'], networks }),
    ).toBeNull();
    expect(
      vaultDestinationProblem({ url: 'http://grafana.example.com', resolved: ['93.184.215.14'], networks })
        ?.code,
    ).toBe('http_public');
  });

  it('allows a listed network and port, over http too', () => {
    expect(
      vaultDestinationProblem({ url: 'http://192.168.1.10:8123/api/mcp', resolved: [], networks }),
    ).toBeNull();
    expect(
      vaultDestinationProblem({
        url: 'http://homeassistant.local:8123',
        resolved: ['192.168.1.10'],
        networks,
      }),
    ).toBeNull();
    expect(vaultDestinationProblem({ url: 'http://192.168.1.20', resolved: [], networks })).toBeNull();
    expect(
      vaultDestinationProblem({
        url: 'https://ha.example.com:8123',
        resolved: ['::ffff:192.168.1.10'],
        networks,
      }),
    ).toBeNull();
  });

  it('refuses an unlisted network or port, and says what to add', () => {
    const unlisted = vaultDestinationProblem({
      url: 'http://192.168.2.10:8123/api/mcp',
      resolved: [],
      networks: [],
    });
    expect(unlisted).toMatchObject({
      code: 'not_listed',
      suggestion: { cidr: '192.168.2.0/24', port: 8123 },
    });
    expect(unlisted?.message).toContain('192.168.2.0/24 port 8123');
    expect(unlisted?.message).not.toMatch(/admin/i);
    expect(
      vaultDestinationProblem({ url: 'http://192.168.1.10:8080', resolved: [], networks })?.message,
    ).toContain('192.168.1.0/24 port 8080');
    expect(
      vaultDestinationProblem({ url: 'http://[fd12:3456:789a:1::10]:8123', resolved: [], networks })
        ?.suggestion,
    ).toEqual({ cidr: 'fd12:3456:789a:1::/64', port: 8123 });
  });

  it('opens every private address on any port with the local network open (LN-01)', () => {
    for (const url of [
      'http://10.100.0.5:8123',
      'http://192.168.2.10:8080/api',
      'https://172.16.4.1',
      'http://100.101.102.103:3000',
      'http://[fd12:3456:789a:1::10]:8123',
    ])
      expect(vaultDestinationProblem({ url, resolved: [], networks: [], lan: true }), url).toBeNull();
    expect(
      vaultDestinationProblem({
        url: 'http://ha.example.com:8123',
        resolved: ['10.100.0.5'],
        networks: [],
        lan: true,
      }),
    ).toBeNull();
    // Never-listable ranges, mixed answers and plain http to the internet stay refused.
    for (const url of ['http://127.0.0.1:8123', 'http://169.254.169.254', 'http://100.100.100.200'])
      expect(vaultDestinationProblem({ url, resolved: [], networks: [], lan: true })?.code, url).toBe(
        'never',
      );
    expect(
      vaultDestinationProblem({
        url: 'http://ha.example.com:8123',
        resolved: ['10.100.0.5', '93.184.215.14'],
        networks: [],
        lan: true,
      })?.code,
    ).toBe('mixed');
    expect(
      vaultDestinationProblem({ url: 'http://93.184.215.14', resolved: [], networks: [], lan: true })?.code,
    ).toBe('http_public');
  });

  it('needs every resolved address listed (DNS rebinding, mixed answers)', () => {
    expect(
      vaultDestinationProblem({
        url: 'http://ha.example.com:8123',
        resolved: ['192.168.1.10', '192.168.3.1'],
        networks,
      })?.code,
    ).toBe('not_listed');
    expect(
      vaultDestinationProblem({
        url: 'https://ha.example.com',
        resolved: ['93.184.215.14', '192.168.1.10'],
        networks,
      })?.code,
    ).toBe('mixed');
    expect(
      vaultDestinationProblem({ url: 'https://rebind.example', resolved: ['127.0.0.1'], networks }),
    ).toEqual({
      code: 'never',
      message: '127.0.0.1 can’t be reached from the Vault.',
    });
  });

  it('never reaches loopback, link-local or metadata, listed or not', () => {
    const all = [{ cidr: '169.254.0.0/16', ports: [80] }];
    for (const url of [
      'http://169.254.169.254/latest',
      'http://127.0.0.1:8123',
      'http://[::1]:8123',
      'http://[fe80::1]',
    ])
      expect(vaultDestinationProblem({ url, resolved: [], networks: all })?.code, url).toBe('never');
    expect(
      vaultDestinationProblem({ url: 'http://localhost:8123', resolved: ['::1', '127.0.0.1'], networks })
        ?.code,
    ).toBe('never');
  });

  it('refuses a name that doesn’t resolve, and bad URLs', () => {
    expect(vaultDestinationProblem({ url: 'https://nowhere.example', resolved: [], networks })?.code).toBe(
      'unresolved',
    );
    expect(vaultDestinationProblem({ url: 'https://x.example', resolved: ['bogus'], networks })?.code).toBe(
      'unresolved',
    );
    expect(vaultDestinationProblem({ url: 'ftp://x', resolved: [], networks })?.code).toBe('bad_url');
  });

  it('says “isn’t allowed any more” when a call finds it refused', () => {
    expect(
      vaultDestinationProblem({ url: 'http://192.168.1.10:8123', resolved: [], networks: [], at: 'call' }),
    ).toEqual({ code: 'not_listed', message: VAULT_ADDRESS_NOT_ALLOWED_ANY_MORE });
    expect(VAULT_ADDRESS_NOT_ALLOWED_ANY_MORE).toBe('This Vault entry’s address isn’t allowed any more.');
  });
});

describe('queries and credentials (VT-41)', () => {
  it('builds the query and keeps the entry’s own parameter for Whombat', () => {
    expect(vaultRequestQuery({ q: 'a b', tag: ['x', 'y*'] }, null)).toEqual({
      ok: true,
      search: '?q=a%20b&tag=x&tag=y%2A',
    });
    expect(vaultRequestQuery(undefined, null)).toEqual({ ok: true, search: '' });
    expect(vaultRequestQuery({ API_KEY: 'x' }, { type: 'query', name: 'api_key' }).ok).toBe(false);
  });

  it('adds a query credential last', () => {
    const cred = vaultCredential({ type: 'query', name: 'key' }, 's3cr3t&x');
    expect(withCredentialQuery('https://api.example.com/v1/users?page=2', cred.query)).toBe(
      'https://api.example.com/v1/users?page=2&key=s3cr3t%26x',
    );
    expect(withCredentialQuery('https://h/x', 'k=v')).toBe('https://h/x?k=v');
    expect(withCredentialQuery('https://h/x', null)).toBe('https://h/x');
  });

  it('adds the credential for each way of signing in', () => {
    expect(vaultCredential({ type: 'bearer' }, 'tok')).toEqual({
      headers: { Authorization: 'Bearer tok' },
      query: null,
    });
    expect(vaultCredential({ type: 'header', name: 'X-API-Key' }, 'tok').headers).toEqual({
      'X-API-Key': 'tok',
    });
    expect(vaultCredential({ type: 'basic', username: 'Aladdin' }, 'open sesame').headers).toEqual({
      Authorization: 'Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
    });
    expect(vaultCredential({ type: 'none' }, '')).toEqual({ headers: {}, query: null });
    expect(vaultBasicAuthorization('admin', 'pw')).toBe('Basic YWRtaW46cHc=');
    expect(vaultBase64('é')).toBe('w6k=');
    expect(vaultBase64('💡')).toBe('8J+SoQ==');
    expect(vaultBase64('')).toBe('');
  });
});

describe('responses and scrubbing (VT-41, VT-42)', () => {
  const base = 'https://api.example.com/v1';

  it('passes only the allowed response headers', () => {
    expect(
      filterVaultResponseHeaders(
        {
          'content-type': 'application/json',
          'Content-Length': '12',
          etag: '"x"',
          'last-modified': 'y',
          'retry-after': '3',
          link: '<a>',
          'x-ratelimit-remaining': '9',
          'set-cookie': ['a=1', 'b=2'],
          server: 'nginx',
          'www-authenticate': 'Bearer',
          'x-echo': 'secret',
          vary: ['a', 'b'],
          missing: undefined,
        },
        base,
      ),
    ).toEqual({
      'Content-Type': 'application/json',
      'Content-Length': '12',
      ETag: '"x"',
      'Last-Modified': 'y',
      'Retry-After': '3',
      Link: '<a>',
      'X-RateLimit-Remaining': '9',
    });
  });

  it('keeps Location only under the same base', () => {
    const loc = (location: string, requestPath?: string) =>
      filterVaultResponseHeaders({ location }, base, requestPath).Location;
    expect(loc('https://api.example.com/v1/users/8')).toBe('https://api.example.com/v1/users/8');
    expect(loc('/v1/users/8')).toBe('/v1/users/8');
    expect(loc('8', '/v1/users/7')).toBe('8');
    expect(loc('/v2/users')).toBe('elsewhere');
    expect(loc('/v1/../admin')).toBe('elsewhere');
    expect(loc('https://evil.example/v1/x')).toBe('elsewhere');
    expect(loc('http://api.example.com/v1/x')).toBe('elsewhere');
    expect(loc('//evil.example/v1')).toBe('elsewhere');
    expect(loc('8')).toBe('elsewhere');
    expect(filterVaultResponseHeaders({ Location: '/anything' }, 'https://h').Location).toBe('/anything');
  });

  it('scrubs the secret in every form a server might echo', () => {
    const secret = 'p@ss w/rd+"é';
    const forms = vaultSecretForms(secret, 'admin');
    const echoed = [
      `raw ${secret}`,
      `url ${encodeURIComponent(secret)}`,
      `lower ${encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (e) => e.toLowerCase())}`,
      `plus ${encodeURIComponent(secret).replace(/%20/g, '+')}`,
      `json ${JSON.stringify({ t: secret })}`,
      `b64 ${vaultBase64(secret)}`,
      `basic ${vaultBasicAuthorization('admin', secret)}`,
    ].join('\n');
    const scrubbed = scrubSecret(echoed, secret, 'admin');
    for (const form of forms) expect(scrubbed.includes(form), form).toBe(false);
    expect(scrubbed).toContain('raw [secret]');
    expect(scrubbed).toContain('basic Basic [secret]');
    expect(scrubSecret('nothing here', secret)).toBe('nothing here');
    expect(scrubSecret('abc', '')).toBe('abc');
  });

  it('scrubs URL-safe and unpadded base64', () => {
    const secret = 'ÿÿ>?';
    const std = vaultBase64(secret);
    expect(std).toMatch(/[+/]/);
    const url = std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(scrubSecret(`x ${url} y`, secret)).toBe('x [secret] y');
  });

  it('scrubs nested results, keys included', () => {
    expect(
      scrubSecretDeep({ content: [{ type: 'text', text: 'Bearer tok123' }], tok123: 1, n: 2 }, 'tok123'),
    ).toEqual({ content: [{ type: 'text', text: 'Bearer [secret]' }], '[secret]': 1, n: 2 });
  });
});

describe('an MCP entry’s tools and an entry’s key (VT-44, CT-1241)', () => {
  it('derives an 8-letter key from the entry id', () => {
    const key = vaultEntryKey('vlt_homeassistant');
    expect(key).toMatch(/^[a-z]{8}$/);
    expect(vaultEntryKey('vlt_homeassistant')).toBe(key);
    expect(vaultEntryKey('vlt_grafana')).not.toBe(key);
  });

  it('has no bridged tool names: only its own tools and Hermes’s login fill read as the Vault', () => {
    expect(isVaultActivityTool('whombat.vault_save')).toBe(true);
    expect(isVaultActivityTool('browser_vault')).toBe(true);
    expect(isVaultActivityTool('whombat.vault_request')).toBe(false);
    expect(isVaultActivityTool('mcp__whombat__vt_abcdefgh__HassTurnOn')).toBe(false);
    expect(isVaultActivityTool('whombat.post_message')).toBe(false);
    expect(cleanVaultToolText('a\u0000b\u202ec\u0007d\t e')).toBe('abcd e');
    expect(cleanVaultToolText('x'.repeat(5000)).endsWith('…')).toBe(true);
  });

  it('hashes a tool’s definition, not its key order', () => {
    const a = vaultToolHash({
      name: 'T',
      description: 'd',
      inputSchema: { type: 'object', properties: { a: {} } },
    });
    const b = vaultToolHash({
      inputSchema: { properties: { a: {} }, type: 'object' },
      description: 'd',
      name: 'T',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(vaultToolHash({ name: 'T', description: 'e' })).not.toBe(
      vaultToolHash({ name: 'T', description: 'd' }),
    );
  });

  it('turns every tool on at the first check, and new or changed tools off with “New” later', () => {
    const listed = [
      { name: 'HassTurnOn', description: 'On' },
      { name: 'HassTurnOff', description: 'Off' },
      { name: 'Bad name', description: 'x' },
    ];
    const first = mergeVaultTools([], listed, true);
    expect(first.tools.map((t) => [t.name, t.enabled, t.isNew])).toEqual([
      ['HassTurnOn', true, false],
      ['HassTurnOff', true, false],
      ['Bad name', true, false],
    ]);
    expect(first.tools[0]).not.toHaveProperty('mcpName');
    const stored = first.tools.map((t) => (t.name === 'HassTurnOff' ? { ...t, enabled: false } : t));
    const later = mergeVaultTools(
      stored,
      [
        { name: 'HassTurnOn', description: 'On, now with areas' },
        { name: 'HassTurnOff', description: 'Off' },
        { name: 'GetLiveContext', description: 'State' },
        { name: 'GetLiveContext', description: 'Duplicate' },
      ],
      false,
    );
    expect(later.tools.map((t) => [t.name, t.enabled, t.isNew])).toEqual([
      ['HassTurnOn', false, true],
      ['HassTurnOff', false, false],
      ['GetLiveContext', false, true],
    ]);
    const many = Array.from({ length: VAULT_TOOLS_MAX + 3 }, (_, i) => ({ name: `t${i}` }));
    const capped = mergeVaultTools([], many, true);
    expect(capped.tools).toHaveLength(VAULT_TOOLS_MAX);
    expect(capped.ignored).toBe(3);
  });
});

describe('copy (VT-51, VT-52, VT-70…VT-72)', () => {
  it('names the kinds in a person’s words, the same for the web and the phone', () => {
    expect(
      VAULT_TEMPLATES.filter((t) => t !== 'secret').map((t) =>
        vaultEntryLabel(
          VAULT_TEMPLATE_DEFS[t].kind === 'http'
            ? { kind: 'http', auth: { type: VAULT_TEMPLATE_DEFS[t].auth ?? 'bearer' } }
            : { kind: VAULT_TEMPLATE_DEFS[t].kind, auth: null },
        ),
      ),
    ).toEqual(['Connection', 'Sign-in key', 'Password', 'Website login', 'Server key']);
    expect(vaultEntryLabel({ kind: 'http', auth: { type: 'header' } })).toBe('Sign-in key');
    expect(vaultTemplateDescription('login', 'Dusty')).toContain('Dusty signs in');
    expect(vaultTemplateDescription('login', 'Dusty')).not.toContain('the agent');
    expect(vaultEntryWhere({ kind: 'mcp', url: 'http://192.168.1.10:8123/api/mcp' })).toBe(
      '192.168.1.10:8123',
    );
    expect(vaultEntryWhere({ kind: 'secret', url: null })).toBeNull();
  });

  it('says why a failing entry’s dot is red, from its last check', () => {
    const failing = (summary: string) => ({ status: 'failing' as const, summary });
    expect(
      vaultEntryProblem({
        kind: 'http',
        auth: { type: 'basic' },
        check: failing(vaultCheckSummary('rejected', { kind: 'http', httpStatus: 401 })),
      }),
    ).toBe('The password stopped working.');
    expect(
      vaultEntryProblem({
        kind: 'http',
        auth: { type: 'bearer' },
        check: failing('The server rejected the secret.'),
      }),
    ).toBe('The sign-in key stopped working.');
    expect(
      vaultEntryProblem({
        kind: 'mcp',
        auth: { type: 'none' },
        check: failing(vaultCheckSummary('unreachable', { kind: 'mcp' })),
      }),
    ).toMatch(/can’t reach it/);
    expect(vaultEntryProblem({ kind: 'ssh', auth: null, check: failing('1 of 3 servers failing') })).toBe(
      'One of its servers isn’t working.',
    );
    // Not failing: nothing to say.
    expect(
      vaultEntryProblem({
        kind: 'http',
        auth: { type: 'bearer' },
        check: { status: 'reached', summary: 'Reached' },
      }),
    ).toBeNull();
  });

  it('writes every audit line neutrally, switching entries on and off (CT-1240)', () => {
    const agentName = 'Nugget';
    for (const kind of VAULT_AUDIT_TEXTS) {
      const text = vaultAuditText(kind, { agentName });
      expect(text, kind).toContain(VAULT_PRIVATE_ENTRY);
      expect(text, kind).not.toMatch(/key to|one turn|Asked to/);
    }
    expect(VAULT_AUDIT_TEXTS).not.toContain('approval.requested');
    expect(vaultAuditText('key.given', { agentName })).toMatch(/^Switched on .* for Nugget$/);
    expect(vaultAuditText('key.taken', { agentName })).toMatch(/^Switched off .* for Nugget$/);
    expect(vaultAuditText('key.changed', { agentName })).toContain('Nugget');
    expect(vaultAuditText('used')).toBe('Used a private Vault entry');
  });

  it('names the entry for its owner only', () => {
    const vault = {
      entryId: 'vlt_ha',
      entryName: 'Home Assistant',
      what: 'HassTurnOn',
      outcome: 'done' as const,
    };
    expect(vaultAuditDetailText({ text: 'Used a private Vault entry', vault })).toBe(
      'Used “Home Assistant” · HassTurnOn · done',
    );
    expect(
      vaultAuditDetailText({
        text: vaultAuditText('key.taken', { agentName: 'Nugget' }),
        vault: { ...vault, what: null, outcome: null },
      }),
    ).toBe('Switched off “Home Assistant” for Nugget');
    expect(
      vaultAuditDetailText({
        text: 'Couldn’t use a private Vault entry',
        vault: { ...vault, what: 'GET /api/states', outcome: 'timed_out' },
      }),
    ).toBe('Couldn’t use “Home Assistant” · GET /api/states · timed out');
    expect(vaultAuditDetailText({ text: 'Used a private Vault entry', vault: null })).toBeNull();
  });

  it('writes the card and detail lines', () => {
    expect(
      vaultEntryMeta(
        {
          kind: 'mcp',
          auth: { type: 'bearer' },
          url: 'http://192.168.1.10:8123/api/mcp',
          agentOn: true,
        },
        'Dusty',
      ),
    ).toBe('Connection · 192.168.1.10:8123 · on for Dusty');
    expect(
      vaultEntryMeta(
        {
          kind: 'http',
          auth: { type: 'basic', username: 'admin' },
          url: 'http://192.168.1.20',
          agentOn: false,
        },
        'Dusty',
      ),
    ).toBe('Password · 192.168.1.20 · off for Dusty');
    expect(
      vaultEntryMeta(
        {
          kind: 'http',
          auth: { type: 'bearer' },
          url: 'https://grafana.example.com',
          agentOn: true,
        },
        'Dusty',
      ),
    ).toBe('Sign-in key · grafana.example.com · on for Dusty');
    expect(vaultEntryMeta({ kind: 'secret', auth: null, url: null, agentOn: false }, 'Dusty')).toBe(
      'Secret · nothing uses it',
    );
    expect(vaultTemplateOf('http', { type: 'query' })).toBe('token');
    expect(vaultCheckSummary('reached', { kind: 'mcp', toolCount: 12 })).toBe('Reached · 12 tools');
    expect(vaultCheckSummary('reached', { kind: 'http', httpStatus: 200 })).toBe('Reached · answered 200');
    expect(vaultCheckSummary('rejected', { kind: 'http', httpStatus: 401 })).toBe(
      'The server rejected the secret (401).',
    );
    expect(vaultCheckSummary('unreachable', { kind: 'mcp' })).toBe('Couldn’t reach it.');
    expect(vaultCheckSummary('timeout', { kind: 'mcp' })).toBe('It didn’t answer within 30 seconds.');
    expect(
      vaultCheckSummary('not_allowed', { kind: 'mcp', reason: 'That address is on your network.' }),
    ).toBe('Not allowed: That address is on your network.');
    expect(
      vaultCheckLine(
        {
          status: 'reached',
          summary: 'Reached · 12 tools',
          checkedAt: '2026-09-23T09:19:00.000Z',
          toolCount: 12,
        },
        NOW,
        TZ,
      ),
    ).toBe('Checked 3 min ago · Reached · 12 tools');
    expect(
      vaultCheckLine({ status: 'unchecked', summary: '', checkedAt: null, toolCount: null }, NOW, TZ),
    ).toBe('Not checked yet');
    expect(
      vaultSecretLine(
        { secret: { set: true, setAt: '2026-09-21T09:00:00.000Z' }, createdAt: '2026-09-01T09:00:00.000Z' },
        NOW,
        TZ,
      ),
    ).toBe('Set · replaced 2 days ago');
    expect(vaultSecretLine({ secret: { set: true, setAt: NOW }, createdAt: NOW }, NOW, TZ)).toBe(
      'Set · added just now',
    );
    expect(vaultSecretLine({ secret: { set: false, setAt: null }, createdAt: NOW }, NOW, TZ)).toBe('Not set');
  });

  it('writes a RECENT USE row: a turn of the person’s the entry reached the agent in (CT-1244)', () => {
    const names = (id: string) =>
      ({ prn_neo: { shortName: 'Neo' }, prn_mara: { shortName: 'Mara' } })[id] as { shortName: string };
    const use = {
      id: 'vlu_1',
      entryId: 'vlt_ha',
      agentId: 'prn_neo',
      requesterId: 'prn_mara',
      dispatchId: null,
      what: vaultTurnUseWhat('mcp', 'Neo'),
      outcome: 'done' as const,
      at: '2026-09-23T08:48:00.000Z',
      eventId: null,
    };
    const row = vaultUseRow(use, { names, now: NOW, timeZone: TZ });
    expect(row).toMatchObject({ agent: 'Neo', when: '10:48', outcome: 'done' });
    expect(row).not.toHaveProperty('forWhom');
    expect(row.line.split(' · ')).toHaveLength(4);
    expect(vaultUseRow({ ...use, outcome: 'refused' }, { names, now: NOW, timeZone: TZ }).outcome).toBe(
      'refused',
    );
  });
});

describe('entry shapes (VT-02, VT-03)', () => {
  it('accepts each template', () => {
    expect(
      vaultEntryShapeProblems({
        kind: 'mcp',
        url: 'http://192.168.1.10:8123/api/mcp',
        auth: { type: 'bearer' },
        secret: 'tok',
      }),
    ).toEqual([]);
    expect(
      vaultEntryShapeProblems({
        kind: 'mcp',
        url: 'http://192.168.1.10:8123/api/mcp',
        auth: { type: 'none' },
      }),
    ).toEqual([]);
    expect(
      vaultEntryShapeProblems({
        kind: 'http',
        url: 'http://192.168.1.20',
        auth: { type: 'basic', username: 'admin' },
        secret: 'pw',
      }),
    ).toEqual([]);
    // An existing `secret` entry changes only its name and description; none is made since 0.113 (CT-823).
    expect(vaultEntryShapeProblems({ kind: 'secret' }, 'update')).toEqual([]);
    expect(vaultEntryShapeProblems({ kind: 'secret', secret: 'value' }).map((p) => p.field)).toEqual([
      'kind',
    ]);
  });

  it('refuses what doesn’t fit the kind', () => {
    const fields = (e: Parameters<typeof vaultEntryShapeProblems>[0], mode?: 'create' | 'update') =>
      vaultEntryShapeProblems(e, mode).map((p) => p.field);
    expect(fields({ kind: 'secret', url: 'https://x', auth: { type: 'bearer' } })).toEqual([
      'kind',
      'url',
      'auth',
    ]);
    expect(fields({ kind: 'http', url: 'https://x.example', auth: { type: 'none' } })).toEqual(['auth']);
    expect(fields({ kind: 'http' })).toEqual(['url', 'auth']);
    expect(fields({ kind: 'mcp', url: 'ftp://x', auth: { type: 'bearer' }, secret: 's' })).toEqual(['url']);
    expect(fields({ kind: 'mcp', url: 'https://x.example', auth: { type: 'none' }, secret: 's' })).toEqual([
      'secret',
    ]);
    expect(
      fields({ kind: 'http', url: 'https://x.example', auth: { type: 'bearer' }, secret: 'a\r\nb' }),
    ).toEqual(['secret']);
    expect(fields({ kind: 'http', url: 'https://x.example', auth: { type: 'bearer' } }, 'update')).toEqual(
      [],
    );
  });

  it('validates how an entry signs in', () => {
    expect(VaultAuth.safeParse({ type: 'header', name: 'X-API-Key' }).success).toBe(true);
    for (const name of [
      'Host',
      'cookie',
      'Content-Length',
      'Transfer-Encoding',
      'Connection',
      'Proxy-Authorization',
      'bad name',
      '',
    ])
      expect(VaultAuth.safeParse({ type: 'header', name }).success, name).toBe(false);
    expect(VaultAuth.safeParse({ type: 'basic', username: 'a:b' }).success).toBe(false);
    expect(VaultAuth.safeParse({ type: 'query', name: 'api_key' }).success).toBe(true);
    expect(VaultAuth.safeParse({ type: 'query', name: 'a&b' }).success).toBe(false);
    expect(VaultAuth.safeParse({ type: 'oauth' }).success).toBe(false);
  });

  it('parses an owner’s detail view', () => {
    const detail = VaultEntryDetail.parse({
      id: 'vlt_ha',
      name: 'Home Assistant',
      description: 'Lights and heating at home.',
      kind: 'mcp',
      url: 'http://192.168.1.10:8123/api/mcp',
      auth: { type: 'bearer' },
      secret: { set: true, setAt: NOW },
      check: { status: 'reached', summary: 'Reached · 5 tools', checkedAt: NOW, toolCount: 5 },
      agentOn: false,
      lastUsedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      tools: [],
      key: null,
      recentUses: [],
    });
    expect(detail).not.toHaveProperty('packCount');
    expect(detail.toolsIgnored).toBe(0);
  });
});

describe('website logins (VT-D28…VT-D30; since 0.125 in Hermes’s credential vault, CT-1240)', () => {
  const login = {
    kind: 'login' as const,
    url: 'https://shop.example.com/admin/login',
    auth: { type: 'form' as const, username: 'mara@example.com' },
    secret: 'correct horse',
  };

  it('offers the templates, and Basic auth is the old http + basic Login (VT-D29; SSH key since 0.32.0)', () => {
    expect(VAULT_TEMPLATES).toEqual(['mcp', 'token', 'basic', 'login', 'ssh', 'secret']);
    // Add to Vault offers neither `secret` (CT-823) nor `mcp`, which Connections has (VLT-30).
    expect(VAULT_NEW_TEMPLATES).toEqual(['token', 'basic', 'login', 'ssh']);
    expect(VAULT_TEMPLATE_DEFS.secret.label).toBe('Secret');
    for (const def of Object.values(VAULT_TEMPLATE_DEFS))
      expect(def.label + def.description).not.toMatch(/pack/i);
    expect(VAULT_ENTRY_KINDS).toEqual(['mcp', 'http', 'login', 'ssh', 'secret']);
    expect(VAULT_TEMPLATE_DEFS.basic).toEqual({
      kind: 'http',
      label: 'Password',
      description: 'A username and password for an app or device the agent talks to.',
      auth: 'basic',
    });
    expect(VAULT_TEMPLATE_DEFS.login).toMatchObject({ kind: 'login', label: 'Website login', auth: 'form' });
    expect(VAULT_TEMPLATE_DEFS.login.description).toContain('signs in to in its browser');
    expect(vaultTemplateOf('http', { type: 'basic' })).toBe('basic');
    expect(vaultTemplateOf('login', { type: 'form' })).toBe('login');
    expect(vaultTemplateOf('login', null)).toBe('login');
    for (const template of VAULT_TEMPLATES) {
      const def = VAULT_TEMPLATE_DEFS[template];
      expect(vaultTemplateOf(def.kind, def.auth ? { type: def.auth } : null)).toBe(template);
    }
  });

  it('signs in with a form: a username, no selectors (Hermes finds the fields)', () => {
    expect(
      VaultAuth.parse({ type: 'form', username: 'mara@example.com', usernameSelector: '#email' }),
    ).toEqual({ type: 'form', username: 'mara@example.com' });
    expect(VaultAuth.safeParse({ type: 'form', username: 'mara' }).success).toBe(true);
    expect(VaultAuth.safeParse({ type: 'form' }).success).toBe(false);
    expect(VaultAuth.safeParse({ type: 'form', username: 'a:b' }).success).toBe(false);
    expect(VaultAuth.safeParse({ type: 'form', username: 'a\nb' }).success).toBe(false);
  });

  it('accepts a login with its sign-in page, form and password; refuses anything else', () => {
    const fields = (e: Parameters<typeof vaultEntryShapeProblems>[0], mode?: 'create' | 'update') =>
      vaultEntryShapeProblems(e, mode).map((p) => p.field);
    expect(vaultEntryShapeProblems(login)).toEqual([]);
    expect(fields({ ...login, url: 'http://192.168.1.30/login' })).toEqual([]);
    expect(fields({ ...login, url: undefined })).toEqual(['url']);
    expect(fields({ ...login, url: 'https://shop.example.com/login?next=/' })).toEqual(['url']);
    expect(fields({ ...login, url: 'ftp://shop.example.com' })).toEqual(['url']);
    expect(fields({ ...login, auth: undefined })).toEqual(['auth']);
    expect(fields({ ...login, auth: { type: 'basic', username: 'mara' } })).toEqual(['auth']);
    expect(fields({ ...login, auth: { type: 'bearer' } })).toEqual(['auth']);
    expect(fields({ ...login, auth: { type: 'none' } })).toEqual(['auth']);
    expect(vaultEntryShapeProblems({ ...login, secret: undefined })).toEqual([
      { field: 'secret', message: 'Paste the password.' },
    ]);
    expect(fields({ ...login, secret: undefined }, 'update')).toEqual([]);
    expect(vaultEntryShapeProblems({ ...login, secret: 'two\nlines' })).toEqual([
      { field: 'secret', message: 'A password can’t hold line breaks or control characters.' },
    ]);
    expect(fields({ ...login, secret: 'tab\tinside' })).toEqual([]);
    // `form` belongs to `login` alone.
    for (const kind of ['mcp', 'http'] as const) expect(fields({ ...login, kind }), kind).toEqual(['auth']);
    expect(fields({ kind: 'secret', auth: login.auth, secret: 'x' })).toEqual(['kind', 'auth']);
  });

  it('never sends a login as a request credential', () => {
    expect(() => vaultCredential({ type: 'form', username: 'mara' }, 'pw')).toThrow(/sign-in page/);
  });

  it('keeps a reserved, unset one-time-code slot on every entry (VT-D28)', () => {
    const entry = VaultEntry.parse({
      id: 'vlt_shop',
      name: 'Shop admin',
      description: '',
      kind: 'login',
      url: login.url,
      auth: login.auth,
      secret: { set: true, setAt: NOW },
      check: { status: 'unchecked', summary: '', checkedAt: null },
      agentOn: false,
      lastUsedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(entry.totp).toEqual({ set: false, setAt: null });
    // Only an `mcp` entry Whombat couldn't move to Connections says so (VLT-30).
    expect(entry.moveToConnections).toBe(false);
    expect(entry.totp).not.toBe(VAULT_TOTP_UNSET);
    expect(Object.isFrozen(VAULT_TOTP_UNSET)).toBe(true);
  });

  it('writes a login’s card line', () => {
    expect(vaultEntryMeta({ kind: 'login', auth: login.auth, url: login.url, agentOn: true }, 'Dusty')).toBe(
      'Website login · shop.example.com · on for Dusty',
    );
    expect(vaultEntryLabel({ kind: 'login', auth: login.auth })).toBe('Website login');
  });

  it('has no Test sign-in and no blocked check (CT-1235)', () => {
    expect(VAULT_CHECK_OUTCOMES).not.toContain('blocked');
    expect(vaultCheckSummary('bad_answer', { kind: 'mcp' })).toContain('MCP server');
  });
});
