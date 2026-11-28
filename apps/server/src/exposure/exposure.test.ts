/**
 * Open to the internet (docs/decisions/internet-exposure.md): what each place's settings say is open, the words,
 * links and highlights of an opening, the silent first list and the line of a new opening. Pure.
 */
import { createHash } from 'node:crypto';
import { EXPOSURE_NEW_CHECK, ExposureOpening, isPublicName } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { localizePhrase } from '../i18n/phrases';
import { NPM_PROXY_HOSTS, NPM_STREAMS } from '../things/kinds/infra/fixtures/nginx-proxy-manager';
import { type NpmSnapshot, parseProxyHosts, parseStreams } from '../things/kinds/infra/nginx-proxy-manager';
import { checkStartsOn } from '../things/quiet/defaults';
import '../things/kinds/index';
import {
  baselineStep,
  FIRST_LIST,
  FORGET_AFTER_MS,
  firstListOf,
  type KeptRow,
  type SeenOpening,
} from './baseline';
import { EXPOSURE_NEW } from './check';
import { newOpeningNotice, newOpeningNotices } from './lines';
import {
  buildOpening,
  type Links,
  linkOf,
  NEW_FOR_MS,
  NO_LINKS,
  type OpeningCtx,
  openingId,
  riskOf,
  sortOpenings,
} from './openings';
import {
  accessGuards,
  funnelAllowed,
  hostPort,
  npmOpenings,
  opnsenseUpnp,
  parseAccessDomains,
  parseDnat,
  parseTunnelConfig,
  parseUnifiForwards,
  type RawOpening,
  tunnelOpenings,
  unifiSiteName,
  unifiUpnp,
} from './parse';
import { DNAT_PAGE, dnatRules, unifiLegacyBase } from './read';
import { sourceOf, summaryOf } from './view';

const NOW = new Date('2026-11-28T10:00:00Z');

const npm: NpmSnapshot = {
  readAt: NOW,
  version: '2.16.0',
  sites: parseProxyHosts(NPM_PROXY_HOSTS),
  streams: 1,
  dead: 0,
  streamList: parseStreams(NPM_STREAMS),
};

const ctx = (over: Partial<OpeningCtx> = {}): OpeningCtx => ({
  locale: 'en-GB',
  now: NOW,
  timeZone: 'Europe/Amsterdam',
  source: {
    kind: 'nginx_proxy_manager',
    id: 'con_npm',
    name: 'Nginx Proxy Manager',
    manageUrl: 'http://10.100.0.2:81/',
  },
  links: NO_LINKS,
  meant: new Set(),
  kept: new Map(),
  ...over,
});

const raw = (over: Partial<RawOpening> = {}): RawOpening => ({
  how: 'proxy',
  part: 'proxy',
  address: 'photos.example.com',
  target: 'http://10.100.0.20:2283',
  targetHost: '10.100.0.20',
  targetPort: 2283,
  https: 'yes',
  guard: 'none',
  ...over,
});

describe('what counts as open', () => {
  it('takes public names only', () => {
    expect(isPublicName('photos.example.com')).toBe(true);
    expect(isPublicName('*.example.com')).toBe(true);
    expect(isPublicName('nas.local')).toBe(false);
    expect(isPublicName('router.home.arpa')).toBe(false);
    expect(isPublicName('10.100.0.20')).toBe(false);
    expect(isPublicName('box.tail1234.ts.net')).toBe(false);
    expect(isPublicName('localhost')).toBe(false);
  });

  it('reads a target’s host and port', () => {
    expect(hostPort('http://10.100.0.20:8080')).toEqual({ host: '10.100.0.20', port: 8080 });
    expect(hostPort('https://nas.lan')).toEqual({ host: 'nas.lan', port: 443 });
    expect(hostPort('10.100.0.30:22')).toEqual({ host: '10.100.0.30', port: 22 });
    expect(hostPort('')).toEqual({ host: null, port: null });
  });
});

