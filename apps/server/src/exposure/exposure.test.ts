/**
 * Open to the internet (docs/decisions/internet-exposure.md): what each place's settings say is open, the words,
 * links and highlights of an opening, the silent first list and the line of a new opening. Pure.
 */
import { EXPOSURE_NEW_CHECK, ExposureOpening, isPublicName } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { localizePhrase } from '../i18n/phrases';
import { NPM_PROXY_HOSTS, NPM_STREAMS } from '../things/kinds/infra/fixtures/nginx-proxy-manager';
import { type NpmSnapshot, parseProxyHosts, parseStreams } from '../things/kinds/infra/nginx-proxy-manager';
import { checkStartsOn } from '../things/quiet/defaults';
import '../things/kinds/index';
import { baselineStep, FIRST_LIST, FORGET_AFTER_MS, type KeptRow } from './baseline';
import { EXPOSURE_NEW } from './check';
import { newOpeningNotice, newOpeningNotices } from './lines';
import {
  buildOpening,
  type Links,
  linkOf,
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
import { unifiLegacyBase } from './read';
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

  it('guards names with Cloudflare Access when an app covers them', () => {
    const domains = parseAccessDomains({
      result: [
        { type: 'self_hosted', domain: 'pve.example.com' },
        { type: 'self_hosted', domain: 'x.example.com/admin' },
        { type: 'self_hosted', destinations: [{ type: 'public', uri: '*.apps.example.com' }] },
        { type: 'bookmark', domain: 'ha.example.com' },
      ],
    });
    expect(accessGuards(domains, 'pve.example.com')).toBe(true);
    expect(accessGuards(domains, 'x.example.com')).toBe(false);
    expect(accessGuards(domains, 'a.apps.example.com')).toBe(true);
    expect(accessGuards(domains, 'ha.example.com')).toBe(false);
    const routes = parseTunnelConfig(config) ?? [];
    expect(tunnelOpenings('home', routes, domains).map((o) => [o.address, o.guard])).toEqual([
      ['ha.example.com', 'none'],
      ['pve.example.com', 'cloudflare_access'],
    ]);
    expect(tunnelOpenings('home', routes, null)[0]?.guard).toBe('unknown');
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
    expect(rows.map((o) => [o.address, o.target, o.guard, o.label])).toEqual([
      ['32400', '10.100.0.40:32400', 'none', 'Plex'],
      ['3389', '10.100.0.50:3389', 'some_addresses', undefined],
    ]);
    expect(opnsenseUpnp([{ id: 'miniupnpd', running: true }])).toBe(true);
    expect(opnsenseUpnp([{ id: 'unbound', running: true }])).toBe(false);
    expect(opnsenseUpnp(null)).toBeNull();
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
      { ok: true, value: { openings: [], complete: true, blind: [{ code: 'upnp_on' }] } },
      2,
      'en-GB',
    );
    expect(upnp.state).toBe('partly');
    expect(upnp.words).toMatch(/^2 openings\. UPnP/);
    const ts = { id: 'con_t', label: 'Tailscale', catalogId: 'tailscale' };
    expect(
      sourceOf(ts, { ok: true, value: { openings: [], complete: true, blind: [] } }, 0, 'en-GB'),
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

  it('keeps the first full read silently', () => {
    const step = baselineStep([], ['a', 'b'], true, NOW);
    expect(step.write.map((r) => [r.openingId, r.baseline])).toEqual([
      ['a', true],
      ['b', true],
      [FIRST_LIST, true],
    ]);
    expect([...step.kept.values()].every((k) => k.baseline)).toBe(true);
  });

  it('keeps adding silently while reads are partial', () => {
    const step = baselineStep([row('a')], ['a', 'b'], false, NOW);
    expect(step.write.find((r) => r.openingId === 'b')?.baseline).toBe(true);
    expect(step.write.some((r) => r.openingId === FIRST_LIST)).toBe(false);
  });

  it('marks what opens after the first list as new, and forgets what closed a month ago', () => {
    const old = new Date(NOW.getTime() - FORGET_AFTER_MS - 1);
    const step = baselineStep(
      [row(FIRST_LIST), row('a'), row('gone', { lastSeen: old })],
      ['a', 'c'],
      true,
      NOW,
    );
    expect(step.kept.get('c')).toEqual({ firstSeen: NOW, baseline: false });
    expect(step.kept.get('a')?.baseline).toBe(true);
    expect(step.forget).toEqual(['gone']);
    // Back within a month: not new.
    const back = baselineStep(
      [row(FIRST_LIST), row('a', { lastSeen: new Date(NOW.getTime() - 3 * 86_400_000) })],
      ['a'],
      true,
      NOW,
    );
    expect(back.kept.get('a')?.baseline).toBe(true);
  });

  it('writes what stays open at most once an hour', () => {
    const recent = baselineStep(
      [row(FIRST_LIST), row('a', { lastSeen: new Date(NOW.getTime() - 60_000) })],
      ['a'],
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
      [openingId('con_npm', a), { baseline: true }],
      [openingId('con_npm', b), { baseline: false }],
    ]);
    expect(newOpeningNotices('con_npm', [a, b, b], kept, NO_LINKS).map((n) => n.subject?.name)).toEqual([
      'b.example.com',
    ]);
  });
});