describe('Nginx Proxy Manager', () => {
  it('opens switched-on proxy hosts with a public name and its streams', () => {
    const read = npmOpenings(npm);
    expect(read.complete).toBe(true);
    expect(read.openings.map((o) => [o.how, o.address, o.https])).toEqual([
      ['proxy', 'app.example.com', 'yes'],
      ['proxy', 'broken.example.com', 'no'],
      ['stream', '2222', 'unknown'],
    ]);
    expect(read.openings[2]).toMatchObject({ targetHost: '192.168.1.30', targetPort: 22, protocol: 'TCP' });
  });

  it('reads an access list and forced HTTPS', () => {
    const [site] = parseProxyHosts([
      { ...NPM_PROXY_HOSTS[0], access_list_id: 3, access_list: { id: 3, name: 'Family' }, ssl_forced: 1 },
    ]);
    expect(site).toMatchObject({ access: { id: 3, name: 'Family' }, sslForced: true });
    expect(npmOpenings({ ...npm, sites: site ? [site] : [] }).openings[0]).toMatchObject({
      guard: 'access_list',
      guardName: 'Family',
    });
  });

  it('says when its streams couldn’t be read', () => {
    const read = npmOpenings({ ...npm, streamList: undefined });
    expect(read.complete).toBe(false);
    expect(read.blind).toEqual([{ code: 'streams_unread' }]);
    // Its proxy hosts are still a list read whole; the streams aren't a list read at all.
    expect(read.parts).toEqual([{ key: 'proxy', whole: true }]);
    expect(npmOpenings(npm).parts.map((p) => p.key)).toEqual(['proxy', 'stream']);
  });

  it('is a proxy host with all its public names: a name added is new, their order isn’t', () => {
    const [site] = parseProxyHosts([NPM_PROXY_HOSTS[0]]);
    if (!site) throw new Error('fixture');
    const id = (domains: string[]) => {
      const [o] = npmOpenings({ ...npm, sites: [{ ...site, domains }] }).openings;
      return o ? openingId('con_npm', o) : null;
    };
    expect(id(['a.example.com', 'B.example.com'])).toBe(id(['b.example.com', 'a.example.com']));
    expect(id(['a.example.com', 'b.example.com'])).not.toBe(id(['a.example.com']));
    expect(id(['a.example.com', 'b.example.com'])).not.toBe(
      id(['a.example.com', 'b.example.com', 'c.example.com']),
    );
    // A name only the house knows isn't part of it.
    expect(id(['a.example.com', 'nas.lan'])).toBe(id(['a.example.com']));
    // One public name keeps the id it always had, so what the person said is meant stays meant.
    const [one] = npmOpenings({ ...npm, sites: [{ ...site, domains: ['a.example.com'] }] }).openings;
    const before = (o: RawOpening) =>
      `op_${createHash('sha256')
        .update(['con_npm', o.how, o.address.toLowerCase(), (o.target ?? '').toLowerCase()].join('\n'))
        .digest('hex')
        .slice(0, 20)}`;
    if (!one) throw new Error('fixture');
    expect(openingId('con_npm', one)).toBe(before(one));
  });
});

describe('Cloudflare', () => {
  const config = {
    result: {
      source: 'cloudflare',
      config: {
        ingress: [
          { hostname: 'ha.example.com', service: 'http://10.100.0.10:8123' },
          { hostname: 'pve.example.com', service: 'https://10.100.0.5:8006' },
          { hostname: 'inside.local', service: 'http://10.100.0.9' },
          { service: 'http_status:404' },
        ],
      },
    },
  };

  it('reads a tunnel’s public hostnames and leaves the catch-all out', () => {
    expect(parseTunnelConfig(config)?.map((r) => r.hostname)).toEqual([
      'ha.example.com',
      'pve.example.com',
      'inside.local',
    ]);
    expect(parseTunnelConfig({ result: { source: 'local', config: null } })).toBeNull();
  });

  const signIn = [{ decision: 'allow', include: [{ email: { email: 'mara@example.com' } }] }];
  const tunnel = { id: 'tun-1', name: 'home' };

  it('guards names with Cloudflare Access when an app covers them', () => {
    const domains = parseAccessDomains({
      result: [
        { type: 'self_hosted', domain: 'pve.example.com', policies: signIn },
        { type: 'self_hosted', domain: 'x.example.com/admin', policies: signIn },
        {
          type: 'self_hosted',
          destinations: [{ type: 'public', uri: '*.apps.example.com' }],
          policies: signIn,
        },
        { type: 'bookmark', domain: 'ha.example.com', policies: signIn },
      ],
    });
    expect(accessGuards(domains, 'pve.example.com')).toBe('guarded');
    expect(accessGuards(domains, 'x.example.com')).toBeNull();
    expect(accessGuards(domains, 'a.apps.example.com')).toBe('guarded');
    expect(accessGuards(domains, 'ha.example.com')).toBeNull();
    const routes = parseTunnelConfig(config) ?? [];
    expect(tunnelOpenings(tunnel, routes, domains).map((o) => [o.address, o.guard, o.part])).toEqual([
      ['ha.example.com', 'none', 'tunnel:tun-1'],
      ['pve.example.com', 'cloudflare_access', 'tunnel:tun-1'],
    ]);
    expect(tunnelOpenings(tunnel, routes, null)[0]?.guard).toBe('unknown');
  });

  it('never calls a name guarded when Access lets people through without a sign-in, or can’t say', () => {
    const app = (domain: string, policies?: unknown[]) => ({
      type: 'self_hosted',
      domain,
      ...(policies ? { policies } : {}),
    });
    const domains = parseAccessDomains({
      result: [
        app('bypass.example.com', [{ decision: 'bypass', include: [{ everyone: {} }] }]),
        app('home.example.com', [
          { decision: 'bypass', include: [{ ip: { ip: '203.0.113.0/24' } }] },
          ...signIn,
        ]),
        app('anyone.example.com', [{ decision: 'allow', include: [{ everyone: {} }] }]),
        app('unread.example.com'),
        app('nobody.example.com', []),
        app('blocked.example.com', [{ decision: 'deny', include: [{ everyone: {} }] }, ...signIn]),
        // A wildcard that lets everyone in, and the name's own app that asks for a sign-in: the name's own counts.
        app('*.wild.example.com', [{ decision: 'bypass', include: [{ everyone: {} }] }]),
        app('own.wild.example.com', signIn),
      ],
    });
    const guard = (name: string) =>
      tunnelOpenings(tunnel, [{ hostname: name, service: 'http://10.100.0.10:80', path: null }], domains)[0]
        ?.guard;
    expect(guard('bypass.example.com')).toBe('none');
    expect(guard('home.example.com')).toBe('unknown');
    expect(guard('anyone.example.com')).toBe('unknown');
    expect(guard('unread.example.com')).toBe('unknown');
    expect(guard('nobody.example.com')).toBe('cloudflare_access');
    expect(guard('blocked.example.com')).toBe('cloudflare_access');
    expect(guard('other.wild.example.com')).toBe('none');
    expect(guard('own.wild.example.com')).toBe('cloudflare_access');
  });

  it('can’t tell what guards a name when an app on one of its paths isn’t plainly guarded', () => {
    const app = (domain: string, policies: unknown[]) => ({ type: 'self_hosted', domain, policies });
    const bypass = [{ decision: 'bypass', include: [{ everyone: {} }] }];
    const domains = parseAccessDomains({
      result: [
        app('cloud.example.com', signIn),
        app('cloud.example.com/api', bypass),
        app('nas.example.com', signIn),
        app('nas.example.com/admin', signIn),
        app('*.lab.example.com', signIn),
        app('*.lab.example.com/public', [{ decision: 'allow', include: [{ everyone: {} }] }]),
        app('open.example.com/api', bypass),
      ],
    });
    const guard = (name: string) =>
      tunnelOpenings(tunnel, [{ hostname: name, service: 'http://10.100.0.10:80', path: null }], domains)[0]
        ?.guard;
    expect(guard('cloud.example.com')).toBe('unknown');
    expect(guard('nas.example.com')).toBe('cloudflare_access');
    expect(guard('pve.lab.example.com')).toBe('unknown');
    // A path's app alone guards nothing of the name.
    expect(guard('open.example.com')).toBe('none');
  });
});

describe('routers', () => {
  it('reads OPNsense’s port forwards on WAN only, switched on and redirecting', () => {
    const rows = parseDnat({
      rows: [
        {
          interface: 'wan',
          protocol: 'TCP',
          'destination.port': '32400',
          target: '10.100.0.40',
          'local-port': '32400',
          'source.network': 'any',
          descr: 'Plex',
        },
        { interface: 'lan', protocol: 'UDP', 'destination.port': '53', target: '10.100.0.3' },
        { interface: 'wan', disabled: '1', 'destination.port': '22', target: '10.100.0.5' },
        { interface: 'wan', nordr: '1', 'destination.port': '80', target: '10.100.0.5' },
        {
          interface: 'wan',
          protocol: 'TCP',
          destination: { port: '3389' },
          target: '10.100.0.50',
          source: { network: '203.0.113.0/24' },
        },
      ],
    });
    expect(rows.openings.map((o) => [o.address, o.target, o.guard, o.label])).toEqual([
      ['32400', '10.100.0.40:32400', 'none', 'Plex'],
      ['3389', '10.100.0.50:3389', 'some_addresses', undefined],
    ]);
    expect(rows.blind).toEqual([]);
    expect(opnsenseUpnp([{ id: 'miniupnpd', running: true }])).toBe(true);
    expect(opnsenseUpnp([{ id: 'unbound', running: true }])).toBe(false);
    expect(opnsenseUpnp(null)).toBeNull();
  });

  it('reads OPNsense’s named ports, and says which WAN forwards it can’t read instead of dropping them', () => {
    const read = parseDnat({
      rows: [
        { interface: 'wan', protocol: 'TCP', 'destination.port': 'https', target: '10.100.0.2' },
        {
          interface: 'wan',
          protocol: 'TCP',
          'destination.port': 'http',
          target: '10.100.0.2',
          'local-port': 'http-alt',
        },
        { interface: 'wan', 'destination.port': 'GamePorts', target: '10.100.0.9', descr: 'Games' },
        { interface: 'lan', 'destination.port': 'LanAlias', target: '10.100.0.9' },
      ],
    });
    expect(read.openings.map((o) => [o.port, o.targetPort])).toEqual([
      [443, 443],
      [80, 8080],
    ]);
    expect(read.blind).toEqual([{ code: 'forwards_unread', count: 1, names: 'Games' }]);
  });

  it('reads every page of OPNsense’s rules, and marks a read that couldn’t take them all as partial', async () => {
    const rule = { interface: 'wan', 'destination.port': '443', target: '10.100.0.2' };
    const pages = (total: number) => async (n: number) => ({
      total,
      rows: Array.from({ length: Math.max(0, Math.min(DNAT_PAGE, total - (n - 1) * DNAT_PAGE)) }, () => rule),
    });
    const two = await dnatRules(pages(DNAT_PAGE + 3));
    expect([two.rows.length, two.partial]).toEqual([DNAT_PAGE + 3, false]);
    const huge = await dnatRules(pages(20_000));
    expect(huge.partial).toBe(true);
    // An answer without a total: a page that isn't full is the last.
    const asked: number[] = [];
    const untold = await dnatRules(async (n) => {
      asked.push(n);
      return { rows: n === 1 ? Array.from({ length: DNAT_PAGE }, () => rule) : [rule] };
    });
    expect([untold.rows.length, untold.partial, asked]).toEqual([DNAT_PAGE + 1, false, [1, 2]]);
  });

  it('reads UniFi’s port forwards, its UPnP switch and its site', () => {
    const rows = parseUnifiForwards({
      data: [
        {
          name: 'Plex',
          enabled: true,
          dst_port: '32400',
          fwd: '10.100.0.40',
          fwd_port: '32400',
          proto: 'tcp',
          src: 'any',
        },
        {
          name: 'Off',
          enabled: false,
          dst_port: '80',
          fwd: '10.100.0.41',
          fwd_port: '80',
          proto: 'tcp_udp',
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ address: '32400', protocol: 'TCP', label: 'Plex', guard: 'none' });
    expect(unifiUpnp({ data: [{ key: 'mgmt' }, { key: 'usg', upnp_enabled: true }] })).toBe(true);
    expect(unifiUpnp({ data: [{ key: 'usg' }] })).toBeNull();
    expect(unifiSiteName({ data: [{ id: 'uuid', internalReference: 'default' }] })).toBe('default');
    expect(unifiLegacyBase({ baseUrl: 'https://10.100.0.1/proxy/network/integration' })).toBe(
      'https://10.100.0.1/proxy/network/api',
    );
  });

  it('reads who may use Tailscale Funnel', () => {
    expect(
      funnelAllowed({
        nodeAttrs: [
          { target: ['autogroup:member'], attr: ['funnel'] },
          { target: ['tag:x'], attr: ['y'] },
        ],
      }),
    ).toEqual(['autogroup:member']);
    expect(funnelAllowed({ acls: [] })).toEqual([]);
  });
});

describe('an opening in words', () => {
  const links: Links = {
    connections: new Map([
      [
        '10.100.0.20:2283',
        {
          thing: 'connection:con_immich',
          name: 'Immich',
          href: '/things/connection%3Acon_immich',
          kind: 'immich',
          machine: 'nas-01',
        },
      ],
      [
        '10.100.0.5:8006',
        {
          thing: 'connection:con_pve',
          name: 'Proxmox',
          href: '/things/connection%3Acon_pve',
          kind: 'proxmox',
        },
      ],
    ]),
    machines: new Map([
      ['10.100.0.40', { thing: 'server:media-01', name: 'media-01', href: '/things/server%3Amedia-01' }],
    ]),
  };

  it('names what it leads to and where it comes from, with a stable id', () => {
    const o = buildOpening(raw(), ctx({ links }));
    expect(ExposureOpening.parse(o)).toEqual(o);
    expect(o.title).toContain('Immich on nas-01');
    expect(o.leadsTo?.thing).toBe('connection:con_immich');
    expect(o.via).toContain('Nginx Proxy Manager');
    expect(o.risk).toBeUndefined();
    expect(o.id).toBe(openingId('con_npm', raw()));
    expect(o.id).not.toBe(openingId('con_npm', raw({ target: 'http://10.100.0.21:2283' })));
    expect(o.watch).toMatchObject({
      thing: 'connection:con_npm',
      check: EXPOSURE_NEW_CHECK,
      subject: { id: `open:${o.id}` },
    });
    const port = buildOpening(
      raw({
        how: 'port_forward',
        address: '32400',
        port: 32400,
        targetHost: '10.100.0.40',
        targetPort: 32400,
        protocol: 'TCP',
      }),
      ctx({ links, source: { kind: 'unifi_network', id: 'con_u', name: 'UniFi', manageUrl: null } }),
    );
    expect(port.address).toBe('Port 32400');
    expect(port.leadsTo?.name).toBe('media-01');
    expect(port.manage).toBeUndefined();
  });

  it('says it in Dutch', () => {
    const o = buildOpening(raw(), ctx({ links, locale: 'nl-NL' }));
    expect(o.title).toContain('Immich op nas-01');
    expect(o.via).toContain('Via');
  });

  it('highlights only what is certain, one at a time', () => {
    const c = ctx({ links });
    expect(
      riskOf(raw({ targetHost: '10.100.0.5', targetPort: 8006 }), linkOf(links, '10.100.0.5', 8006), c)?.kind,
    ).toBe('admin_open');
    expect(
      riskOf(raw({ targetHost: '10.100.0.5', targetPort: 8006, guard: 'cloudflare_access' }), null, c),
    ).toBeNull();
    expect(riskOf(raw({ how: 'port_forward', port: 3389, targetPort: 3389 }), null, c)?.kind).toBe(
      'admin_open',
    );
    expect(riskOf(raw({ https: 'no' }), null, c)?.kind).toBe('no_https');
    expect(riskOf(raw({ certificateExpires: new Date('2026-11-01T00:00:00Z') }), null, c)?.kind).toBe(
      'certificate_expired',
    );
    expect(riskOf(raw({ how: 'tunnel', https: 'yes' }), null, c)).toBeNull();
    // Meant: no highlight.
    const id = openingId('con_npm', raw({ https: 'no' }));
    expect(buildOpening(raw({ https: 'no' }), ctx({ meant: new Set([`open:${id}`]) })).risk).toBeUndefined();
  });

  it('is new only after the first list, until it’s meant', () => {
    const id = openingId('con_npm', raw());
    const kept = (baseline: boolean) => new Map([[id, { firstSeen: NOW, baseline }]]);
    expect(buildOpening(raw(), ctx({ kept: kept(true) })).isNew).toBe(false);
    expect(buildOpening(raw(), ctx({ kept: kept(false) })).isNew).toBe(true);
    expect(buildOpening(raw(), ctx({ kept: kept(false), meant: new Set([`open:${id}`]) })).isNew).toBe(false);
  });

  it('is new for two weeks after it opened, then known', () => {
    const id = openingId('con_npm', raw());
    const seen = (ago: number) =>
      new Map([[id, { firstSeen: new Date(NOW.getTime() - ago), baseline: false }]]);
    expect(buildOpening(raw(), ctx({ kept: seen(NEW_FOR_MS - 60_000) })).isNew).toBe(true);
    expect(buildOpening(raw(), ctx({ kept: seen(NEW_FOR_MS) })).isNew).toBe(false);
    expect(newOpeningNotices('con_npm', [raw()], seen(NEW_FOR_MS - 60_000), NO_LINKS, NOW)).toHaveLength(1);
    expect(newOpeningNotices('con_npm', [raw()], seen(NEW_FOR_MS + 1), NO_LINKS, NOW)).toEqual([]);
  });

  it('puts what is worth a look and new first, and sums up', () => {
    const a = buildOpening(raw({ address: 'a.example.com' }), ctx());
    const b = buildOpening(raw({ address: 'b.example.com', https: 'no' }), ctx());
    expect(sortOpenings([a, b]).map((o) => o.address)).toEqual(['b.example.com', 'a.example.com']);
    expect(summaryOf([a, b], 'en-GB')).toMatch(/2 openings · 1 worth a look/);
    expect(summaryOf([], 'en-GB')).toMatch(/Nothing/);
  });
});

describe('the places Whombat looked', () => {
  const row = { id: 'con_u', label: 'UniFi', catalogId: 'unifi_network' };
  it('says what it couldn’t see', () => {
    expect(sourceOf(row, { ok: false }, 0, 'en-GB').state).toBe('unread');
    const upnp = sourceOf(
      row,
      { ok: true, value: { openings: [], parts: [], complete: true, blind: [{ code: 'upnp_on' }] } },
      2,
      'en-GB',
    );
    expect(upnp.state).toBe('partly');
    expect(upnp.words).toMatch(/^2 openings\. UPnP/);
    // A read that missed part of a place never says nothing is open there.
    const opn = { id: 'con_o', label: 'OPNsense', catalogId: 'opnsense' };
    const partial = sourceOf(
      opn,
      {
        ok: true,
        value: { openings: [], parts: [], complete: false, blind: [{ code: 'forwards_partial' }] },
      },
      0,
      'en-GB',
    );
    expect(partial.state).toBe('partly');
    expect(partial.words).not.toMatch(/^Nothing open\./);
    expect(
      sourceOf(opn, { ok: true, value: { openings: [], parts: [], complete: true, blind: [] } }, 0, 'en-GB')
        .words,
    ).toBe('Nothing open');
    const alias = sourceOf(
      opn,
      {
        ok: true,
        value: {
          openings: [],
          parts: [],
          complete: true,
          blind: [{ code: 'forwards_unread', count: 2, names: 'Games, VPN' }],
        },
      },
      0,
      'nl-NL',
    );
    expect(alias.words).toContain('Games, VPN');
    expect(alias.words).toContain('alias');
    const ts = { id: 'con_t', label: 'Tailscale', catalogId: 'tailscale' };
    expect(
      sourceOf(ts, { ok: true, value: { openings: [], parts: [], complete: true, blind: [] } }, 0, 'en-GB'),
    ).toMatchObject({
      state: 'read',
    });
    expect(
      sourceOf(
        ts,
        {
          ok: true,
          value: {
            openings: [],
            parts: [],
            complete: true,
            blind: [{ code: 'funnel_allowed', who: 'autogroup:member' }],
          },
        },
        0,
        'en-GB',
      ).words,
    ).toContain('autogroup:member');
  });
});

describe('the first list and what is new', () => {
  const row = (openingId: string, over: Partial<KeptRow> = {}): KeptRow => ({
    openingId,
    firstSeen: new Date(NOW.getTime() - 86_400_000),
    lastSeen: new Date(NOW.getTime() - 86_400_000),
    baseline: true,
    ...over,
  });
  const seen = (part: string, ...ids: string[]): SeenOpening[] => ids.map((id) => ({ id, part }));
  const proxies = { key: 'proxy', whole: true };
  const streams = { key: 'stream', whole: true };
  const listed = (...parts: string[]) => parts.map((p) => row(firstListOf(p)));

  it('keeps the first whole read of each list silently', () => {
    const step = baselineStep([], seen('proxy', 'a', 'b'), [proxies, streams], true, NOW);
    expect(step.write.map((r) => [r.openingId, r.baseline])).toEqual([
      ['a', true],
      ['b', true],
      [firstListOf('proxy'), true],
      [firstListOf('stream'), true],
    ]);
    expect([...step.kept.values()].every((k) => k.baseline)).toBe(true);
  });

  it('keeps adding silently to a list read only in part', () => {
    const step = baselineStep(
      [row('a')],
      seen('port_forward', 'a', 'b'),
      [{ key: 'port_forward', whole: false }],
      false,
      NOW,
    );
    expect(step.write.find((r) => r.openingId === 'b')?.baseline).toBe(true);
    expect(step.write.some((r) => r.openingId.startsWith(FIRST_LIST))).toBe(false);
  });

  it('tells what is new in a list it can read, while another list of the place is never read', () => {
    // Streams Whombat may not read: the proxy hosts' list is kept all the same, and a host added after it is new.
    const first = baselineStep([], seen('proxy', 'a'), [proxies], false, NOW);
    expect(first.write.map((r) => r.openingId)).toContain(firstListOf('proxy'));
    const later = baselineStep(
      [row('a'), ...listed('proxy')],
      seen('proxy', 'a', 'c'),
      [proxies],
      false,
      NOW,
    );
    expect(later.kept.get('c')).toEqual({ firstSeen: NOW, baseline: false });
  });

  it('makes a tunnel set up after the list of tunnels was kept new, but not one whose routes came late', () => {
    const tunnels = { key: 'tunnels', whole: true };
    const t1 = { key: 'tunnel:1', whole: true, within: 'tunnels' };
    const t2 = { key: 'tunnel:2', whole: true, within: 'tunnels' };
    const after = baselineStep(
      listed('tunnels', 'tunnel:1'),
      seen('tunnel:2', 'x'),
      [tunnels, t1, t2],
      true,
      NOW,
    );
    expect(after.kept.get('x')?.baseline).toBe(false);
    // More tunnels than one read takes: the list is never kept, each tunnel's routes are, one by one.
    const many = { key: 'tunnels', whole: false };
    const late = baselineStep(listed('tunnel:1'), seen('tunnel:2', 'y'), [many, t1, t2], false, NOW);
    expect(late.kept.get('y')?.baseline).toBe(true);
    const known = baselineStep(listed('tunnel:1'), seen('tunnel:1', 'z'), [many, t1], false, NOW);
    expect(known.kept.get('z')?.baseline).toBe(false);
  });

  it('doesn’t read an older Whombat’s first list: each list is kept again once', () => {
    const step = baselineStep([row(FIRST_LIST), row('a')], seen('proxy', 'a', 'b'), [proxies], true, NOW);
    expect(step.kept.get('b')?.baseline).toBe(true);
    expect(step.forget).not.toContain(FIRST_LIST);
  });

  it('marks what opens after the first list as new, and forgets what closed a month ago', () => {
    const old = new Date(NOW.getTime() - FORGET_AFTER_MS - 1);
    const step = baselineStep(
      [...listed('proxy'), row('a'), row('gone', { lastSeen: old })],
      seen('proxy', 'a', 'c'),
      [proxies],
      true,
      NOW,
    );
    expect(step.kept.get('c')).toEqual({ firstSeen: NOW, baseline: false });
    expect(step.kept.get('a')?.baseline).toBe(true);
    expect(step.forget).toEqual(['gone']);
    // Back within a month: not new.
    const back = baselineStep(
      [...listed('proxy'), row('a', { lastSeen: new Date(NOW.getTime() - 3 * 86_400_000) })],
      seen('proxy', 'a'),
      [proxies],
      true,
      NOW,
    );
    expect(back.kept.get('a')?.baseline).toBe(true);
  });

  it('forgets nothing after a read that missed a list, and leaves a new opening’s line as it is', () => {
    const old = new Date(NOW.getTime() - FORGET_AFTER_MS - 1);
    const fresh = row('new-there', { firstSeen: new Date(NOW.getTime() - 86_400_000), baseline: false });
    const stored = [...listed('proxy', 'tunnel:1'), row('a'), row('quiet', { lastSeen: old }), fresh];
    const partial = baselineStep(stored, seen('proxy', 'a'), [proxies], false, NOW);
    expect(partial.forget).toEqual([]);
    expect(partial.unsure).toBe(true);
    // Read whole, what isn't there is closed: no doubt, and what closed a month ago goes.
    const whole = baselineStep(stored, seen('proxy', 'a'), [proxies], true, NOW);
    expect(whole.unsure).toBe(false);
    expect(whole.forget).toEqual(['quiet']);
    // Nothing new missing: nothing to hold.
    expect(
      baselineStep(
        stored.filter((r) => r !== fresh),
        seen('proxy', 'a'),
        [proxies],
        false,
        NOW,
      ).unsure,
    ).toBe(false);
  });

  it('writes what stays open at most once an hour', () => {
    const recent = baselineStep(
      [
        row(firstListOf('proxy'), { lastSeen: new Date(NOW.getTime() - 60_000) }),
        row('a', { lastSeen: new Date(NOW.getTime() - 60_000) }),
      ],
      seen('proxy', 'a'),
      [proxies],
      true,
      NOW,
    );
    expect(recent.write).toEqual([]);
  });
});

describe('Something new is open to the internet', () => {
  it('starts on, is the person’s, one item each, and is listed by the places that open things', async () => {
    expect(checkStartsOn(EXPOSURE_NEW_CHECK)).toBe(true);
    expect(EXPOSURE_NEW).toMatchObject({ nature: 'you', perItem: true });
    const { KIND_MODULES } = await import('../things/kinds/index');
    for (const kind of ['nginx_proxy_manager', 'cloudflare', 'opnsense', 'unifi_network'])
      expect(KIND_MODULES[kind]?.checks?.some((c) => c.check === EXPOSURE_NEW_CHECK)).toBe(true);
  });

  it('says what is open and what it leads to, with the list one press away', () => {
    const o = raw({ how: 'port_forward', address: '32400', port: 32400 });
    const n = newOpeningNotice('con_u', o, { thing: 'server:media-01', name: 'media-01', href: '/x' });
    expect(n).toMatchObject({
      tone: 'warn',
      nature: 'you',
      check: EXPOSURE_NEW_CHECK,
      subject: { id: `open:${openingId('con_u', o)}`, name: '32400' },
      link: { kind: 'href', href: '/internet' },
      ignore: { lifts: 'fixed' },
    });
    expect(n.title).toContain('Port 32400');
    expect(n.detail).toContain('media-01');
    expect((n.badge ?? '').length).toBeLessThanOrEqual(40);
    // Written in English, said in Dutch on the way out.
    expect(localizePhrase(n.title, 'nl-NL')).toContain('vanaf internet');
    expect(localizePhrase(n.detail ?? '', 'nl-NL')).toContain('media-01');
    expect(localizePhrase(n.detail ?? '', 'nl-NL')).not.toBe(n.detail);
    expect(localizePhrase('See what’s open', 'nl-NL', { button: true })).not.toBe('See what’s open');
    // A port forward's line says “Port” in Dutch too, keeping the number.
    const port = newOpeningNotice('con_unifi', raw({ how: 'port_forward', address: '32400' }), null);
    expect(localizePhrase(port.title, 'nl-NL')).toMatch(/^Poort 32400 /);
    expect(localizePhrase(port.badge ?? '', 'nl-NL')).toContain('poort 32400');
  });

  it('raises a line only for what is new, once per opening', () => {
    const a = raw({ address: 'a.example.com' });
    const b = raw({ address: 'b.example.com' });
    const kept = new Map([
      [openingId('con_npm', a), { firstSeen: NOW, baseline: true }],
      [openingId('con_npm', b), { firstSeen: NOW, baseline: false }],
    ]);
    expect(newOpeningNotices('con_npm', [a, b, b], kept, NO_LINKS, NOW).map((n) => n.subject?.name)).toEqual([
      'b.example.com',
    ]);
  });
});
